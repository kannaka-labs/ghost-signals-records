'use strict';
// The per-IP throttle keeps one bucket per lane. Before 2026-10-09 every route
// drew from one bucket per IP, so a visitor who had priced a few swaps and
// opened a purchase got "slow down" from the onramp with no reason and no
// wait time (the stranger's walk). Each lane fills on its own, and a refusal
// says how long to wait.
const test = require('node:test');
const assert = require('node:assert/strict');
const { throttle, allow } = require('../server/index');

test('lanes are independent: emptying the onramp lane leaves checkout open', () => {
  const ip = `t-${Date.now()}-a`;
  for (let i = 0; i < 6; i++) assert.equal(throttle(ip, 6, 'onramp'), 0, `onramp call ${i + 1} allowed`);
  const wait = throttle(ip, 6, 'onramp');
  assert.ok(wait >= 1 && wait <= 10, `seventh onramp call refused with a wait in seconds (${wait})`);
  assert.equal(throttle(ip, 10, 'checkout'), 0, 'checkout is a different lane');
  assert.equal(throttle(ip, 20, 'swap'), 0, 'so is the swap desk');
});

test('a smaller lane never clamps a bigger one (the old shared-bucket defect)', () => {
  const ip = `t-${Date.now()}-b`;
  for (let i = 0; i < 15; i++) assert.equal(throttle(ip, 20, 'swap'), 0);
  // One onramp call on the same ip must not shrink the swap bucket to 6.
  assert.equal(throttle(ip, 6, 'onramp'), 0);
  for (let i = 0; i < 5; i++) assert.equal(throttle(ip, 20, 'swap'), 0, `swap call ${16 + i} still allowed`);
  assert.ok(throttle(ip, 20, 'swap') > 0, 'the 21st swap call is refused');
});

test('allow() keeps its boolean shape for older callers', () => {
  const ip = `t-${Date.now()}-c`;
  assert.equal(allow(ip, 1, 'x'), true);
  assert.equal(allow(ip, 1, 'x'), false);
});

test('http: a refusal carries retryAfterSec and a Retry-After header', async (t) => {
  const { main } = require('../server/index');
  const server = await main({});
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let last;
  for (let i = 0; i < 7; i++) {
    last = await fetch(`${base}/api/atm/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' }, body: '{}' });
  }
  assert.equal(last.status, 429);
  const body = await last.json();
  assert.equal(body.error, 'slow down');
  assert.ok(Number.isInteger(body.retryAfterSec) && body.retryAfterSec >= 1);
  assert.equal(last.headers.get('retry-after'), String(body.retryAfterSec));
  // The same visitor can still open a purchase: a different lane.
  const buy = await fetch(`${base}/api/store`, { headers: { 'x-forwarded-for': '198.51.100.77' } });
  assert.equal(buy.status, 200);
});
