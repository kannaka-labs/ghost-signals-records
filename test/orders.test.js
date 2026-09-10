'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Db } = require('../server/db');
const { Orders } = require('../server/orders');
const { Stripe } = require('../server/stripe');
const { Tower, verifyTowerSignature, addressed, splitForRoom } = require('../server/tower');
const { Desk } = require('../server/desk');

const CFG = {
  prices: { ep: 1900, album: 3900, double: 6900 }, currency: 'usd', publicUrl: 'https://records.test', npcName: 'Vesper',
  stripe: { secretKey: 'sk_test', webhookSecret: 'whsec_test' }, brain: { base: 'https://x', key: '', model: 'm', timeoutMs: 100 },
  kax: { webhookSecret: 'twr_secret', agentToken: '', storey: 0 },
};
const BRIEF = { theme: 'a long drive home after a funeral', style: 'night-drive synthwave, analog arpeggios', tier: 'ep', albumTitle: 'The Long Way', trackTitles: ['One', 'Two', 'Three', 'Four'], artDirection: '' };

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-'));
  const db = await new Db(path.join(dir, 'r.sqlite')).open();
  return { db, orders: new Orders(db, CFG), dir };
}

function signed(body, secret, t = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(body));
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return { raw, header: `t=${t},v1=${v1}` };
}

test('an order is created quoted with its tracks, and paid exactly once', async () => {
  const { db, orders } = await fresh();
  const o = await orders.createFromBrief(BRIEF, { origin: 'web', email: 'a@b.c' });
  assert.equal(o.state, 'quoted');
  assert.equal(o.priceCents, 1900);
  assert.equal((await orders.tracks(o.id)).length, 4);
  const r1 = await orders.markPaid(o, { amountCents: 1900, currency: 'usd', sessionId: 'cs', paymentIntent: 'pi', eventId: 'e1' });
  assert.deepEqual(r1, { ok: true, already: false });
  const o2 = await orders.get(o.id);
  assert.equal(o2.state, 'paid');
  const r2 = await orders.markPaid(o2, { amountCents: 1900, currency: 'usd', sessionId: 'cs', paymentIntent: 'pi', eventId: 'e1' });
  assert.equal(r2.already, true);
  assert.equal((await db.all('SELECT * FROM ledger WHERE order_id=?', [o.id])).length, 1);
  await db.close();
});

test('a mismatched amount is recorded and does not pay the order', async () => {
  const { db, orders } = await fresh();
  const o = await orders.createFromBrief(BRIEF, { origin: 'web' });
  const r = await orders.markPaid(o, { amountCents: 100, currency: 'usd', eventId: 'e9' });
  assert.equal(r.ok, false);
  assert.equal((await orders.get(o.id)).state, 'quoted');
  assert.equal((await db.get('SELECT kind FROM ledger WHERE order_id=?', [o.id])).kind, 'mismatch');
  await db.close();
});

test('the stripe webhook verifies, pays, ignores, and asks for a retry when the order is unknown', async () => {
  const { db, orders } = await fresh();
  const stripe = new Stripe(CFG, orders);
  const o = await orders.createFromBrief(BRIEF, { origin: 'web' });
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', client_reference_id: o.id, payment_intent: 'pi_1', amount_total: 1900, currency: 'usd' } } };
  let s = signed(ev, 'whsec_test');
  assert.equal((await stripe.webhook(s.raw, s.header)).status, 200);
  assert.equal((await orders.get(o.id)).state, 'paid');
  assert.equal((await stripe.webhook(s.raw, s.header)).body, 'already paid');
  assert.equal((await stripe.webhook(s.raw, 't=1,v1=00')).status, 400);
  s = signed({ ...ev, id: 'evt_2', data: { object: { ...ev.data.object, client_reference_id: 'nope', payment_intent: 'pi_x' } } }, 'whsec_test');
  assert.equal((await stripe.webhook(s.raw, s.header)).status, 500, 'unknown order: make stripe retry');
  s = signed({ id: 'evt_3', type: 'charge.dispute.created', data: { object: { id: 'dp', payment_intent: 'pi_1' } } }, 'whsec_test');
  assert.equal((await stripe.webhook(s.raw, s.header)).status, 200);
  assert.ok((await orders.get(o.id)).disputedAt);
  const off = new Stripe({ ...CFG, stripe: { secretKey: '', webhookSecret: '' } }, orders);
  assert.equal((await off.webhook(s.raw, s.header)).status, 503);
  await db.close();
});

