'use strict';
// The USDC ATM: a CDP-signed JWT, a session token from a fake Coinbase, a
// hosted URL with the prefill, and the honest state when no key is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-atm-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm';
process.env.GSR_USDC_PAY_TO = '0x571D2C659bD01688e2d7AA1c9658445a1dA9c2CD';
process.env.GSR_DOWNLOAD_SECRET = 'test-secret';
process.env.GSR_FFMPEG = '';
process.env.GSR_USDC_SCAN_MS = '3600000';
process.env.GSR_BASE_RPC_URLS = 'http://127.0.0.1:9/';
process.env.GSR_CDP_PROJECT_ID = '18e14bff-edad-49ef-9d5f-3b4c7d21af1e';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const EC_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const ed = crypto.generateKeyPairSync('ed25519');
const ED_SEED = ed.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
const ED_B64 = Buffer.concat([ED_SEED, ed.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]).toString('base64');

const { Atm, cdpJwt, onrampUrl, AMOUNTS } = require('../server/atm');

function decode(jwt) {
  const [h, c, s] = jwt.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')), sig: Buffer.from(s, 'base64url'), input: `${h}.${c}` };
}

test('cdpJwt: ES256 over a PEM key, bound to one request, two minutes, verifiable', () => {
  const jwt = cdpJwt({ keyId: 'organizations/o/apiKeys/k', secret: EC_PEM, method: 'POST', host: 'api.developer.coinbase.com', path: '/onramp/v1/token', nowSec: 1700000000 });
  const d = decode(jwt);
  assert.equal(d.header.alg, 'ES256');
  assert.equal(d.header.kid, 'organizations/o/apiKeys/k');
  assert.match(d.header.nonce, /^[0-9a-f]{32}$/);
  assert.equal(d.claims.sub, 'organizations/o/apiKeys/k');
  assert.equal(d.claims.iss, 'cdp');
  assert.deepEqual(d.claims.aud, ['cdp_service'], 'the audience the CDP SDK sends; without it the token endpoint answers 401');
  assert.equal(d.claims.exp - d.claims.nbf, 120);
  assert.equal(d.claims.uri, 'POST api.developer.coinbase.com/onramp/v1/token');
  assert.deepEqual(d.claims.uris, [d.claims.uri]);
  assert.equal(crypto.verify('sha256', Buffer.from(d.input), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, d.sig), true);
  assert.equal(crypto.verify('sha256', Buffer.from(d.input + 'x'), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, d.sig), false);
});

test('cdpJwt: EdDSA over the base64 Ed25519 form', () => {
  const jwt = cdpJwt({ keyId: 'k2', secret: ED_B64, method: 'POST', host: 'h', path: '/p' });
  const d = decode(jwt);
  assert.equal(d.header.alg, 'EdDSA');
  assert.equal(crypto.verify(null, Buffer.from(d.input), ed.publicKey, d.sig), true);
  assert.throws(() => cdpJwt({ keyId: 'k', secret: 'bm90IGEga2V5', method: 'POST', host: 'h', path: '/p' }), /Ed25519/);
  assert.throws(() => cdpJwt({ keyId: '', secret: EC_PEM, method: 'POST', host: 'h', path: '/p' }), /not configured/);
});

test('onrampUrl: the prefill the docs name', () => {
  const u = new URL(onrampUrl({ token: 'tok', amount: 20, currency: 'USD', redirectUrl: 'https://records.ninja-portal.com/atm', partnerUserRef: 'atm-1' }));
  assert.equal(u.origin + u.pathname, 'https://pay.coinbase.com/buy/select-asset');
  assert.equal(u.searchParams.get('sessionToken'), 'tok');
  assert.equal(u.searchParams.get('defaultNetwork'), 'base');
  assert.equal(u.searchParams.get('defaultAsset'), 'USDC');
  assert.equal(u.searchParams.get('presetFiatAmount'), '20');
  assert.equal(u.searchParams.get('fiatCurrency'), 'USD');
  assert.equal(u.searchParams.get('redirectUrl'), 'https://records.ninja-portal.com/atm');
  assert.equal(u.searchParams.get('partnerUserRef'), 'atm-1');
  assert.equal(u.searchParams.has('appId'), false, 'the project id is not a URL parameter');
});

