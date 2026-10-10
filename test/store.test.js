'use strict';
// The record store: publish an album, open a purchase, pay it on a FAKE
// chain, download the zip. The chain is a function here; nothing touches the
// network. Exactly-once: one Transfer pays for one purchase, ever.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-store-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm';
process.env.GSR_USDC_PAY_TO = '0x571D2C659bD01688e2d7AA1c9658445a1dA9c2CD';
process.env.GSR_DOWNLOAD_SECRET = 'test-secret';
process.env.GSR_FFMPEG = ''; // no previews in tests
process.env.GSR_USDC_SCAN_MS = '3600000'; // the tests call scan() themselves
process.env.GSR_BASE_RPC_URLS = 'http://127.0.0.1:9/'; // nothing listens: the real chain is never asked

const core = require('../server/store-core');
const { writeZip, listZip, crc32 } = require('../server/zip');
const { main } = require('../server/index');

const PAY_TO = '0x571d2c659bd01688e2d7aa1c9658445a1da9c2cd';
const BUYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

/** A chain in a box: a head block, and logs by block. */
function fakeChain() {
  const chain = { head: 1000, logs: [], receipts: {} };
  chain.transfer = ({ from, to = PAY_TO, micro = 5000000, token = core.USDC_BASE, block, hash, status = '0x1' }) => {
    const h = hash || `0x${(chain.logs.length + 1).toString(16).padStart(64, '0')}`;
    const log = { address: token, topics: [core.TRANSFER_TOPIC, core.addrTopic(from), core.addrTopic(to)], data: `0x${BigInt(micro).toString(16).padStart(64, '0')}`, transactionHash: h, logIndex: '0x0', blockNumber: `0x${block.toString(16)}` };
    // A reverted transaction emits no logs, as on the real chain.
    if (status === '0x1') chain.logs.push(log);
    chain.receipts[h] = { status, logs: status === '0x1' ? [log] : [], blockNumber: log.blockNumber };
    return h;
  };
  chain.rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return `0x${chain.head.toString(16)}`;
    if (method === 'eth_getTransactionReceipt') return chain.receipts[params[0]] || null;
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock, topics } = params[0];
      const lo = parseInt(fromBlock, 16); const hi = parseInt(toBlock, 16);
      return chain.logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= lo && b <= hi && l.topics[2] === topics[2]; });
    }
    throw new Error(`fake chain: ${method}`);
  };
  return chain;
}

function album(dir, n = 3) {
  fs.mkdirSync(dir, { recursive: true });
  const tracks = [];
  for (let i = 1; i <= n; i++) {
    const f = path.join(dir, `${i}.mp3`);
    fs.writeFileSync(f, Buffer.from(`ID3fake-mp3-${i}-`.repeat(500)));
    tracks.push({ title: `Song ${i}`, file: f });
  }
  const cover = path.join(dir, 'cover.png');
  fs.writeFileSync(cover, Buffer.from('89504e470d0a1a0a', 'hex'));
  const art = path.join(dir, 'Song 2 art.png');
  fs.writeFileSync(art, Buffer.from('89504e470d0a1a0a00', 'hex'));
  return { title: 'Test Record', artist: 'Kannaka', year: 2026, blurb: 'Three songs.', cover, tracks, art: [art] };
}

// Each call comes from a fresh address: the per-IP throttle is the server's
// business, not this test's (a dozen buys in two seconds would trip it).
let ipN = 0;
async function api(base, p, body, headers = {}) {
  ipN += 1;
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(ipN / 250)}.${ipN % 250}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers, raw: r };
}

