'use strict';
// The USDC ATM: a way for a person with a card or a bank account to end up
// with USDC on Base in their own wallet, so they can buy a record (or anything
// else in KAX City). We are not a money transmitter and never hold the fiat
// or the coins: the fiat leg is Coinbase Onramp, a licensed on-ramp, opened
// with a single-use session token we mint on our side for the visitor's own
// address. Coinbase charges the buyer its own fee and pays us nothing; the
// ATM's surcharge, when it exists, lives on the swap leg (any Base token to
// USDC through a swap router with a fee recipient), which waits on its key.
//
// Coinbase's hosted Onramp URL requires `sessionToken`, minted by
// POST https://api.developer.coinbase.com/onramp/v1/token with a JWT signed
// by a CDP *Secret* API key (EC P-256 PEM or Ed25519). The token is single
// use and lives five minutes; the URL carries the prefill (network, asset,
// amount, currency, redirect, partnerUserRef).
const crypto = require('node:crypto');
const core = require('./store-core');

const TOKEN_URL = 'https://api.developer.coinbase.com/onramp/v1/token';
const PAY_URL = 'https://pay.coinbase.com/buy/select-asset';
const AMOUNTS = [10, 20, 50, 100];

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** A CDP API key secret as Node sees it: PEM (EC P-256, ES256) or the
 *  base64 64-byte Ed25519 secret (EdDSA). */
function loadKey(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  if (s.includes('-----BEGIN')) return { key: crypto.createPrivateKey(s.replace(/\\n/g, '\n')), alg: 'ES256' };
  const raw = Buffer.from(s, 'base64');
  if (raw.length !== 64 && raw.length !== 32) throw new Error('CDP key secret is neither a PEM nor a 32/64-byte Ed25519 key');
  // PKCS#8 wrapper for a raw Ed25519 seed (the first 32 bytes of the 64-byte form).
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]);
  return { key: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }), alg: 'EdDSA' };
}