test('session: the project id alone opens nothing; a secret key mints a token for the visitor address', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    if (init.headers.authorization === 'Bearer bad') return { ok: false, status: 401, json: async () => ({ message: 'unauthorized' }) };
    assert.match(init.headers.authorization, /^Bearer ey/);
    assert.deepEqual(body.addresses, [{ address: '0x1111111111111111111111111111111111111111', blockchains: ['base'] }]);
    assert.deepEqual(body.assets, ['USDC']);
    if (body.clientIp) assert.equal(body.clientIp, '203.0.113.9');
    return { ok: true, status: 200, json: async () => ({ token: 'single-use-token', channel_id: '' }) };
  };
  const bare = new Atm({ projectId: '18e14bff-edad-49ef-9d5f-3b4c7d21af1e' }, { fetch: fakeFetch });
  assert.equal(bare.onrampReady(), false);
  assert.equal(bare.config().onramp.ready, false);
  assert.equal((await bare.session({ address: '0x1111111111111111111111111111111111111111', amount: 20 })).reason, 'onramp_not_configured');
  assert.equal(calls.length, 0, 'nothing is asked of Coinbase without a key');

  const atm = new Atm({ projectId: 'p', cdpKeyId: 'k', cdpKeySecret: EC_PEM, redirectUrl: 'https://records.ninja-portal.com/atm' }, { fetch: fakeFetch });
  assert.equal(atm.onrampReady(), true);
  assert.equal((await atm.session({ address: 'nope', amount: 20 })).reason, 'bad_address');
  const r = await atm.session({ address: '0x1111111111111111111111111111111111111111', amount: 50, currency: 'USD', ip: '203.0.113.9' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('sessionToken'), 'single-use-token');
  assert.equal(u.searchParams.get('presetFiatAmount'), '50');
  assert.equal(r.amount, 50);
  const off = await atm.session({ address: '0x1111111111111111111111111111111111111111', amount: 7 });
  assert.equal(off.reason, 'bad_amount', 'an amount off the menu is refused, never turned into the default');
  assert.deepEqual(off.amounts, AMOUNTS);
  // A loopback or missing ip is not sent as the client ip.
  const r2 = await atm.session({ address: '0x1111111111111111111111111111111111111111', amount: 10, ip: '127.0.0.1' });
  assert.equal(r2.ok, true);
  assert.equal(JSON.parse(calls[calls.length - 1].init.body).clientIp, undefined);
});

test('session: a rejected key says so, and does not pretend', async () => {
  const atm = new Atm({ cdpKeyId: 'k', cdpKeySecret: EC_PEM }, { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal((await atm.session({ address: '0x1111111111111111111111111111111111111111', amount: 20 })).reason, 'onramp_rejected_key');
  const down = new Atm({ cdpKeyId: 'k', cdpKeySecret: EC_PEM }, { fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal((await down.session({ address: '0x1111111111111111111111111111111111111111', amount: 20 })).reason, 'onramp_unreachable');
});

test('swap desk: units, the 0x request carries our key and our fee, the quote is shaped for a wallet', async () => {
  const { toUnits, fromUnits, NATIVE_ETH } = require('../server/atm');
  assert.equal(toUnits('0.015', 18), '15000000000000000');
  assert.equal(toUnits('1', 8), '100000000');
  assert.equal(toUnits('0', 18), null);
  assert.equal(toUnits('1e3', 18), null);
  assert.equal(toUnits('-1', 18), null);
  assert.equal(fromUnits('4950000', 6), '4.95');
  assert.equal(fromUnits('15000000000000000', 18, 8), '0.015');
  const FEE_TO = '0xb5fc18E56d370D4Fa0736787aB737069506A0346';
  const calls = [];
  const fakeFetch = async (url, init) => {
    const u = new URL(url); calls.push({ u, init });
    assert.equal(init.headers['0x-api-key'], 'zx-key');
    assert.equal(init.headers['0x-version'], 'v2');
    assert.equal(u.searchParams.get('chainId'), '8453');
    assert.equal(u.searchParams.get('buyToken'), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(u.searchParams.get('swapFeeRecipient'), FEE_TO);
    assert.equal(u.searchParams.get('swapFeeBps'), '100');
    assert.equal(u.searchParams.get('swapFeeToken'), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    const firm = u.pathname.endsWith('/quote');
    const native = u.searchParams.get('sellToken') === NATIVE_ETH;
    return { ok: true, status: 200, json: async () => ({
      liquidityAvailable: true, buyAmount: '4950000', minBuyAmount: '4900500', totalNetworkFee: '12345',
      fees: { integratorFee: { amount: '50000', token: '0x8335', type: 'volume' } },
      ...(firm ? { transaction: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0xabcdef', value: native ? '15000000000000000' : '0', gas: '210000' }, issues: { allowance: native ? null : { actual: '0', spender: '0x0000000000001ff3684f28c67538d4d072c22734' }, balance: null } } : {}),
    }) };
  };
  const closed = new Atm({}, { fetch: fakeFetch });
  assert.equal(closed.swapReady(), false);
  assert.equal((await closed.swapQuote({ sellToken: 'ETH', sellAmount: '0.015' })).reason, 'swap_not_configured');
  const atm = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: fakeFetch });
  assert.equal(atm.swapReady(), true);
  assert.equal((await atm.swapQuote({ sellToken: 'DOGE', sellAmount: '1' })).reason, 'unknown_token');
  assert.equal((await atm.swapQuote({ sellToken: 'ETH', sellAmount: 'lots' })).reason, 'bad_amount');
  assert.equal((await atm.swapQuote({ sellToken: 'ETH', sellAmount: '0.015', firm: true })).reason, 'bad_taker', 'a firm quote needs the wallet');
  const price = await atm.swapQuote({ sellToken: 'ETH', sellAmount: '0.015' });
  assert.equal(price.ok, true, JSON.stringify(price));
  assert.equal(price.firm, false);
  assert.equal(price.buy.amount, '4.95');
  assert.equal(price.buy.minAmount, '4.9005');
  assert.equal(price.fee.amount, '0.05');
  assert.equal(price.fee.bps, 100);
  assert.equal(price.fee.recipient, FEE_TO.toLowerCase());
  assert.equal(price.transaction, undefined);
  assert.ok(calls[calls.length - 1].u.pathname.endsWith('/price'));
  const firm = await atm.swapQuote({ sellToken: 'ETH', sellAmount: '0.015', taker: '0x1111111111111111111111111111111111111111', firm: true });
  assert.equal(firm.ok, true);
  assert.ok(calls[calls.length - 1].u.pathname.endsWith('/quote'));
  assert.equal(calls[calls.length - 1].u.searchParams.get('taker'), '0x1111111111111111111111111111111111111111');
  assert.deepEqual(firm.transaction, { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0xabcdef', value: `0x${(15000000000000000n).toString(16)}`, gas: '0x33450' });
  assert.equal(firm.allowance, null, 'native ETH needs no approval');
  assert.equal(firm.balanceShort, false, '0x reported no balance issue and no balance reader was given');
  // 0x does not report a native ETH shortfall; the ATM reads the balance itself when it can.
  const empty = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: fakeFetch, ethBalance: async () => 0n });
  assert.equal((await empty.swapQuote({ sellToken: 'ETH', sellAmount: '0.015', taker: '0x1111111111111111111111111111111111111111', firm: true })).balanceShort, true, 'an empty wallet is short');
  const rich = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: fakeFetch, ethBalance: async () => '20000000000000000' });
  assert.equal((await rich.swapQuote({ sellToken: 'ETH', sellAmount: '0.015', taker: '0x1111111111111111111111111111111111111111', firm: true })).balanceShort, false);
  const unreadable = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: fakeFetch, ethBalance: async () => { throw new Error('rpc down'); } });
  assert.equal((await unreadable.swapQuote({ sellToken: 'ETH', sellAmount: '0.015', taker: '0x1111111111111111111111111111111111111111', firm: true })).ok, true, 'an unreadable balance does not block the quote');
  const erc = await atm.swapQuote({ sellToken: 'cbbtc', sellAmount: '0.001', taker: '0x1111111111111111111111111111111111111111', firm: true });
  assert.equal(erc.ok, true);
  assert.equal(erc.sell.units, '100000');
  assert.equal(erc.allowance.spender, '0x0000000000001ff3684f28c67538d4d072c22734');
  assert.equal(erc.allowance.needed, '100000');
  assert.equal(erc.transaction.value, '0x0');
  const dry = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ liquidityAvailable: false }) }) });
  assert.equal((await dry.swapQuote({ sellToken: 'ETH', sellAmount: '1' })).reason, 'no_liquidity');
  const bad = new Atm({ swapApiKey: 'zx-key', swapFeeBps: 100, feeRecipient: FEE_TO }, { fetch: async () => ({ ok: false, status: 401, json: async () => ({ reason: 'INVALID_API_KEY' }) }) });
  assert.equal((await bad.swapQuote({ sellToken: 'ETH', sellAmount: '1' })).reason, 'swap_rejected_key');
});