test('store-core: calldata, log parsing, matching rules, tokens', () => {
  assert.equal(core.transferCalldata(PAY_TO, 5000000), `0xa9059cbb${'0'.repeat(24)}571d2c659bd01688e2d7aa1c9658445a1da9c2cd${'0'.repeat(58)}4c4b40`);
  assert.equal(core.microToUsdc(5000000), '5');
  assert.equal(core.microToUsdc(5000123), '5.000123');
  const chain = fakeChain();
  const h = chain.transfer({ from: BUYER, block: 990 });
  const t = core.parseTransferLog(chain.logs[0]);
  assert.deepEqual({ from: t.from, to: t.to, micro: t.micro, txHash: t.txHash, blockNumber: t.blockNumber }, { from: BUYER, to: PAY_TO, micro: '5000000', txHash: h, blockNumber: 990 });
  assert.equal(core.parseTransferLog({ topics: ['0xabc'], data: '0x' }), null, 'not a Transfer');
  const p = { amountMicro: 5000000, fromAddr: BUYER, fromBlock: 980 };
  const opts = { payTo: PAY_TO, headBlock: 1000, confirmations: 3 };
  assert.equal(core.matchTransfer(p, t, opts).ok, true);
  assert.equal(core.matchTransfer(p, { ...t, micro: '4999999' }, opts).reason, 'wrong_amount');
  assert.equal(core.matchTransfer(p, { ...t, to: OTHER }, opts).reason, 'wrong_recipient');
  assert.equal(core.matchTransfer(p, { ...t, from: OTHER }, opts).reason, 'wrong_sender');
  assert.equal(core.matchTransfer({ ...p, fromAddr: null }, { ...t, from: OTHER }, opts).ok, true, 'an unnamed sender may be anyone');
  assert.equal(core.matchTransfer(p, { ...t, blockNumber: 979 }, opts).reason, 'too_early');
  assert.equal(core.matchTransfer(p, { ...t, blockNumber: 999 }, opts).reason, 'unconfirmed');
  assert.equal(core.matchTransfer(p, { ...t, token: OTHER }, opts).reason, 'wrong_token');
  const tok = core.signDownload('s', 'pid', 2000);
  assert.equal(core.verifyDownload('s', 'pid', tok, 1999), true);
  assert.equal(core.verifyDownload('s', 'pid', tok, 2001), false, 'expired');
  assert.equal(core.verifyDownload('s', 'other', tok, 1999), false, 'another purchase');
  assert.equal(core.verifyDownload('x', 'pid', tok, 1999), false, 'another secret');
  assert.equal(core.slug('Memories Don\'t Die. They Interfere.'), 'memories-don-t-die-they-interfere');
});

