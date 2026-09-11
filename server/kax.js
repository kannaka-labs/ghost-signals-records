'use strict';
// KAX City, as the studio's own agent: enter the floor, speak in it, write
// the wall. The NPC is a real principal in the city, not a service account.
const { request } = require('./suno');

class Kax {
  constructor({ base, agentToken, towerCredential, storey, userAgent }) {
    this.base = base.replace(/\/+$/, '');
    this.token = agentToken;
    this.towerCredential = towerCredential || '';
    this.storey = storey;
    this.ua = userAgent;
    this.room = storey ? `tower:${storey}` : '';
  }

  /** The floor credential is pinned to this storey and does the floor's own
   *  work; the agent token is the city presence. Prefer the narrower one. */
  headers(which = 'agent') {
    const token = which === 'tower' ? (this.towerCredential || this.token) : this.token;
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.ua, accept: 'application/json' };
  }

  canSpeak() { return Boolean(this.token && this.room); }
  canWriteFloor() { return Boolean((this.towerCredential || this.token) && this.storey); }

  async post(path, body, which = 'agent') {
    const r = await request('POST', `${this.base}${path}`, { headers: this.headers(which), body: JSON.stringify(body), timeoutMs: 30000 });
    let j = null; try { j = JSON.parse(r.body.toString('utf8')); } catch { /* not json */ }
    return { status: r.status, json: j };
  }

  enter() { return this.post('/city/enter', { room: this.room }); }
  leave() { return this.post('/city/leave', { room: this.room }); }

  /** Say one line in the floor's room. Enters first if the city says we are
   *  not there. Lines are capped; the city has its own cap too. Speaking
   *  needs the agent token: a floor credential cannot open a mouth. */
  async say(text) {
    if (!this.token) return { status: 0, json: { error: 'no agent token; the studio cannot speak in the room' } };
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 480);
    let r = await this.post('/city/say', { room: this.room, text: line });
    if (r.status === 403 || r.status === 409) { await this.enter(); r = await this.post('/city/say', { room: this.room, text: line }); }
    return r;
  }

  /** The wall: headline, up to six lines, one image from an allowlisted host. */
  panel({ headline, lines, assetUrl, ctaRoomId }) {
    const body = { headline: String(headline || '').slice(0, 80), lines: (lines || []).slice(0, 6).map((l) => String(l).slice(0, 140)) };
    if (assetUrl) body.assetUrl = assetUrl;
    if (ctaRoomId) body.ctaRoomId = ctaRoomId;
    return this.post(`/tower/storey/${this.storey}/panel`, body, 'tower');
  }

  /** Register (or replace) the floor's webhook receiver. The tower answers
   *  with the signing secret ONCE; it becomes TOWER_WEBHOOK_SECRET. */
  registerWebhook(url) {
    return this.post(`/tower/storey/${this.storey}/webhook`, { url }, 'tower');
  }
}

module.exports = { Kax };
