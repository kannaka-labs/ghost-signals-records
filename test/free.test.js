'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { freeAllowed, heldLine } = require('../server/free-core');
const { Db } = require('../server/db');
const { Orders } = require('../server/orders');
const { Stripe } = require('../server/stripe');
const { Desk } = require('../server/desk');

const BASE = {
  mode: 'auto', paymentsEnabled: false, tier: 'ep', maxTier: 'album',
  credits: 800, creditsPerTrack: 10, minCredits: 100,
  grantedToday: 0, dailyLimit: 3, grantedToVisitor: 0, visitorLimit: 1,
};

test('the free door opens only while no card can be taken, and closes on every cap', () => {
  assert.equal(freeAllowed(BASE).ok, true);
  assert.equal(freeAllowed({ ...BASE, estimate: undefined }).estimate, 40, 'four tracks at ten credits');

  assert.match(freeAllowed({ ...BASE, mode: 'off' }).reason, /closed/);
  assert.match(freeAllowed({ ...BASE, paymentsEnabled: true }).reason, /payments are configured/);
  assert.equal(freeAllowed({ ...BASE, paymentsEnabled: true, mode: 'on' }).ok, true, 'mode on overrides');

  assert.match(freeAllowed({ ...BASE, tier: 'double' }).reason, /gives away up to album/);
  assert.equal(freeAllowed({ ...BASE, tier: 'double', maxTier: 'double' }).ok, true);

  assert.match(freeAllowed({ ...BASE, grantedToVisitor: 1 }).reason, /already have one/);
  assert.match(freeAllowed({ ...BASE, grantedToday: 3 }).reason, /free albums for today are gone/);

  assert.match(freeAllowed({ ...BASE, credits: null }).reason, /did not report/);
  assert.match(freeAllowed({ ...BASE, credits: 120 }).reason, /low on generator credit/, '120 - 40 < 100');
  assert.equal(freeAllowed({ ...BASE, credits: 141 }).ok, true, '141 - 40 > 100');
  assert.match(freeAllowed({ ...BASE, tier: 'album', credits: 170 }).reason, /low on generator credit/, 'eight tracks cost more');

  assert.match(heldLine('the house is low on generator credit', 'abc'), /held as abc/);
});

async function fresh(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-free-'));
  const db = await new Db(path.join(dir, 'r.sqlite')).open();
  return { db, orders: new Orders(db, cfg) };
}

const CFG = {
  prices: { ep: 1900, album: 3900, double: 6900 }, currency: 'usd', publicUrl: 'https://records.test', npcName: 'Vesper',
  stripe: { secretKey: '', webhookSecret: '' }, brain: { base: 'https://x', key: '', model: 'm', timeoutMs: 50 },
  free: { mode: 'auto', dailyLimit: 2, visitorLimit: 1, maxTier: 'album', minCredits: 100, creditsPerTrack: 10, windowHours: 24 },
};

/** Walk a visitor to the confirm, then confirm. */
async function brief(desk, orders, who, theme) {
  let s = await orders.newSession(who, 'tower');
  const say = async (t) => { const r = await desk.turn(s, t, { principal: who, origin: 'tower' }); s = r.session; return r; };
  await say(theme);
  await say('late-night jazz trio');
  await say('four');
  await say('you choose');
  await say('keep');
  await say('skip');
  return say('confirm');
}

test('a confirmed brief is built free while the door is open, and the visitor is told', async () => {
  const { db, orders } = await fresh(CFG);
  const stripe = new Stripe(CFG, orders);
  const suno = { async credits() { return 800; } };
  const desk = new Desk(CFG, orders, stripe, () => {}, suno);
  assert.equal(desk.freeDoorOpen(), true);

  const r = await brief(desk, orders, 'kax:agent:a', 'A record about the last shift at a factory that is closing.');
  assert.match(r.reply, /On the house/);
  assert.match(r.reply, /https:\/\/records\.test\/album\//);
  assert.equal(r.order.state, 'paid', 'it went straight to the floor');
  assert.ok(r.order.compedAt);
  assert.equal((await db.get('SELECT kind FROM ledger WHERE order_id=?', [r.order.id])).kind, 'free');

  // The same visitor is refused a second.
  const again = await brief(desk, orders, 'kax:agent:a', 'A second record about the same factory and what came after.');
  assert.match(again.reply, /already have one on the house/);
  assert.equal(again.order.state, 'quoted');

  // A different visitor still gets one; the third trips the daily cap.
  const b = await brief(desk, orders, 'kax:agent:b', 'A record about a night bus and the people who ride it at 3am.');
  assert.match(b.reply, /On the house/);
  const c = await brief(desk, orders, 'kax:agent:c', 'A record about a lighthouse keeper who stops writing letters home.');
  assert.match(c.reply, /free albums for today are gone/);
  await db.close();
});

test('low credits shut the door and the visitor is told plainly; the confirm line never quotes a price while it is open', async () => {
  const { db, orders } = await fresh(CFG);
  const stripe = new Stripe(CFG, orders);
  const desk = new Desk(CFG, orders, stripe, () => {}, { async credits() { return 110; } });
  const r = await brief(desk, orders, 'kax:agent:d', 'A record about a dry riverbed and the town that named itself after the water.');
  assert.match(r.reply, /low on generator credit/);
  assert.match(r.reply, /held as/);
  assert.equal(r.order.state, 'quoted');

  // Walk to the confirm and read the line: no price while the door is open.
  let s = await orders.newSession('kax:agent:e', 'tower');
  const say = async (t) => { const x = await desk.turn(s, t, { principal: 'kax:agent:e', origin: 'tower' }); s = x.session; return x; };
  await say('A record about two brothers who stop speaking for ten years.');
  await say('acoustic folk with strings');
  await say('four');
  await say('you choose');
  await say('keep');
  const atConfirm = await say('skip');
  assert.match(atConfirm.reply, /nothing to pay/);
  assert.doesNotMatch(atConfirm.reply, /\$19/);
  await db.close();
});

test('with payments configured the free door is shut and the price returns', async () => {
  const paid = { ...CFG, stripe: { secretKey: 'sk_test', webhookSecret: 'whsec_test' } };
  const { db, orders } = await fresh(paid);
  const stripe = new Stripe(paid, orders);
  const desk = new Desk(paid, orders, stripe, () => {}, { async credits() { return 800; } });
  assert.equal(desk.freeDoorOpen(), false);
  let s = await orders.newSession('kax:agent:f', 'tower');
  const say = async (t) => { const x = await desk.turn(s, t, { principal: 'kax:agent:f', origin: 'tower' }); s = x.session; return x; };
  await say('A record about a diner that never closes and the regulars who never leave.');
  await say('boom-bap hip hop');
  await say('four');
  await say('you choose');
  await say('keep');
  const atConfirm = await say('skip');
  assert.match(atConfirm.reply, /\$19/);
  await db.close();
});