test('http: /atm renders, /api/atm reports the honest state, /api/atm/session answers', async (t) => {
  const { main } = require('../server/index');
  const server = await main({ atmFetch: async () => ({ ok: true, status: 200, json: async () => ({ token: 't' }) }) });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/atm`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /USDC ATM/);
  const c = await (await fetch(`${base}/api/atm`)).json();
  assert.equal(c.onramp.ready, false, 'no secret key in this test environment');
  assert.equal(c.projectId, '18e14bff-edad-49ef-9d5f-3b4c7d21af1e');
  const s = await fetch(`${base}/api/atm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '0x1111111111111111111111111111111111111111', amount: 20 }) });
  assert.equal(s.status, 503);
  assert.equal((await s.json()).reason, 'onramp_not_configured');
  // A visitor's own mistake is a 400, not a 503 that tells an agent to retry.
  const bad = await fetch(`${base}/api/atm/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 'nope', amount: 20 }) });
  assert.equal(bad.status, 503, 'with no key the leg is closed before the address is read');
  const badSwap = await fetch(`${base}/api/atm/swap?sellToken=DOGE&sellAmount=1`);
  assert.equal(badSwap.status, 503, 'with no 0x key the desk is closed before the token is read');
});

test('the visitor-caused reasons map to 400, everything else the ATM returns stays a 503', () => {
  // The config is read once at module load, so the open-leg statuses are pinned
  // here by the set the routes consult; the stranger's walk of 2026-10-09 found
  // bad_address answered as a 503, which told an agent to retry a typo.
  const { CLIENT_REASONS } = require('../server/index');
  for (const r of ['bad_address', 'bad_amount', 'bad_taker', 'unknown_token']) assert.ok(CLIENT_REASONS.has(r), r);
  for (const r of ['onramp_not_configured', 'onramp_rejected_key', 'onramp_unreachable', 'onramp_error', 'swap_not_configured', 'swap_rejected_key', 'swap_unreachable', 'swap_error']) assert.ok(!CLIENT_REASONS.has(r), r);
});
