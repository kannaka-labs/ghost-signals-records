'use strict';
// Checkout and the webhook, on the database. Inert without keys: checkout
// answers 503, the webhook answers 503, and the operator is told in the log.
const core = require('./stripe-core');
const ocore = require('./order-core');
const { request } = require('./suno');
const { now } = require('./db');

class Stripe {
  constructor(cfg, orders, log = () => {}) { this.cfg = cfg; this.orders = orders; this.log = log; }

  enabled() { return Boolean(this.cfg.stripe.secretKey && this.cfg.stripe.webhookSecret); }

  /** Create (or re-use) a Checkout Session for a quoted order. Returns the
   *  URL. A second call while the first session is live returns the same
   *  URL; the idempotency key is per attempt so a failed create can retry. */
  async checkout(order, { email } = {}) {
    if (!this.enabled()) throw Object.assign(new Error('payments not configured'), { status: 503 });
    if (order.state !== 'quoted') throw Object.assign(new Error(`order is ${order.state}`), { status: 409 });
    if (order.checkoutUrl) return order.checkoutUrl;
    const attempt = order.checkoutAttempt + 1;
    await this.orders.db.run('UPDATE orders SET checkout_attempt=?, updated_at=? WHERE id=?', [attempt, now(), order.id]);
    const params = core.checkoutSessionParams({
      orderId: order.id, publicId: order.publicId, tierLabel: order.tierLabel, albumTitle: order.brief.albumTitle,
      priceCents: order.priceCents, currency: order.currency,
      successUrl: `${this.cfg.publicUrl}/album/${order.publicId}?paid=1`, cancelUrl: `${this.cfg.publicUrl}/desk?order=${order.publicId}&cancelled=1`,
      customerEmail: email || order.email || undefined, nowSec: Math.floor(Date.now() / 1000),
    });
    const body = core.stripeFormEncode(params);
    const r = await request('POST', 'https://api.stripe.com/v1/checkout/sessions', {
      headers: { authorization: `Bearer ${this.cfg.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': ocore.checkoutIdempotencyKey(order.id, attempt), 'content-length': Buffer.byteLength(body) },
      body, timeoutMs: 30000,
    });
    let j; try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error(`stripe ${r.status} non-json`); }
    if (r.status !== 200 || !j.url) throw new Error(`stripe checkout ${r.status}: ${(j.error && j.error.message) || 'no url'}`);
    await this.orders.db.run('UPDATE orders SET stripe_session_id=?, checkout_url=?, updated_at=? WHERE id=?', [j.id, j.url, now(), order.id]);
    return j.url;
  }

  /** The webhook. Verify over the RAW body, classify, act, and answer 200
   *  only when the event is fully handled (or is not ours); 500 makes Stripe
   *  retry, which is what we want when our side failed. */
  async webhook(rawBody, signatureHeader) {
    if (!this.enabled()) return { status: 503, body: 'payments not configured' };
    if (!core.verifyStripeSignature(rawBody, signatureHeader, this.cfg.stripe.webhookSecret, Math.floor(Date.now() / 1000))) return { status: 400, body: 'bad signature' };
    let event; try { event = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: 'bad json' }; }
    const c = core.classifyWebhookEvent(event);
    if (c.kind === 'ignore') return { status: 200, body: 'ignored' };
    if (c.kind === 'paid') {
      const order = c.orderId ? await this.orders.get(c.orderId) : (c.paymentIntent ? await this.orders.getByPaymentIntent(c.paymentIntent) : null);
      if (!order) return { status: 500, body: 'order not found; retry' };
      const r = await this.orders.markPaid(order, { amountCents: c.amountCents, currency: c.currency, sessionId: c.sessionId, paymentIntent: c.paymentIntent, eventId: event.id });
      if (!r.ok) { this.log(`stripe: ${r.reason} for order ${order.id}`); return { status: 200, body: r.reason }; }
      return { status: 200, body: r.already ? 'already paid' : 'paid' };
    }
    if (c.kind === 'refunded' || c.kind === 'disputed') {
      const order = c.paymentIntent ? await this.orders.getByPaymentIntent(c.paymentIntent) : null;
      if (order) {
        const col = c.kind === 'refunded' ? 'refunded_at' : 'disputed_at';
        await this.orders.db.run(`UPDATE orders SET ${col}=COALESCE(${col}, ?), updated_at=? WHERE id=?`, [now(), now(), order.id]);
        await this.orders.ledger(`${c.kind}:${event.id}`, order.id, c.kind, 0, order.currency, c.paymentIntent);
        this.log(`stripe: ${c.kind} on order ${order.id}`);
      }
      return { status: 200, body: c.kind };
    }
    return { status: 200, body: 'ok' };
  }
}

module.exports = { Stripe };
