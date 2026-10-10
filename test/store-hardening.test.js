'use strict';
// Defects found while documenting the store (2026-10-09), each pinned by
// a test that fails on the code before the fix:
//   1. the throttle keyed on the caller-controlled FIRST X-Forwarded-For entry;
//   3. /authorize answered 409 for the relayer's own failures;
//   4. the admin bearer was compared with a plain string compare.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ethers } = require('ethers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-hardening-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm-hardening';
process.env.GSR_USDC_PAY_TO = '0x571D2C659bD01688e2d7AA1c9658445a1dA9c2CD';
process.env.GSR_DOWNLOAD_SECRET = 'test-secret';
process.env.GSR_FFMPEG = '';
process.env.GSR_USDC_SCAN_MS = '3600000';
process.env.GSR_BASE_RPC_URLS = 'http://127.0.0.1:9/';

const core = require('../server/store-core');
const index = require('../server/index');

const PAY_TO = '0x571d2c659bd01688e2d7aa1c9658445a1da9c2cd';
const ADM = { authorization: 'Bearer adm-hardening' };

/** The watcher's chain and the relayer's, in one box. */
function fakeChain() {
  const chain = { head: 1000, logs: [], receipts: {}, floatWei: 10n ** 16n, failSend: false, used: new Set() };
  chain.transfer = ({ from, to = PAY_TO, micro = 5000000, block }) => {
    const h = `0x${(chain.logs.length + 1).toString(16).padStart(64, '0')}`;
    const log = { address: core.USDC_BASE, topics: [core.TRANSFER_TOPIC, core.addrTopic(from), core.addrTopic(to)], data: `0x${BigInt(micro).toString(16).padStart(64, '0')}`, transactionHash: h, logIndex: '0x0', blockNumber: `0x${block.toString(16)}` };
    chain.logs.push(log);
    chain.receipts[h] = { status: '0x1', logs: [log], blockNumber: log.blockNumber };
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
  chain.relay = {
    address: '0x9999999999999999999999999999999999999999',
    async relayerBalanceWei() { return chain.floatWei; },
    async balanceOf() { return 10n ** 9n; },
    async authorizationState(addr, nonce) { return chain.used.has(`${addr.toLowerCase()}:${nonce}`); },
    async send(a) {
      if (chain.failSend) throw new Error('execution reverted');
      chain.used.add(`${a.from.toLowerCase()}:${a.nonce}`);
      chain.head += 1;
      return chain.transfer({ from: a.from.toLowerCase(), micro: a.value, block: chain.head });
    },
  };
  return chain;
}

function album(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '1.mp3'); fs.writeFileSync(f, Buffer.from('ID3fake'.repeat(300)));
  const cover = path.join(dir, 'cover.png'); fs.writeFileSync(cover, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { title: 'Hardening Record', artist: 'Kannaka', year: 2026, cover, tracks: [{ title: 'Only Song', file: f }] };
}

// Each call names a fresh proxy-seen address (one entry, as nginx would send
// for a caller who sent none), so these tests never trip the throttle.
let ipN = 0;
async function api(base, p, body, headers = {}) {
  ipN += 1;
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.${Math.floor(ipN / 250)}.${ipN % 250}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

async function start(t, opts) {
  const server = await index.main(opts);
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// ---- 1. the throttle key -----------------------------------------------------
test('throttle: a caller cannot pick its own key with a spoofed first X-Forwarded-For entry', async (t) => {
  const { base } = await start(t, {});
  // nginx appends the peer it saw ($proxy_add_x_forwarded_for); everything
  // before it is the caller's. A fresh spoofed first entry on every call
  // must not buy a fresh bucket.
  let last;
  for (let i = 0; i < 7; i++) {
    last = await fetch(`${base}/api/atm/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i + 1}, 203.0.113.9` }, body: '{}' });
    await last.text();
  }
  assert.equal(last.status, 429, 'the seventh onramp call from one real address is refused, whatever it claims to be');
  // A different real address (the proxy's last entry) has its own bucket.
  const other = await fetch(`${base}/api/atm/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1, 203.0.113.10' }, body: '{}' });
  await other.text();
  assert.notEqual(other.status, 429);
});

test('clientIp: the proxy\'s last entry from loopback; the socket from anyone else', () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(index.clientIp(req('127.0.0.1', '6.6.6.6, 203.0.113.9')), '203.0.113.9');
  assert.equal(index.clientIp(req('::ffff:127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(index.clientIp(req('::1', ' 6.6.6.6 ,203.0.113.9 ')), '203.0.113.9');
  assert.equal(index.clientIp(req('127.0.0.1')), '127.0.0.1', 'no proxy header: the socket');
  assert.equal(index.clientIp(req('198.51.100.4', '6.6.6.6')), '198.51.100.4', 'a direct caller cannot name itself');
  assert.equal(index.clientIp(req('198.51.100.4', '6.6.6.6, 7.7.7.7')), '198.51.100.4');
});

// ---- 3. /authorize status codes -------------------------------------------------
test('authorize: the relayer\'s own failures are 503 (with Retry-After when busy or dry); the buyer\'s are 4xx', async (t) => {
  const chain = fakeChain();
  const { server, base } = await start(t, { relayChain: chain.relay });
  server.store.rpc = chain.rpc;
  assert.equal((await api(base, '/admin/releases', album(path.join(tmp, 'src-auth')), ADM)).status, 200);
  const buyer = ethers.Wallet.createRandom();
  const buy = await api(base, '/api/store/hardening-record/buy', { from: buyer.address });
  const pid = buy.json.purchase.publicId;
  const g = buy.json.payment.gasless;
  assert.equal(g.enabled, true, JSON.stringify(g));
  const sig = await buyer.signTypedData(g.typedData.domain, { TransferWithAuthorization: g.typedData.types.TransferWithAuthorization }, g.typedData.message);

  chain.floatWei = 1n;
  const dry = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: sig });
  assert.equal(dry.json.reason, 'relayer_dry');
  assert.equal(dry.status, 503, 'a dry float is ours, not the buyer\'s');
  assert.ok(Number(dry.headers.get('retry-after')) >= 1, 'and says when to come back');
  assert.ok(dry.json.purchase, 'the body keeps its shape');
  chain.floatWei = 10n ** 16n;

  chain.failSend = true;
  const failed = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: sig });
  assert.equal(failed.json.reason, 'send_failed');
  assert.equal(failed.status, 503);
  chain.failSend = false;

  const bad = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: await ethers.Wallet.createRandom().signTypedData(g.typedData.domain, { TransferWithAuthorization: g.typedData.types.TransferWithAuthorization }, g.typedData.message) });
  assert.equal(bad.json.reason, 'bad_signature');
  assert.equal(bad.status, 409, 'a bad signature is the caller\'s to fix');
  const wrong = await api(base, `/api/purchase/${pid}/authorize`, { from: ethers.Wallet.createRandom().address, signature: sig });
  assert.equal(wrong.json.reason, 'wrong_sender');
  assert.equal(wrong.status, 409);

  const ok = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: sig });
  assert.equal(ok.status, 200, ok.text);
});

// ---- 4. the admin bearer -------------------------------------------------------
test('admin: the bearer is compared in constant time over equal-length digests', async (t) => {
  const { base } = await start(t, {});
  const real = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return real(a, b); };
  t.after(() => { crypto.timingSafeEqual = real; });

  const good = await api(base, '/admin/purchases', undefined, ADM);
  assert.equal(good.status, 200);
  const sameLength = await api(base, '/admin/purchases', undefined, { authorization: 'Bearer adm-hardeninG' });
  assert.equal(sameLength.status, 401);
  const shorter = await api(base, '/admin/purchases', undefined, { authorization: 'Bearer x' });
  assert.equal(shorter.status, 401, 'a token of another length is refused, not a 500');
  const none = await api(base, '/admin/purchases');
  assert.equal(none.status, 401);
  crypto.timingSafeEqual = real;

  assert.equal(calls.length, 4, `one constant-time compare per admin request (saw ${calls.length})`);
  for (const [a, b] of calls) assert.deepEqual([a, b], [32, 32], 'both sides hashed to 32 bytes');
});
