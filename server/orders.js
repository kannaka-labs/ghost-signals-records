'use strict';
// Orders and desk sessions on the database. Every state move goes through
// `move`, which refuses anything order-core does not allow, and every money
// event lands in the ledger exactly once by key.
const crypto = require('node:crypto');
const { now } = require('./db');
const core = require('./order-core');
const npc = require('./npc-core');
const { TIERS } = require('./catalog');

class Orders {
  constructor(db, cfg) { this.db = db; this.cfg = cfg; }

  // ---- sessions (the conversation) ------------------------------------
  async sessionFor(principal, origin) {
    const row = principal ? await this.db.get('SELECT * FROM sessions WHERE principal=? AND origin=? ORDER BY updated_at DESC LIMIT 1', [principal, origin]) : null;
    if (row) return { id: row.id, state: JSON.parse(row.state_json), orderId: row.order_id };
    return this.newSession(principal, origin);
  }

  async newSession(principal, origin) {
    const id = crypto.randomBytes(12).toString('base64url');
    const state = npc.fresh();
    await this.db.run('INSERT INTO sessions (id, principal, origin, state_json, order_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [id, principal || null, origin, JSON.stringify(state), null, now(), now()]);
    return { id, state, orderId: null };
  }

  async sessionById(id) {
    const row = await this.db.get('SELECT * FROM sessions WHERE id=?', [id]);
    return row ? { id: row.id, state: JSON.parse(row.state_json), orderId: row.order_id, principal: row.principal, origin: row.origin } : null;
  }

  async saveSession(id, state, orderId) {
    await this.db.run('UPDATE sessions SET state_json=?, order_id=COALESCE(?, order_id), updated_at=? WHERE id=?', [JSON.stringify(state), orderId || null, now(), id]);
  }

  // ---- orders -----------------------------------------------------------
  async createFromBrief(brief, { principal, origin, email }) {
    const v = core.validateBrief(brief);
    if (!v.ok) throw Object.assign(new Error(v.errors.join('; ')), { status: 400 });
    const id = crypto.randomUUID();
    const publicId = core.newPublicId(crypto.randomBytes);
    const price = core.priceCentsFor(v.brief.tier, this.cfg.prices);
    await this.db.run(
      'INSERT INTO orders (id, public_id, state, brief_json, tier, price_cents, currency, email, principal, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, publicId, 'quoted', JSON.stringify(v.brief), v.brief.tier, price, this.cfg.currency, email || null, principal || null, origin || 'web', now(), now()],
    );
    for (let i = 0; i < v.brief.trackTitles.length; i++) {
      await this.db.run('INSERT INTO tracks (order_id, idx, title, status, updated_at) VALUES (?,?,?,?,?)', [id, i, v.brief.trackTitles[i], 'pending', now()]);
    }
    return this.get(id);
  }

  async get(id) {
    const row = await this.db.get('SELECT * FROM orders WHERE id=?', [id]);
    return row ? hydrate(row) : null;
  }

  async getByPublicId(publicId) {
    const row = await this.db.get('SELECT * FROM orders WHERE public_id=?', [publicId]);
    return row ? hydrate(row) : null;
  }

  async getByPaymentIntent(pi) {
    const row = await this.db.get('SELECT * FROM orders WHERE stripe_payment_intent=?', [pi]);
    return row ? hydrate(row) : null;
  }

  async tracks(orderId) {
    return this.db.all('SELECT * FROM tracks WHERE order_id=? ORDER BY idx', [orderId]);
  }

  /** Move an order between states. A compare-and-set on the current state
   *  so two workers, or a webhook and a retry, cannot both win. */
  async move(id, from, to, extra = {}) {
    if (!core.canMove(from, to)) throw new Error(`order ${id}: ${from} -> ${to} is not a move`);
    const sets = ['state=?', 'updated_at=?'];
    const vals = [to, now()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v); }
    vals.push(id, from);
    const r = await this.db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id=? AND state=?`, vals);
    return r.changes === 1;
  }

  /** Record money exactly once. Returns false if the key was already there. */
  async ledger(key, orderId, kind, amountCents, currency, ref) {
    try {
      await this.db.run('INSERT INTO ledger (key, order_id, kind, amount_cents, currency, ref, created_at) VALUES (?,?,?,?,?,?,?)', [key, orderId, kind, amountCents, currency, ref || null, now()]);
      return true;
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(e.message))) return false;
      throw e;
    }
  }

  /** Paid, from a verified webhook. Idempotent: the same event twice is one
   *  ledger row and one state move; an amount that does not match the quote
   *  is recorded and refused (the operator sees it; nothing builds). */
  async markPaid(order, { amountCents, currency, sessionId, paymentIntent, eventId }) {
    if (order.state === 'paid' || order.state === 'building' || order.state === 'delivered') return { ok: true, already: true };
    if (amountCents !== order.priceCents || String(currency).toLowerCase() !== order.currency) {
      await this.ledger(`mismatch:${eventId}`, order.id, 'mismatch', amountCents, currency, paymentIntent);
      return { ok: false, reason: 'amount_mismatch' };
    }
    const fresh = await this.ledger(`paid:${order.id}`, order.id, 'paid', amountCents, currency, paymentIntent);
    const moved = await this.move(order.id, 'quoted', 'paid', { paid_at: now(), stripe_payment_intent: paymentIntent || order.stripePaymentIntent, stripe_session_id: sessionId || order.stripeSessionId });
    return { ok: true, already: !fresh && !moved };
  }

  /** The operator gives an album away. Same path as paid, zero money. */
  async comp(order, who) {
    if (order.state !== 'quoted') return { ok: false, reason: `state ${order.state}` };
    await this.ledger(`comp:${order.id}`, order.id, 'comp', 0, order.currency, who);
    const moved = await this.move(order.id, 'quoted', 'paid', { paid_at: now(), comped_at: now() });
    return { ok: moved };
  }

  async listByState(state, limit = 50) {
    return (await this.db.all('SELECT * FROM orders WHERE state=? ORDER BY updated_at ASC LIMIT ?', [state, limit])).map(hydrate);
  }

  async recent(limit = 50) {
    return (await this.db.all('SELECT * FROM orders ORDER BY updated_at DESC LIMIT ?', [limit])).map(hydrate);
  }

  /** Claim one paid order for building: paid -> building, CAS. */
  async claimNextBuild() {
    const candidates = await this.listByState('paid', 5);
    for (const o of candidates) {
      if (await this.move(o.id, 'paid', 'building', { build_started_at: now() })) return this.get(o.id);
    }
    return null;
  }

  /** An operator's retry: a failed order goes back to the paid queue. The
   *  worker resumes from the tracks already done. */
  async requeue(id) {
    const r = await this.db.run('UPDATE orders SET state=?, failed_reason=NULL, updated_at=? WHERE id=? AND state=?', ['paid', now(), id, 'failed']);
    return r.changes === 1;
  }

  async trackUpdate(orderId, idx, fields) {
    const sets = ['updated_at=?']; const vals = [now()];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
    vals.push(orderId, idx);
    await this.db.run(`UPDATE tracks SET ${sets.join(', ')} WHERE order_id=? AND idx=?`, vals);
  }
}

function hydrate(row) {
  return {
    id: row.id, publicId: row.public_id, state: row.state, brief: JSON.parse(row.brief_json), tier: row.tier, tierLabel: (TIERS[row.tier] || {}).label || row.tier,
    priceCents: row.price_cents, currency: row.currency, email: row.email, principal: row.principal, origin: row.origin,
    stripeSessionId: row.stripe_session_id, stripePaymentIntent: row.stripe_payment_intent, checkoutUrl: row.checkout_url, checkoutAttempt: row.checkout_attempt,
    paidAt: row.paid_at, compedAt: row.comped_at, refundedAt: row.refunded_at, disputedAt: row.disputed_at, buildStartedAt: row.build_started_at, deliveredAt: row.delivered_at, failedReason: row.failed_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = { Orders, hydrate };
