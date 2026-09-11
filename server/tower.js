'use strict';
// The floor. KAX delivers `chat.said` and lease events to this receiver,
// signed with the floor's secret over the exact body. A visitor's line on the
// floor is a desk turn, and the NPC answers in the room as the studio's own
// agent. Events are idempotent by id; unknown kinds are accepted and ignored.
const crypto = require('node:crypto');
const { now } = require('./db');

function verifyTowerSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const m = String(header).match(/sha256=([0-9a-f]{64})/i);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(m[1], 'hex'); const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Is a chat line addressed to the desk? On the floor, everything said is
 *  to the room; the NPC answers lines that mention it, ask a question, or
 *  come from someone with an open conversation. */
function addressed(text, npcName, hasOpenSession) {
  const t = String(text || '').toLowerCase();
  if (t.includes(npcName.toLowerCase())) return true;
  if (/\b(album|record|ep|studio|desk|make me|i want|buy|price|how much)\b/.test(t)) return true;
  if (hasOpenSession) return true;
  return /\?\s*$/.test(t);
}

class Tower {
  constructor(cfg, db, orders, desk, kax, log = () => {}) { this.cfg = cfg; this.db = db; this.orders = orders; this.desk = desk; this.kax = kax; this.log = log; }

  enabled() { return Boolean(this.cfg.kax.webhookSecret); }

  async receive(rawBody, signatureHeader) {
    if (!this.enabled()) return { status: 503, body: 'tower webhook secret not set' };
    if (!verifyTowerSignature(rawBody, signatureHeader, this.cfg.kax.webhookSecret)) return { status: 401, body: 'bad signature' };
    let ev; try { ev = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: 'bad json' }; }
    const id = String(ev.id || ev.event_id || '');
    if (!id) return { status: 400, body: 'no event id' };
    try {
      await this.db.run('INSERT INTO events (id, kind, payload_json, received_at) VALUES (?,?,?,?)', [id, String(ev.kind || ev.type || 'unknown'), rawBody.toString('utf8').slice(0, 8000), now()]);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(e.message))) return { status: 200, body: 'duplicate' };
      throw e;
    }
    const kind = String(ev.kind || ev.type || '');
    if (kind === 'chat.said') {
      // Do not block KAX's delivery on our reply; answer after acknowledging.
      setImmediate(() => this.handleChat(ev).catch((e) => this.log(`tower chat: ${e.message}`)));
      return { status: 200, body: 'ok' };
    }
    if (/^lease\./.test(kind)) this.log(`tower: ${kind}`);
    return { status: 200, body: 'ok' };
  }

  async handleChat(ev) {
    const p = ev.payload || ev.data || ev;
    const speaker = String(p.principal || p.speaker || p.from || '');
    const text = String(p.text || p.message || '');
    if (!speaker || !text) return;
    if (this.kax && speaker === this.kax.self) return; // our own line
    const existing = await this.db.get('SELECT id FROM sessions WHERE principal=? AND origin=? ORDER BY updated_at DESC LIMIT 1', [speaker, 'tower']);
    const open = Boolean(existing);
    if (!addressed(text, this.cfg.npcName, open)) return;
    const session = await this.orders.sessionFor(speaker, 'tower');
    let reply;
    if (session.state.step === 'greet' && !open) {
      // First contact: greet, and if their line already carries a theme, take it.
      const r = await this.desk.turn(session, text, { principal: speaker, origin: 'tower' });
      reply = r.reply;
    } else {
      const r = await this.desk.turn(session, text, { principal: speaker, origin: 'tower' });
      reply = r.reply;
    }
    if (this.kax && this.kax.canSpeak()) {
      // The room caps line length; long replies go in two.
      const parts = splitForRoom(reply, 460);
      for (const part of parts) await this.kax.say(part);
    } else {
      this.log(`tower (no agent token): would say: ${reply.slice(0, 120)}`);
    }
  }
}

function splitForRoom(text, max) {
  const out = []; let cur = '';
  for (const word of String(text).split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > max) { out.push(cur.trim()); cur = word; } else cur = (cur + ' ' + word);
    if (out.length === 1 && cur.length > max) break;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 2);
}

module.exports = { Tower, verifyTowerSignature, addressed, splitForRoom };
