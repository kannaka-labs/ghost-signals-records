'use strict';
// Gasless checkout: the buyer signs a USDC authorization (EIP-3009) and the
// store's relayer submits it. The chain here is a function; the signature is
// real (ethers), the recovery is real, and the Transfer the fake chain emits
// settles the purchase through the same watcher as a plain transfer.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-gasless-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm';
process.env.GSR_USDC_PAY_TO = '0x571D2C659bD01688e2d7AA1c9658445a1dA9c2CD';
process.env.GSR_DOWNLOAD_SECRET = 'test-secret';
process.env.GSR_FFMPEG = '';
process.env.GSR_USDC_SCAN_MS = '3600000';
process.env.GSR_BASE_RPC_URLS = 'http://127.0.0.1:9/';
process.env.GSR_RELAY_PER_HOUR = '3';

const core = require('../server/store-core');
const { Relayer, isRevert } = require('../server/gasless');
const { main } = require('../server/index');

const PAY_TO = '0x571d2c659bd01688e2d7aa1c9658445a1da9c2cd';
const RELAYER = '0x9999999999999999999999999999999999999999';

/** The relayer's view of the chain, and the watcher's, in one box. */
function fakeChain({ usdcBalance = 10000000n, floatWei = 10n ** 16n } = {}) {
  const chain = { head: 1000, logs: [], receipts: {}, sent: [], used: new Set(), floatWei, usdcBalance, failSend: false };
  chain.transfer = ({ from, to = PAY_TO, micro = 5000000, block, hash }) => {
    const h = hash || `0x${(chain.logs.length + 1).toString(16).padStart(64, '0')}`;
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
  // What the relayer sees.
  chain.relay = {
    address: RELAYER,
    async relayerBalanceWei() { return chain.floatWei; },
    async balanceOf() { return chain.usdcBalance; },
    async authorizationState(addr, nonce) { return chain.used.has(`${addr.toLowerCase()}:${nonce}`); },
    async send(a) {
      // 'revert': USDC refused it (ethers v6 shape); anything else truthy: the
      // provider failed before the chain answered.
      if (chain.failSend === 'revert') throw Object.assign(new Error('execution reverted: FiatTokenV2: invalid signature'), { code: 'CALL_EXCEPTION', shortMessage: 'execution reverted: "FiatTokenV2: invalid signature"', reason: 'FiatTokenV2: invalid signature' });
      if (chain.failSend) throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT', shortMessage: 'request timeout' });
      chain.sent.push(a);
      chain.used.add(`${a.from.toLowerCase()}:${a.nonce}`);
      // The authorization lands in the next block as a Transfer from -> to.
      chain.head += 1;
      return chain.transfer({ from: a.from.toLowerCase(), to: a.to.toLowerCase(), micro: a.value, block: chain.head });
    },
  };
  return chain;
}

function album(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '1.mp3'); fs.writeFileSync(f, Buffer.from('ID3fake'.repeat(300)));
  const cover = path.join(dir, 'cover.png'); fs.writeFileSync(cover, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { title: 'Gasless Record', artist: 'Kannaka', year: 2026, cover, tracks: [{ title: 'Only Song', file: f }] };
}

let ipN = 0;
async function api(base, p, body, headers = {}) {
  ipN += 1;
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.${Math.floor(ipN / 250)}.${ipN % 250}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** Sign the store's typed data the way a wallet would, as `wallet`. */
async function signTerms(wallet, gasless) {
  const td = JSON.parse(JSON.stringify(gasless.typedData));
  td.message.from = wallet.address;
  return wallet.signTypedData(td.domain, { TransferWithAuthorization: td.types.TransferWithAuthorization }, td.message);
}

test('store-core: an authorization is accepted only as issued, from its signer, before its deadline', async () => {
  const w = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const p = { state: 'awaiting', amountMicro: 5000000, authNonce: `0x${'ab'.repeat(32)}`, authValidBefore: Math.floor(Date.now() / 1000) + 1800, fromAddr: null };
  const td = core.authTypedData(p, PAY_TO, w.address);
  assert.equal(td.domain.chainId, 8453);
  assert.equal(td.domain.verifyingContract.toLowerCase(), core.USDC_BASE);
  assert.equal(td.message.value, '5000000');
  const sig = await w.signTypedData(td.domain, core.AUTH_TYPES, td.message);
  const ok = core.checkAuthorization(p, PAY_TO, { from: w.address, signature: sig });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.to.toLowerCase(), PAY_TO);
  assert.equal(core.checkAuthorization(p, PAY_TO, { from: other.address, signature: sig }).reason, 'bad_signature', 'another address claiming the signature');
  assert.equal(core.checkAuthorization({ ...p, amountMicro: 4000000 }, PAY_TO, { from: w.address, signature: sig }).reason, 'bad_signature', 'the amount is in the signed message');
  assert.equal(core.checkAuthorization({ ...p, authNonce: `0x${'cd'.repeat(32)}` }, PAY_TO, { from: w.address, signature: sig }).reason, 'bad_signature', 'a different nonce');
  assert.equal(core.checkAuthorization(p, '0x2222222222222222222222222222222222222222', { from: w.address, signature: sig }).reason, 'bad_signature', 'a different recipient');
  assert.equal(core.checkAuthorization(p, PAY_TO, { from: w.address, signature: sig }, p.authValidBefore - 30).reason, 'expired', 'inside the last minute counts as expired');
  assert.equal(core.checkAuthorization({ ...p, fromAddr: other.address }, PAY_TO, { from: w.address, signature: sig }).reason, 'wrong_sender');
  assert.equal(core.checkAuthorization({ ...p, state: 'paid' }, PAY_TO, { from: w.address, signature: sig }).reason, 'not_awaiting');
  assert.equal(core.checkAuthorization({ ...p, authNonce: null }, PAY_TO, { from: w.address, signature: sig }).reason, 'no_authorization_issued');
  assert.equal(core.checkAuthorization(p, PAY_TO, { from: w.address, signature: '0x1234' }).reason, 'bad_signature');
  // v/r/s form is the same signature.
  const s = ethers.Signature.from(sig);
  assert.equal(core.checkAuthorization(p, PAY_TO, { from: w.address, v: s.v, r: s.r, s: s.s }).ok, true);
});

test('relayer: refuses when dry, when the buyer lacks USDC, when the nonce is spent; sends otherwise', async () => {
  const w = ethers.Wallet.createRandom();
  const chain = fakeChain();
  const relayer = new Relayer({ relayPerHour: 5 }, { chain: chain.relay });
  const p = { sku: 'x', publicId: 'p', state: 'awaiting', amountMicro: 5000000, authNonce: `0x${'ef'.repeat(32)}`, authValidBefore: Math.floor(Date.now() / 1000) + 1800 };
  const sig = await w.signTypedData(core.USDC_DOMAIN, core.AUTH_TYPES, core.authMessage(p, PAY_TO, w.address));
  const auth = { from: w.address, signature: sig };
  chain.floatWei = 1n;
  assert.equal((await relayer.relay(p, PAY_TO, auth)).reason, 'relayer_dry');
  assert.equal((await relayer.status()).enabled, false);
  chain.floatWei = 10n ** 16n;
  chain.usdcBalance = 4999999n;
  assert.equal((await relayer.relay(p, PAY_TO, auth)).reason, 'insufficient_usdc');
  chain.usdcBalance = 5000000n;
  const r = await relayer.relay(p, PAY_TO, auth);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].value, '5000000');
  assert.equal(chain.sent[0].to.toLowerCase(), PAY_TO);
  assert.equal((await relayer.relay(p, PAY_TO, auth)).reason, 'authorization_used', 'USDC would reject a spent nonce; we do not pay to find out');
  assert.equal(new Relayer({}, {}).enabled(), false, 'no key, no relayer');
});

