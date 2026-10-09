'use strict';
// What the outside stranger-buyer audit of 2026-10-09 (shejiao-daren, live
// commit e13c8e7) found, pinned so it stays fixed: an unknown id under /api/
// answered the HTML not-found page, and an anonymous purchase's gasless terms
// carried the zero address as the payer with nothing saying it was a
// placeholder. Plus the matching rule the audit asked about, written down in
// the agent guide: the watcher settles only purchases that named a wallet.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
// Its own data dir: test files run in parallel processes, and two servers on
// one sqlite file race.
process.env.GSR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-audit-'));
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_FFMPEG = '';
const core = require('../server/store-core');

test('checkAuthorization refuses the zero address as the signer', () => {
  const purchase = { state: 'awaiting', authNonce: `0x${'ab'.repeat(32)}`, authValidBefore: Math.floor(Date.now() / 1000) + 1800, amountMicro: 5000000, fromAddr: null };
  const r = core.checkAuthorization(purchase, '0x571D2C659bD01688e2d7AA1c9658445a1dA9c2CD', { from: core.ZERO_ADDRESS, signature: `0x${'ab'.repeat(65)}` });
  assert.equal(r.reason, 'bad_from');
});

test('http: unknown ids under /api answer JSON 404, the zero address is refused as a wallet, the guide says who the watcher settles', async (t) => {
  const { main } = require('../server/index');
  const server = await main({});
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, p] of [['GET', '/api/purchase/doesnotexist'], ['POST', '/api/purchase/doesnotexist/tx'], ['GET', '/api/no/such/thing'], ['POST', '/api/purchase/doesnotexist/authorize']]) {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{"hash":"0x1234"}' : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.match(r.headers.get('content-type') || '', /application\/json/, `${method} ${p} is JSON`);
    assert.deepEqual(await r.json(), { error: 'not found' });
  }
  const html = await fetch(`${base}/no/such/page`);
  assert.equal(html.status, 404);
  assert.match(html.headers.get('content-type') || '', /text\/html/, 'pages still get the page');
  const g = await (await fetch(`${base}/api/store/agent-guide`)).json();
  const guide = JSON.stringify(g);
  assert.match(guide, /a purchase opened without .{0,3}from.{0,3} is settled only by this call/);
  assert.match(guide, /The zero address itself is refused as a wallet/);
  assert.match(guide, /Unknown ids under \/api\/ answer 404/);
});

// The zero-address buy, the anonymous terms and the signer-becomes-payer rule
// are pinned with a real relayer and record in test/store-gasless.test.js.
