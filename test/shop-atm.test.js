'use strict';
// The ATM kiosk inside the shop (Nick, 2026-10-09: "put a visible ATM kiosk
// inside the /store"). The scene is WebGL and runs only in a browser, so this
// pins what a stranger reaches without one and what the module must contain:
// the kiosk is built and tappable, the card it opens exists with both legs and
// links into /atm, the plain rack carries the tile, and Vesper knows the way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');

test('shop.js builds the kiosk, raycasts it before the records, and opens the card', () => {
  const src = fs.readFileSync(path.join(PUB, 'shop.js'), 'utf8');
  assert.match(src, /function buildAtm\(/);
  assert.match(src, /buildAtm\(W\);/, 'the kiosk is built with the scene');
  assert.match(src, /raycaster\.intersectObjects\(atmMeshes, false\)\.length\) \{ openAtm\(\); return; \}/, 'a tap on the kiosk opens the card and does not fall through to the records');
  assert.match(src, /zMax - 1\.9/, 'it stands just inside the door, before the first rack (zMax - 3.6)');
  assert.match(src, /atm-tile/, 'the plain rack gets the tile');
  assert.match(src, /The USDC ATM is by the door, on your right/, 'the welcome hint says where it is');
  assert.match(src, /if \(ev\.key === 'Escape'\) \{ putBack\(\); closeAtm\(\); \}/);
});

test('store.html carries the ATM card with both legs and links into /atm', () => {
  const html = fs.readFileSync(path.join(PUB, 'store.html'), 'utf8');
  assert.match(html, /id="atm-card" hidden/);
  assert.match(html, /id="atm-close"/);
  assert.match(html, /Card in, USDC out/);
  assert.match(html, /Swap to USDC/);
  assert.match(html, /href="\/atm"/);
  assert.match(html, /href="\/atm#swap"/);
  assert.match(html, /you do not need ETH to pay/);
  const list = fs.readFileSync(path.join(PUB, 'store-list.html'), 'utf8');
  assert.match(list, /href="\/atm"/, 'the plain list points at the ATM too');
  const css = fs.readFileSync(path.join(PUB, 'store.css'), 'utf8');
  assert.match(css, /\.atm-tile-face/);
  assert.match(css, /\.atm-legs/);
});

test('Vesper knows the ATM is by the door and that no ETH is needed', () => {
  const { Vesper } = require('../server/vesper');
  const v = new Vesper({ npcName: 'Vesper', dataDir: require('node:os').tmpdir(), brain: { key: '' }, vesper: { engine: 'off' } }, { catalog: async () => [] });
  const sp = v.systemPrompt([{ title: 'Alpha Record', artist: 'Kannaka', tracks: [{ title: 'a' }], price: 5 }], null);
  assert.match(sp, /ATM stands by the door/);
  assert.match(sp, /needs no ETH/);
  const pay = v.templated('how do i pay', [], null);
  assert.match(pay, /Five USDC/);
  assert.match(pay, /no ETH/);
  assert.match(pay, /ATM is by the door/);
});

test('http: /store and /store/list serve the ATM to a browser without WebGL', async (t) => {
  const { main } = require('../server/index');
  const server = await main({});
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const shop = await (await fetch(`${base}/store`)).text();
  assert.match(shop, /id="atm-card"/);
  assert.match(shop, /The USDC ATM/);
  const list = await (await fetch(`${base}/store/list`)).text();
  assert.match(list, /href="\/atm"/);
});
