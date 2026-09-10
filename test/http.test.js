'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-h-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm';
const { main, allow } = require('../server/index');

async function api(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, headers: r.headers };
}

test('the server answers health, catalog, a desk conversation, the album page, the inert webhooks and admin', async () => {
  const server = await main();
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await api(base, '/api/health');
  assert.equal(h.json.payments, false);
  assert.equal(h.json.tower, false);
  const c = await api(base, '/api/catalog');
  assert.equal(c.json.tiers.length, 3);

  let r = await api(base, '/api/desk', {});
  const sid = r.json.session;
  assert.match(r.json.reply, /A&R at Ghost Signals Records/);
  const say = (text, extra = {}) => api(base, '/api/desk', { session: sid, text, ...extra });
  r = await say('A record about a lighthouse keeper who stops writing letters.');
  assert.equal(r.json.step, 'style');
  r = await say('ambient electronica');
  r = await say('eight');
  r = await say('you choose');
  r = await say('keep');
  r = await say('1');
  assert.equal(r.json.step, 'confirm');
  r = await say('confirm', { email: 'keeper@example.org' });
  assert.equal(r.json.step, 'checkout');
  assert.ok(r.json.order && r.json.order.publicId);
  assert.equal(r.json.order.priceCents, 3900);
  const pid = r.json.order.publicId;

  const page = await api(base, `/album/${pid}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ghost Signals Records/);
  const a = await api(base, `/api/album/${pid}`);
  assert.equal(a.json.state, 'quoted');
  assert.equal(a.json.tracks.length, 8);
  assert.equal((await api(base, `/album/${pid}/file/cover.png`)).status, 404, 'no files before the build');
  assert.equal((await api(base, '/album/nope-nope-nope-nope-nope')).status, 404);

  assert.equal((await api(base, '/api/suno/callback', { anything: 1 })).status, 200);
  assert.equal((await api(base, '/api/stripe/webhook', {})).status, 503);
  assert.equal((await api(base, '/api/tower/events', {})).status, 503);

  assert.equal((await api(base, '/admin/orders')).status, 401);
  const adm = await api(base, '/admin/orders', undefined, { authorization: 'Bearer adm' });
  assert.equal(adm.json.orders.length, 1);
  const comp = await api(base, `/admin/orders/${adm.json.orders[0].id}/comp`, {}, { authorization: 'Bearer adm' });
  assert.equal(comp.json.ok, true);
  assert.equal((await api(base, `/api/album/${pid}`)).json.state, 'paid');

  assert.equal(allow('1.1.1.1', 2, 60000), true);
  assert.equal(allow('1.1.1.1', 2, 60000), true);
  assert.equal(allow('1.1.1.1', 2, 60000), false);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