test('end to end: open, sign, relay, settle, download; a second signature cannot pay twice', async (t) => {
  const chain = fakeChain();
  const server = await main({ relayChain: chain.relay });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = server.store;
  store.stop(); // the test calls scan() itself; the timer's 2 s tick could otherwise race it
  store.rpc = chain.rpc;
  const adm = { authorization: 'Bearer adm' };
  assert.equal((await api(base, '/admin/releases', album(path.join(tmp, 'src')), adm)).status, 200);
  await store.scan(); // sets the watermark

  const buyer = ethers.Wallet.createRandom();
  const buy = await api(base, '/api/store/gasless-record/buy', { from: buyer.address });
  assert.equal(buy.status, 402);
  const g = buy.json.payment.gasless;
  assert.equal(g.enabled, true, JSON.stringify(g));
  assert.equal(g.relayer, RELAYER);
  assert.equal(g.typedData.message.from.toLowerCase(), buyer.address.toLowerCase(), 'a named buyer is filled in');
  assert.equal(g.typedData.message.value, '5000000');
  assert.match(g.typedData.message.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(g.payer.toLowerCase(), buyer.address.toLowerCase());
  assert.doesNotMatch(g.note, /placeholder/);
  // What the outside audit found (2026-10-09): a purchase opened without a
  // wallet carried the zero address as if it were the payer. It is a
  // placeholder, and the terms now say so; the zero address itself is refused.
  const anon = await api(base, '/api/store/gasless-record/buy', {});
  assert.equal(anon.status, 402);
  assert.equal(anon.json.purchase.from, null);
  assert.equal(anon.json.payment.gasless.payer, null);
  assert.equal(anon.json.payment.gasless.typedData.message.from, core.ZERO_ADDRESS);
  assert.match(anon.json.payment.gasless.note, /placeholder/);
  const zero = await api(base, '/api/store/gasless-record/buy', { from: core.ZERO_ADDRESS });
  assert.equal(zero.status, 400);
  assert.equal(zero.json.error, 'bad wallet address');
  // The anonymous purchase is paid by whoever signs: the signer becomes the payer.
  const walkIn = ethers.Wallet.createRandom();
  const anonSig = await signTerms(walkIn, anon.json.payment.gasless);
  const zeroFrom = await api(base, `/api/purchase/${anon.json.purchase.publicId}/authorize`, { from: core.ZERO_ADDRESS, signature: anonSig });
  assert.equal(zeroFrom.status, 409);
  assert.equal(zeroFrom.json.reason, 'bad_from');
  assert.equal(zeroFrom.json.purchase.from, null, 'a refused attempt binds nobody as the payer');
  // A wrong wallet claiming the walk-in's signature is refused and binds nobody either.
  const impostor = await api(base, `/api/purchase/${anon.json.purchase.publicId}/authorize`, { from: ethers.Wallet.createRandom().address, signature: anonSig });
  assert.equal(impostor.json.reason, 'bad_signature');
  assert.equal(impostor.json.purchase.from, null);
  // A real signature whose send fails (a dry float) unbinds again.
  chain.floatWei = 1n;
  const dry = await api(base, `/api/purchase/${anon.json.purchase.publicId}/authorize`, { from: walkIn.address, signature: anonSig });
  assert.equal(dry.json.reason, 'relayer_dry');
  assert.equal(dry.json.purchase.from, null, 'a failed send unbinds the payer it bound');
  chain.floatWei = 10n ** 16n;
  const bound = await api(base, `/api/purchase/${anon.json.purchase.publicId}/authorize`, { from: walkIn.address, signature: anonSig });
  assert.equal(bound.status, 200, bound.text);
  assert.equal(bound.json.purchase.from.toLowerCase(), walkIn.address.toLowerCase(), 'the signer is bound as the payer');
  assert.equal(chain.sent.length, 1);
  chain.sent.length = 0;
  const pid = buy.json.purchase.publicId;
  // The same nonce comes back on a second read: the authorization is issued once.
  const again = await api(base, `/api/purchase/${pid}`);
  assert.equal(again.json.payment.gasless.typedData.message.nonce, g.typedData.message.nonce);

  // A forged signature from another key is refused before anything is sent.
  const stranger = ethers.Wallet.createRandom();
  const forged = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: await signTerms(stranger, g) });
  assert.equal(forged.status, 409);
  assert.equal(forged.json.reason, 'bad_signature');
  assert.equal(chain.sent.length, 0);

  // The real signature is relayed; the Transfer it emits settles the purchase.
  const sig = await signTerms(buyer, g);
  const ok = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: sig });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(chain.sent.length, 1);
  chain.head += 3; // confirmations
  await store.scan();
  const paid = await api(base, `/api/purchase/${pid}`);
  assert.equal(paid.json.purchase.state, 'paid');
  assert.equal(paid.json.purchase.txHash, ok.json.txHash);
  assert.equal(paid.json.payment, null);
  const dl = await fetch(base + new URL(paid.json.purchase.download).pathname + new URL(paid.json.purchase.download).search);
  assert.equal(dl.status, 200);

  // Sending the signature again is a no-op, not a second payment.
  const twice = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: sig });
  assert.equal(twice.status, 200);
  assert.equal(twice.json.already, true);
  assert.equal(chain.sent.length, 1);
});