test('zip: a stored archive with the right directory, CRCs and names', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926, 'the CRC-32 check value');
  const dir = path.join(tmp, 'zipsrc'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from('hello zip'));
  const out = path.join(tmp, 't.zip');
  const r = writeZip(out, [{ name: 'Folder/a.bin', path: path.join(dir, 'a.bin') }, { name: 'Folder/README.txt', data: Buffer.from('réad me', 'utf8') }]);
  assert.equal(r.entries, 2);
  const list = listZip(out);
  assert.deepEqual(list.map((e) => e.name), ['Folder/a.bin', 'Folder/README.txt']);
  assert.equal(list[0].crc, crc32(Buffer.from('hello zip')));
  assert.equal(list[1].size, Buffer.byteLength('réad me', 'utf8'));
  // A second opinion from an unrelated reader, when one is on this machine.
  for (const py of ['python3', 'python']) {
    try { execFileSync(py, ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('Folder/README.txt').decode()=='réad me'`, out], { stdio: 'pipe' }); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
});

test('the store end to end: publish, buy, pay on the chain, download; a transfer pays once', async (t) => {
  const server = await main();
  // Close whatever happens, or a failed assertion leaves the process running.
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Links in responses carry the site's public origin; here they point home.
  const local = (u) => { const x = new URL(u); return base + x.pathname + x.search; };
  const store = server.store;
  // The tests call scan() themselves; the timer's first tick (2 s in) could
  // otherwise land mid-test and answer a test's scan() with { scanned: 0 }.
  store.stop();
  const chain = fakeChain();
  store.rpc = chain.rpc;
  const adm = { authorization: 'Bearer adm' };

  // Catalog empty, health says catalog-only until something is published.
  assert.deepEqual((await api(base, '/api/store')).json.releases, []);
  assert.equal((await api(base, '/api/health')).json.store.selling, true);

  // Publish.
  const m = album(path.join(tmp, 'src'));
  assert.equal((await api(base, '/admin/releases', m)).status, 401, 'admin only');
  const pub = await api(base, '/admin/releases', m, adm);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.sku, 'test-record');
  assert.equal(pub.json.tracks.length, 3);
  const zipList = listZip(path.join(tmp, 'releases', 'test-record', 'test-record.zip'));
  assert.deepEqual(zipList.map((e) => e.name), ['Kannaka - Test Record/01 - Song 1.mp3', 'Kannaka - Test Record/02 - Song 2.mp3', 'Kannaka - Test Record/03 - Song 3.mp3', 'Kannaka - Test Record/cover.png', 'Kannaka - Test Record/art/Song 2 art.png', 'Kannaka - Test Record/README.txt']);
  const cat = await api(base, '/api/store');
  assert.equal(cat.json.releases[0].price, '5');
  assert.equal(cat.json.releases[0].cover, '/store/test-record/cover.png');
  assert.equal((await api(base, '/store/test-record/cover.png')).status, 200);
  assert.equal((await api(base, '/store/test-record')).status, 200);
  assert.match((await api(base, '/store')).text, /record store/);

  // Open a purchase from a named wallet: 402 with the terms.
  const buy = await api(base, '/api/store/test-record/buy', { from: BUYER, email: 'buyer@example.org' });
  assert.equal(buy.status, 402);
  assert.equal(buy.json.payment.payTo, PAY_TO);
  assert.equal(buy.json.payment.amountMicro, '5000000');
  assert.equal(buy.json.payment.calldata, core.transferCalldata(PAY_TO, 5000000));
  const pid = buy.json.purchase.publicId;
  assert.equal((await api(base, `/api/purchase/${pid}`)).json.purchase.state, 'awaiting');
  assert.equal((await api(base, `/dl/${pid}?t=x`)).status, 404, 'nothing to download before payment');

  // The watcher's first look only sets its watermark: the past holds no
  // purchases of ours, so a transfer mined before it is never scanned.
  chain.transfer({ from: BUYER, block: 990 });
  chain.head = 1001;
  let scan = await store.scan();
  assert.equal(scan.scanned, 0);
  chain.head = 1010;
  scan = await store.scan();
  assert.equal(scan.scanned, 0, 'history before the first start is not read');

  // Someone else's transfer, and the wrong amount, do not pay it.
  const strayHash = chain.transfer({ from: OTHER, block: 1011 });
  chain.transfer({ from: BUYER, micro: 4000000, block: 1012 });
  chain.head = 1020;
  scan = await store.scan();
  assert.equal(scan.scanned, 2);
  assert.equal(scan.matched, 0);
  assert.equal((await api(base, `/api/purchase/${pid}`)).json.purchase.state, 'awaiting');
  // ...but both are on the books, unexplained.
  assert.equal((await api(base, '/admin/purchases', undefined, adm)).json.unmatched.length, 2);

  // The buyer's transfer, found by the watcher: paid, download works.
  const h = chain.transfer({ from: BUYER, block: 1021 });
  chain.head = 1025;
  scan = await store.scan();
  assert.equal(scan.matched, 1);
  const paid = await api(base, `/api/purchase/${pid}`);
  assert.equal(paid.json.purchase.state, 'paid');
  assert.equal(paid.json.purchase.txHash, h);
  assert.match(paid.json.purchase.download, /\/dl\//);
  const dl = await fetch(local(paid.json.purchase.download));
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/zip');
  const zipBytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(zipBytes.length, fs.statSync(path.join(tmp, 'releases', 'test-record', 'test-record.zip')).size);
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50, 'a zip comes down');
  assert.equal((await api(base, `/dl/${pid}?t=1.${'a'.repeat(32)}`)).status, 403, 'a bad token');

  // Replay: the same transfer cannot pay a second purchase.
  const buy2 = await api(base, '/api/store/test-record/buy', { from: BUYER });
  const pid2 = buy2.json.purchase.publicId;
  const claim = await api(base, `/api/purchase/${pid2}/tx`, { hash: h });
  assert.equal(claim.status, 409);
  assert.equal(claim.json.reason, 'transfer_already_used');
  // The watcher does not re-pay it either.
  chain.head = 1030;
  scan = await store.scan();
  assert.equal(scan.matched, 0);
  assert.equal((await api(base, `/api/purchase/${pid2}`)).json.purchase.state, 'awaiting');

  // A buyer who named no wallet pays from an exchange and hands us the hash.
  const buy3 = await api(base, '/api/store/test-record/buy', {});
  const pid3 = buy3.json.purchase.publicId;
  const h3 = chain.transfer({ from: OTHER, block: 1031 });
  chain.head = 1032;
  let c3 = await api(base, `/api/purchase/${pid3}/tx`, { hash: h3 });
  assert.equal(c3.json.reason, 'unconfirmed');
  chain.head = 1040;
  c3 = await api(base, `/api/purchase/${pid3}/tx`, { hash: h3 });
  assert.equal(c3.status, 200, c3.text);
  assert.equal(c3.json.purchase.state, 'paid');
  // The two strays are still unexplained: different transfers.
  assert.equal((await api(base, '/admin/purchases', undefined, adm)).json.unmatched.length, 2);
  // The watcher now reaches h3 too; it is already used, so nothing changes.
  scan = await store.scan();
  assert.equal(scan.matched, 0);

  // A stray the watcher filed first is attached to the purchase that claims
  // it, once: the exchange paid before the buyer opened the page.
  const buy4 = await api(base, '/api/store/test-record/buy', {});
  const c4 = await api(base, `/api/purchase/${buy4.json.purchase.publicId}/tx`, { hash: strayHash });
  assert.equal(c4.status, 200, c4.text);
  assert.equal(c4.json.purchase.state, 'paid');
  assert.equal((await api(base, '/admin/purchases', undefined, adm)).json.unmatched.length, 1, 'the stray is explained now');
  const buy5 = await api(base, '/api/store/test-record/buy', {});
  assert.equal((await api(base, `/api/purchase/${buy5.json.purchase.publicId}/tx`, { hash: strayHash })).json.reason, 'transfer_already_used', 'and only once');
  // A transfer older than the purchase is never its payment.
  const old = { ...core.parseTransferLog(chain.logs[0]), blockNumber: 900 };
  assert.equal(core.matchTransfer({ amountMicro: 5000000, fromAddr: null, fromBlock: 1000 }, old, { payTo: PAY_TO, headBlock: 1040, confirmations: 3 }).reason, 'too_early');

  // Failed and pending transactions.
  const hf = chain.transfer({ from: BUYER, block: 1041, status: '0x0' });
  assert.equal((await api(base, `/api/purchase/${pid2}/tx`, { hash: hf })).json.reason, 'tx_failed');
  assert.equal((await api(base, `/api/purchase/${pid2}/tx`, { hash: `0x${'f'.repeat(64)}` })).json.reason, 'pending');
  assert.equal((await api(base, `/api/purchase/${pid2}/tx`, { hash: 'nope' })).json.reason, 'bad_hash');

  // The operator can give one away.
  const list = (await api(base, '/admin/purchases', undefined, adm)).json.purchases;
  const p2 = list.find((p) => p.publicId === pid2);
  assert.equal((await api(base, `/admin/purchases/${p2.id}/comp`, {}, adm)).json.ok, true);
  assert.equal((await api(base, `/api/purchase/${pid2}`)).json.purchase.state, 'paid');

  // Unpublish hides it from the shelves but a buyer's page still works.
  assert.equal((await api(base, '/admin/releases/test-record/unpublish', {}, adm)).json.ok, true);
  assert.deepEqual((await api(base, '/api/store')).json.releases, []);
  assert.equal((await api(base, `/p/${pid}`)).status, 200);
  const again = await fetch(local((await api(base, `/api/purchase/${pid}`)).json.purchase.download));
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});
