'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const core = require('../server/order-core');
const npc = require('../server/npc-core');
const sc = require('../server/stripe-core');
const { TIERS } = require('../server/catalog');

const PRICES = { ep: 1900, album: 3900, double: 6900 };
const CTX = { npcName: 'Vesper', prices: PRICES };

test('order states move only along the allowed edges', () => {
  assert.equal(core.canMove('quoted', 'paid'), true);
  assert.equal(core.canMove('paid', 'building'), true);
  assert.equal(core.canMove('delivered', 'paid'), false);
  assert.equal(core.canMove('briefing', 'paid'), false);
  assert.equal(core.canMove('failed', 'building'), true);
});

test('a brief must have exactly the tier\'s number of distinct titles and no artist names', () => {
  const base = { theme: 'a long drive home after a funeral', style: 'night-drive synthwave, analog arpeggios, gated reverb drums', tier: 'ep', albumTitle: 'The Long Way', trackTitles: ['One', 'Two', 'Three', 'Four'] };
  assert.equal(core.validateBrief(base).ok, true);
  assert.match(core.validateBrief({ ...base, trackTitles: ['One', 'one', 'Two', 'Three'] }).errors[0], /exactly 4 distinct/);
  assert.match(core.validateBrief({ ...base, style: 'like Daft Punk but sadder' }).errors[0], /artist or band/);
  assert.match(core.validateBrief({ ...base, style: 'Radiohead Kid A era electronics' }).errors[0], /artist or band/);
  assert.equal(core.validateBrief({ ...base, style: 'Heavy bass with lofi warmth' }).ok, true, 'a capitalised genre opener is fine');
  assert.equal(core.validateBrief({ ...base, tier: 'triple' }).ok, false);
  assert.equal(core.priceCentsFor('album', PRICES), 3900);
  assert.equal(core.checkoutIdempotencyKey('o1', 2), 'gsr_checkout:o1:2');
  assert.equal(core.newPublicId(crypto.randomBytes).length, 22);
});

test('the desk walks a visitor from a theme to a quote with templated proposals', () => {
  let s = npc.fresh();
  let r = npc.advance(s, 'A record about leaving a small town and the friends who stayed.', CTX);
  assert.equal(r.state.step, 'style');
  r = npc.advance(r.state, 'like Bruce Springsteen', CTX);
  assert.equal(r.state.step, 'style', 'an artist name is refused');
  assert.match(r.reply, /refuse/);
  r = npc.advance(r.state, 'acoustic folk with strings', CTX);
  assert.equal(r.state.step, 'size');
  assert.match(r.state.brief.style, /fingerpicked/);
  r = npc.advance(r.state, 'four', CTX);
  assert.equal(r.state.step, 'album_title');
  assert.equal(r.needs, 'propose_album_titles');
  r.state.proposals.albumTitles = ['Stayed', 'Leaving Light', 'The Last Bus'];
  r = npc.advance(r.state, 'the second', CTX);
  assert.equal(r.state.brief.albumTitle, 'Leaving Light');
  assert.equal(r.needs, 'propose_track_titles');
  r.state.proposals.trackTitles = ['A', 'B', 'C', 'D'];
  r = npc.advance(r.state, 'keep', CTX);
  assert.deepEqual(r.state.brief.trackTitles, ['A', 'B', 'C', 'D']);
  assert.equal(r.state.step, 'art');
  r = npc.advance(r.state, '2', CTX);
  assert.equal(r.state.step, 'confirm');
  assert.match(r.reply, /\$19/);
  r = npc.advance(r.state, 'change the title', CTX);
  assert.equal(r.state.step, 'album_title');
  r = npc.advance(r.state, '"Small Town Signal"', CTX);
  assert.equal(r.state.brief.albumTitle, 'Small Town Signal');
  r.state.proposals.trackTitles = ['A', 'B', 'C', 'D'];
  r = npc.advance(r.state, 'keep', CTX);
  r = npc.advance(r.state, 'skip', CTX);
  r = npc.advance(r.state, 'confirm', CTX);
  assert.equal(r.state.step, 'checkout');
  assert.equal(r.needs, 'quote');
  assert.equal(core.validateBrief(r.state.brief).ok, true);
});

test('titles parse from lines, semicolons, commas and numbering', () => {
  assert.deepEqual(npc.parseTitles('1. Alpha\n2) "Beta"\n- Gamma'), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(npc.parseTitles('Alpha; Beta; Gamma'), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(npc.parseTitles('Alpha, Beta, Gamma'), ['Alpha', 'Beta', 'Gamma']);
  const s = { ...npc.fresh(), step: 'track_titles', brief: { ...npc.fresh().brief, tier: 'ep' } };
  const r = npc.advance(s, 'Alpha, Beta, Gamma', CTX);
  assert.match(r.reply, /I count 3; I need exactly 4/);
});

test('stripe signatures verify over the raw body and reject stale or wrong ones', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
  const t = 1700000000;
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  assert.equal(sc.verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, t + 10), true);
  assert.equal(sc.verifyStripeSignature(body, `t=${t},v1=${v1}`, secret, t + 1000), false, 'stale');
  assert.equal(sc.verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)}`, secret, t), false);
  assert.equal(sc.verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${v1}`, secret, t), true, 'rotation');
  assert.equal(sc.verifyStripeSignature(Buffer.from('{"x":1}'), `t=${t},v1=${v1}`, secret, t), false);
});

test('events classify to paid, refunded, disputed or ignore', () => {
  const paid = sc.classifyWebhookEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', client_reference_id: 'o1', payment_intent: 'pi_1', amount_total: 3900, currency: 'usd' } } });
  assert.deepEqual(paid, { kind: 'paid', orderId: 'o1', sessionId: 'cs_1', paymentIntent: 'pi_1', amountCents: 3900, currency: 'usd' });
  assert.equal(sc.classifyWebhookEvent({ type: 'checkout.session.completed', data: { object: { payment_status: 'unpaid' } } }).kind, 'ignore');
  assert.equal(sc.classifyWebhookEvent({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_2', amount_received: 1900, currency: 'usd', metadata: { order_id: 'o2' } } } }).orderId, 'o2');
  assert.equal(sc.classifyWebhookEvent({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_1' } } }).kind, 'disputed');
});

test('checkout params encode to stripe\'s bracket form', () => {
  const p = sc.checkoutSessionParams({ orderId: 'o1', publicId: 'p1', tierLabel: 'Album', albumTitle: 'X & Y', priceCents: 3900, currency: 'usd', successUrl: 'https://s/ok', cancelUrl: 'https://s/no', nowSec: 100 });
  const enc = sc.stripeFormEncode(p);
  assert.match(enc, /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=3900/);
  assert.match(enc, /payment_method_types%5B0%5D=card/);
  assert.match(enc, /metadata%5Border_id%5D=o1/);
  assert.match(enc, /expires_at=3700/);
  assert.equal(Object.keys(TIERS).length, 3);
});