test('end to end: a relay that fails frees the slot; a dry float turns the terms off', async (t) => {
  const chain = fakeChain();
  const server = await main({ relayChain: chain.relay });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  server.store.rpc = chain.rpc;
  await api(base, '/admin/releases', album(path.join(tmp, 'src2')), { authorization: 'Bearer adm' });
  const buyer = ethers.Wallet.createRandom();
  const buy = await api(base, '/api/store/gasless-record/buy', {});
  const pid = buy.json.purchase.publicId;
  const g = buy.json.payment.gasless;
  assert.equal(g.typedData.message.from, '0x0000000000000000000000000000000000000000', 'an unnamed buyer fills in their own address');
  chain.failSend = 'timeout';
  const failed = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: await signTerms(buyer, g) });
  assert.equal(failed.status, 503, 'a send that failed on our side is not the buyer\'s to fix');
  assert.equal(failed.json.reason, 'send_failed');
  assert.equal(failed.headers.get('retry-after'), '30', 'a 503 says when to try again');
  chain.failSend = 'revert';
  const refused = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: await signTerms(buyer, g) });
  assert.equal(refused.status, 409, 'USDC refusing the authorization is not ours to retry');
  assert.equal(refused.json.reason, 'send_reverted');
  assert.equal(refused.headers.get('retry-after'), null);
  chain.failSend = false;
  const retry = await api(base, `/api/purchase/${pid}/authorize`, { from: buyer.address, signature: await signTerms(buyer, g) });
  assert.equal(retry.status, 200, 'the slot was freed, so the buyer may try again');
  // Dry float: the terms say so and the page falls back to a plain transfer.
  chain.floatWei = 0n;
  const buy2 = await api(base, '/api/store/gasless-record/buy', {});
  assert.equal(buy2.json.payment.gasless.enabled, false);
  assert.equal(buy2.json.payment.gasless.reason, 'relayer_dry');
  assert.equal(buy2.json.payment.calldata, core.transferCalldata(PAY_TO, 5000000), 'the self-paid path is still there');
  const st = await api(base, '/admin/relayer', undefined, { authorization: 'Bearer adm' });
  assert.equal(st.json.enabled, false);
  assert.equal(st.json.address, RELAYER);
});

test('isRevert: only a revert the chain answered is the caller\'s', () => {
  assert.equal(isRevert({ code: 'CALL_EXCEPTION', reason: 'FiatTokenV2: authorization is used or canceled' }), true);
  assert.equal(isRevert({ code: 'CALL_EXCEPTION', data: '0x08c379a0' }), true);
  assert.equal(isRevert({ code: 'CALL_EXCEPTION', shortMessage: 'execution reverted (unknown custom error)' }), true);
  assert.equal(isRevert({ code: 'CALL_EXCEPTION', shortMessage: 'missing revert data', data: null }), false, 'some RPCs fail this way; it stays ours');
  assert.equal(isRevert({ code: 'TIMEOUT', shortMessage: 'request timeout' }), false);
  assert.equal(isRevert({ code: 'INSUFFICIENT_FUNDS', shortMessage: 'insufficient funds for intrinsic transaction cost' }), false, 'the relayer float is ours');
  assert.equal(isRevert(new Error('execution reverted')), false, 'no ethers code, no verdict');
});