test('comp, claim, fail and requeue move under compare-and-set', async () => {
  const { db, orders } = await fresh();
  const o = await orders.createFromBrief(BRIEF, { origin: 'tower', principal: 'kax:agent:1' });
  assert.equal((await orders.comp(o, 'admin')).ok, true);
  assert.equal((await orders.comp(await orders.get(o.id), 'admin')).ok, false, 'not quoted any more');
  const claimed = await orders.claimNextBuild();
  assert.equal(claimed.id, o.id);
  assert.equal(await orders.claimNextBuild(), null, 'nothing else to claim');
  assert.equal(await orders.move(o.id, 'building', 'failed', { failed_reason: 'x' }), true);
  assert.equal(await orders.requeue(o.id), true);
  assert.equal((await orders.get(o.id)).state, 'paid');
  assert.equal(await orders.requeue(o.id), false);
  await assert.rejects(() => orders.move(o.id, 'paid', 'delivered'), /not a move/);
  await db.close();
});

test('the desk turns persist a session and create the order at the quote', async () => {
  const { db, orders } = await fresh();
  const stripe = new Stripe({ ...CFG, stripe: { secretKey: '', webhookSecret: '' } }, orders); // payments off: quote still holds the order
  const desk = new Desk(CFG, orders, stripe);
  let s = await orders.newSession('kax:agent:9', 'tower');
  const say = async (t) => { const r = await desk.turn(s, t, { principal: 'kax:agent:9', origin: 'tower' }); s = r.session; return r; };
  await say('A record about the night shift at a hospital and the drive home after.');
  await say('late-night jazz trio');
  await say('four');
  let r = await say('you choose');
  assert.equal(s.state.step, 'track_titles');
  assert.equal(s.state.proposals.trackTitles.length, 4, 'templated proposals without a brain');
  await say('keep');
  await say('skip');
  r = await say('confirm');
  assert.ok(r.order, 'an order exists at the quote');
  assert.equal(r.order.state, 'quoted');
  assert.match(r.reply, /payment is not configured/);
  const again = await orders.sessionFor('kax:agent:9', 'tower');
  assert.equal(again.orderId, r.order.id, 'the session remembers its order');
  await db.close();
});

test('tower events verify by hmac over the raw body, dedupe by id, and only address lines meant for the desk', async () => {
  const { db, orders } = await fresh();
  const stripe = new Stripe(CFG, orders);
  const desk = new Desk(CFG, orders, stripe);
  const tower = new Tower(CFG, db, orders, desk, null);
  const body = Buffer.from(JSON.stringify({ id: 'ev1', kind: 'lease.granted', payload: {} }));
  const sig = 'sha256=' + crypto.createHmac('sha256', 'twr_secret').update(body).digest('hex');
  assert.equal(verifyTowerSignature(body, sig, 'twr_secret'), true);
  assert.equal(verifyTowerSignature(Buffer.from('{}'), sig, 'twr_secret'), false);
  assert.equal((await tower.receive(body, sig)).status, 200);
  assert.equal((await tower.receive(body, sig)).body, 'duplicate');
  assert.equal((await tower.receive(body, 'sha256=00')).status, 401);
  assert.equal(addressed('nice floor', 'Vesper', false), false);
  assert.equal(addressed('vesper, make me an album', 'Vesper', false), true);
  assert.equal(addressed('how much?', 'Vesper', false), true);
  assert.equal(addressed('four', 'Vesper', true), true);
  const parts = splitForRoom('word '.repeat(200), 100);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 100));
  await db.close();
});