/** The bearer JWT CDP expects: two minutes, bound to one request. */
function cdpJwt({ keyId, secret, method, host, path, nowSec = Math.floor(Date.now() / 1000) }) {
  const k = loadKey(secret);
  if (!k || !keyId) throw new Error('CDP API key not configured');
  const header = { alg: k.alg, kid: keyId, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const uri = `${method} ${host}${path}`;
  // The claim set Coinbase's own SDK sends (@coinbase/cdp-sdk generateJwt):
  // sub = key id, iss "cdp", aud ["cdp_service"], a two-minute window, and
  // the request bound in `uris`. `uri` (singular) is what the older SDK
  // sent; both are carried so either server-side check passes.
  const claims = { sub: keyId, iss: 'cdp', aud: ['cdp_service'], nbf: nowSec, exp: nowSec + 120, uri, uris: [uri] };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = k.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(signingInput), { key: k.key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(null, Buffer.from(signingInput), k.key);
  return `${signingInput}.${b64url(sig)}`;
}

/** The hosted URL, given a token and the visitor's choices. */
function onrampUrl({ token, amount, currency = 'USD', redirectUrl, partnerUserRef }) {
  const u = new URL(PAY_URL);
  u.searchParams.set('sessionToken', token);
  u.searchParams.set('defaultNetwork', 'base');
  u.searchParams.set('defaultAsset', 'USDC');
  u.searchParams.set('defaultExperience', 'buy');
  if (amount) u.searchParams.set('presetFiatAmount', String(amount));
  u.searchParams.set('fiatCurrency', currency);
  if (partnerUserRef) u.searchParams.set('partnerUserRef', partnerUserRef);
  if (redirectUrl) u.searchParams.set('redirectUrl', redirectUrl);
  return u.toString();
}

// ---- the swap desk: any Base token to USDC through 0x, with the ATM's cut --
const ZEROX = 'https://api.0x.org/swap/allowance-holder';
const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// What the desk accepts. A short list on purpose: a token the ATM does not
// know is a token the ATM does not sell.
const SELL_TOKENS = {
  ETH: { address: NATIVE_ETH, decimals: 18, label: 'ETH' },
  WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, label: 'WETH' },
  CBBTC: { address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', decimals: 8, label: 'cbBTC' },
  DAI: { address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', decimals: 18, label: 'DAI' },
};
const USDC_DECIMALS = 6;

/** "0.015" ETH -> "15000000000000000" (string integer), or null when it is not a plain positive decimal. */
function toUnits(amount, decimals) {
  const m = /^(\d+)(?:\.(\d{1,}))?$/.exec(String(amount || '').trim());
  if (!m) return null;
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  const n = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return n > 0n ? n.toString() : null;
}
function fromUnits(units, decimals, places = 6) {
  const s = BigInt(units || 0).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

class Atm {
  /** @param {object} a cfg.atm  @param {object} deps { log, fetch } */
  constructor(a, { log, fetch: f, ethBalance } = {}) {
    this.a = a || {};
    this.log = log || (() => {});
    this.fetch = f || globalThis.fetch;
    // Optional: async (address) -> wei as bigint/string. 0x reports an ERC-20
    // balance shortfall in issues.balance but not a native ETH one, so a firm
    // ETH quote for an empty wallet looked sendable (stranger's walk, 2026-10-09).
    this.ethBalance = ethBalance || null;
  }

  sellTokens() { return Object.entries(SELL_TOKENS).map(([k, t]) => ({ key: k, label: t.label, address: t.address, decimals: t.decimals })); }

  /**
   * A quote from 0x for selling `sellToken` (key or address) for USDC, with
   * the ATM's fee attached. `firm` asks for a sendable transaction (the
   * taker's wallet); otherwise an indicative price. Returns what the kiosk
   * shows and, when firm, { transaction, allowance } for the wallet.
   */
  async swapQuote({ sellToken, sellAmount, taker, firm = false }) {
    if (!this.swapReady()) return { ok: false, reason: 'swap_not_configured' };
    const tk = SELL_TOKENS[String(sellToken || '').toUpperCase()] || Object.values(SELL_TOKENS).find((t) => t.address === core.normAddr(sellToken));
    if (!tk) return { ok: false, reason: 'unknown_token' };
    const units = toUnits(sellAmount, tk.decimals);
    if (!units) return { ok: false, reason: 'bad_amount' };
    const takerAddr = core.normAddr(taker);
    if (firm && !takerAddr) return { ok: false, reason: 'bad_taker' };
    const q = new URLSearchParams({
      chainId: String(core.CHAIN_ID), sellToken: tk.address, buyToken: core.USDC_BASE, sellAmount: units,
      swapFeeRecipient: core.toChecksum(this.a.feeRecipient), swapFeeBps: String(this.a.swapFeeBps || 0), swapFeeToken: core.USDC_BASE,
      slippageBps: String(this.a.slippageBps || 100),
    });
    if (takerAddr) q.set('taker', core.toChecksum(takerAddr));
    let r;
    try {
      r = await this.fetch(`${ZEROX}/${firm ? 'quote' : 'price'}?${q}`, { headers: { '0x-api-key': this.a.swapApiKey, '0x-version': 'v2' }, signal: AbortSignal.timeout(15000) });
    } catch (e) { this.log(`atm: 0x unreachable: ${e.message}`); return { ok: false, reason: 'swap_unreachable' }; }
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    if (!r.ok || !j) {
      this.log(`atm: 0x ${r.status}: ${JSON.stringify(j || {}).slice(0, 200)}`);
      return { ok: false, reason: r.status === 401 || r.status === 403 ? 'swap_rejected_key' : 'swap_error', status: r.status, detail: j && (j.reason || j.message) };
    }
    if (j.liquidityAvailable === false) return { ok: false, reason: 'no_liquidity' };
    const fee = j.fees && j.fees.integratorFee ? j.fees.integratorFee : null;
    const out = {
      ok: true,
      sell: { token: tk.label, address: tk.address, amount: fromUnits(units, tk.decimals, 8), units },
      buy: { token: 'USDC', amount: fromUnits(j.buyAmount || '0', USDC_DECIMALS), units: String(j.buyAmount || '0'), minAmount: fromUnits(j.minBuyAmount || j.buyAmount || '0', USDC_DECIMALS) },
      fee: { bps: this.a.swapFeeBps || 0, recipient: core.normAddr(this.a.feeRecipient), amount: fee && fee.amount ? fromUnits(fee.amount, USDC_DECIMALS) : null, token: 'USDC' },
      networkFeeWei: j.totalNetworkFee ? String(j.totalNetworkFee) : null,
      firm,
    };
    if (firm && j.transaction) {
      out.transaction = { to: j.transaction.to, data: j.transaction.data, value: j.transaction.value ? `0x${BigInt(j.transaction.value).toString(16)}` : '0x0', gas: j.transaction.gas ? `0x${BigInt(j.transaction.gas).toString(16)}` : undefined };
      const al = j.issues && j.issues.allowance;
      // An ERC-20 sell needs the AllowanceHolder approved first; native ETH does not.
      out.allowance = al && tk.address !== NATIVE_ETH ? { spender: al.spender, actual: String(al.actual || '0'), needed: units, token: tk.address } : null;
      out.balanceShort = Boolean(j.issues && j.issues.balance);
      if (tk.address === NATIVE_ETH && this.ethBalance) {
        try { if (BigInt(await this.ethBalance(takerAddr)) < BigInt(units)) out.balanceShort = true; }
        catch (e) { this.log(`atm: eth balance of ${takerAddr} unreadable: ${e.message}`); }
      }
    }
    return out;
  }

  /** The on-ramp works once a CDP secret key is configured; the project id alone opens nothing. */
  onrampReady() { return Boolean(this.a.cdpKeyId && this.a.cdpKeySecret); }
  swapReady() { return Boolean(this.a.swapApiKey && core.isAddress(this.a.feeRecipient)); }

  /** What the kiosk shows: which legs are open, the amounts, the fee line. */
  config() {
    return {
      onramp: { ready: this.onrampReady(), provider: 'Coinbase Onramp', network: 'base', asset: 'USDC', amounts: AMOUNTS, currency: this.a.currency || 'USD', fee: 'Coinbase charges its own fee; the ATM adds nothing on this leg.' },
      swap: { ready: this.swapReady(), feeBps: this.a.swapFeeBps || 0, tokens: this.sellTokens(), note: this.swapReady() ? `The ATM keeps ${(this.a.swapFeeBps || 0) / 100}% of each swap, taken in USDC and shown on the quote.` : 'The swap desk opens when its key arrives.' },
      projectId: this.a.projectId || null,
    };
  }

  /**
   * Mint a session for `address` and return the hosted URL. `ip` should be
   * the visitor's real address (Coinbase binds the quote to it).
   */
  async session({ address, amount, currency, ip, ref }) {
    if (!this.onrampReady()) return { ok: false, reason: 'onramp_not_configured' };
    const addr = core.normAddr(address);
    if (!addr) return { ok: false, reason: 'bad_address' };
    // An amount off the menu is refused with the menu, not quietly turned into
    // the default: an agent asking for $7 must not be handed a $20 session.
    if (!AMOUNTS.includes(Number(amount))) return { ok: false, reason: 'bad_amount', amounts: AMOUNTS };
    const amt = Number(amount);
    const cur = /^[A-Z]{3}$/.test(String(currency || '')) ? currency : (this.a.currency || 'USD');
    const body = { addresses: [{ address: core.toChecksum(addr), blockchains: ['base'] }], assets: ['USDC'] };
    if (ip && /^[0-9.]+$|^[0-9a-f:]+$/i.test(ip) && ip !== '127.0.0.1' && ip !== '::1') body.clientIp = ip;
    let jwt;
    try { jwt = cdpJwt({ keyId: this.a.cdpKeyId, secret: this.a.cdpKeySecret, method: 'POST', host: 'api.developer.coinbase.com', path: '/onramp/v1/token' }); }
    catch (e) { this.log(`atm: jwt: ${e.message}`); return { ok: false, reason: 'onramp_key_invalid' }; }
    let r;
    try {
      r = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    } catch (e) { this.log(`atm: token request failed: ${e.message}`); return { ok: false, reason: 'onramp_unreachable' }; }
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    if (!r.ok || !j || !j.token) {
      this.log(`atm: token ${r.status}: ${JSON.stringify(j || {}).slice(0, 200)}`);
      return { ok: false, reason: r.status === 401 || r.status === 403 ? 'onramp_rejected_key' : 'onramp_error', status: r.status };
    }
    const partnerUserRef = ref || `atm-${addr.slice(2, 10)}-${Date.now().toString(36)}`;
    const url = onrampUrl({ token: j.token, amount: amt, currency: cur, redirectUrl: this.a.redirectUrl || undefined, partnerUserRef });
    this.log(`atm: session for ${addr} ${amt} ${cur}`);
    return { ok: true, url, amount: amt, currency: cur, address: addr, partnerUserRef, expiresInSec: 300 };
  }
}

module.exports = { Atm, cdpJwt, onrampUrl, loadKey, toUnits, fromUnits, AMOUNTS, TOKEN_URL, PAY_URL, ZEROX, SELL_TOKENS, NATIVE_ETH };
