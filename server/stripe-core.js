'use strict';
// Stripe over plain HTTPS, no SDK: the signature check, event classification
// and form encoding. Pure. Ported from kannaka-radio's ad payments, which
// were built and reviewed for the same job.
const crypto = require('node:crypto');

const SIGNATURE_TOLERANCE_SEC = 300;

/** Verify `Stripe-Signature` over the RAW body. Timing-safe, accepts any of
 *  several v1 signatures (key rotation), rejects stale timestamps. */
function verifyStripeSignature(rawBody, header, secret, nowSec, toleranceSec = SIGNATURE_TOLERANCE_SEC) {
  if (!header || !secret) return false;
  const parts = Object.create(null);
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === 't') parts.t = v;
    else if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) return false;
  const t = parseInt(parts.t, 10);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(body).digest('hex');
  const exp = Buffer.from(expected, 'hex');
  for (const sig of parts.v1) {
    if (!/^[0-9a-f]{64}$/i.test(sig)) continue;
    const got = Buffer.from(sig, 'hex');
    if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) return true;
  }
  return false;
}

/** What an event means to us. `paid` when a checkout session completes paid
 *  (or a payment intent succeeds: the second settlement path, in case the
 *  first event is lost); `refunded`; `disputed`; otherwise `ignore`. */
function classifyWebhookEvent(event) {
  const type = event && event.type;
  const obj = (event && event.data && event.data.object) || {};
  if (type === 'checkout.session.completed' && obj.payment_status === 'paid') {
    return { kind: 'paid', orderId: obj.client_reference_id || (obj.metadata && obj.metadata.order_id) || null, sessionId: obj.id, paymentIntent: obj.payment_intent || null, amountCents: obj.amount_total, currency: obj.currency };
  }
  if (type === 'payment_intent.succeeded') {
    return { kind: 'paid', orderId: (obj.metadata && obj.metadata.order_id) || null, sessionId: null, paymentIntent: obj.id, amountCents: obj.amount_received, currency: obj.currency };
  }
  if (type === 'charge.refunded') return { kind: 'refunded', paymentIntent: obj.payment_intent || null };
  if (type === 'charge.dispute.created') return { kind: 'disputed', paymentIntent: obj.payment_intent || null, disputeId: obj.id };
  return { kind: 'ignore' };
}

/** application/x-www-form-urlencoded with Stripe's bracket nesting. */
function stripeFormEncode(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') out.push(stripeFormEncode(item, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      out.push(stripeFormEncode(v, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join('&');
}

/** The Checkout Session body for one order. Cards only, one line item,
 *  the order id in both client_reference_id and metadata, 60 min expiry. */
function checkoutSessionParams({ orderId, publicId, tierLabel, albumTitle, priceCents, currency, successUrl, cancelUrl, customerEmail, nowSec }) {
  const params = {
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: orderId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: priceCents,
        product_data: { name: `${tierLabel}: ${albumTitle}`, description: 'Ghost Signals Records. Built to your brief; delivered as a private album page with downloads.' },
      },
    }],
    metadata: { order_id: orderId, public_id: publicId },
    payment_intent_data: { metadata: { order_id: orderId, public_id: publicId } },
  };
  if (customerEmail) params.customer_email = customerEmail;
  if (nowSec) params.expires_at = nowSec + 60 * 60;
  return params;
}

module.exports = { SIGNATURE_TOLERANCE_SEC, verifyStripeSignature, classifyWebhookEvent, stripeFormEncode, checkoutSessionParams };
