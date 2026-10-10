'use strict';
// The store's pure parts: what a USDC payment on Base looks like, when a
// Transfer counts as paying for a purchase, download tokens, the readme.
// No I/O here; store.js does the talking to the chain and the database.
const crypto = require('node:crypto');

// USDC on Base mainnet (Circle's native issue), 6 decimals.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CHAIN_ID = 8453;
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function isAddress(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a || '')); }
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
function normAddr(a) { return isAddress(a) ? `0x${String(a).slice(2).toLowerCase()}` : null; }
function isTxHash(h) { return /^0x[0-9a-fA-F]{64}$/.test(String(h || '')); }
/** An address as a 32-byte log topic, and back. */
function addrTopic(a) { return `0x${'0'.repeat(24)}${normAddr(a).slice(2)}`; }
function topicAddr(t) { return `0x${String(t).slice(-40).toLowerCase()}`; }

/** "5000000" -> "5"; "5000123" -> "5.000123". */
function microToUsdc(micro) {
  const s = BigInt(micro).toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** ERC-20 transfer(to, amount) calldata, for a wallet to send to the USDC contract. */
function transferCalldata(to, micro) {
  return `0xa9059cbb${'0'.repeat(24)}${normAddr(to).slice(2)}${BigInt(micro).toString(16).padStart(64, '0')}`;
}

/** A Transfer event out of an eth_getLogs / receipt log, or null if the log is something else. */
function parseTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) return null;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-fA-F]*$/.test(String(log.data || ''))) return null;
  return {
    token: normAddr(log.address),
    from: topicAddr(log.topics[1]),
    to: topicAddr(log.topics[2]),
    micro: BigInt(log.data === '0x' ? '0x0' : log.data).toString(),
    txHash: String(log.transactionHash || '').toLowerCase(),
    logIndex: parseInt(log.logIndex, 16),
    blockNumber: parseInt(log.blockNumber, 16),
    removed: Boolean(log.removed),
  };
}

/**
 * Does this Transfer pay for this purchase? Every rule is a reason, so the
 * operator can read why a payment did not count:
 *   - the right token, to our address, for exactly the asked amount;
 *   - from the wallet the buyer named, when they named one;
 *   - mined after the purchase was opened (a transfer from before cannot be
 *     the payment for it), and buried under enough blocks to be final.
 */
function matchTransfer(purchase, t, { payTo, token = USDC_BASE, headBlock, confirmations = 3 }) {
  if (!t || t.removed) return { ok: false, reason: 'removed' };
  if (t.token !== normAddr(token)) return { ok: false, reason: 'wrong_token' };
  if (t.to !== normAddr(payTo)) return { ok: false, reason: 'wrong_recipient' };
  if (t.micro !== String(purchase.amountMicro)) return { ok: false, reason: 'wrong_amount' };
  if (purchase.fromAddr && t.from !== normAddr(purchase.fromAddr)) return { ok: false, reason: 'wrong_sender' };
  if (purchase.fromBlock && t.blockNumber < purchase.fromBlock) return { ok: false, reason: 'too_early' };
  if (Number.isFinite(headBlock) && headBlock - t.blockNumber + 1 < confirmations) return { ok: false, reason: 'unconfirmed' };
  return { ok: true };
}

/** One Transfer can pay for one thing, ever. */
function ledgerKey(t) { return `usdc:${t.txHash}:${t.logIndex}`; }

// ---- gasless checkout: EIP-3009 transferWithAuthorization on USDC ---------
// USDC's EIP-712 domain on Base (FiatTokenV2_2): name "USD Coin", version "2".
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
function isBytes32(h) { return /^0x[0-9a-fA-F]{64}$/.test(String(h || '')); }

/** The message a buyer signs: a transfer of exactly the purchase amount to the
 *  store, under the nonce and deadline the store issued for this purchase. */
function authMessage(purchase, payTo, from) {
  return {
    from: toChecksum(from),
    to: toChecksum(payTo),
    value: String(purchase.amountMicro),
    validAfter: '0',
    validBefore: String(purchase.authValidBefore),
    nonce: purchase.authNonce,
  };
}

/** What the wallet is asked to sign (eth_signTypedData_v4 takes this JSON). */
function authTypedData(purchase, payTo, from) {
  return {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...AUTH_TYPES },
    primaryType: 'TransferWithAuthorization',
    domain: USDC_DOMAIN,
    message: authMessage(purchase, payTo, from),
  };
}

/**
 * Is this a signature over exactly the authorization we issued? Every rule is
 * a reason. Returns { ok, message, sig: {v, r, s} } or { ok: false, reason }.
 * The signature is recovered here so a wrong signer never reaches the chain
 * (USDC would also reject it, but at the relayer's gas expense).
 */
function checkAuthorization(purchase, payTo, auth, nowSec = Math.floor(Date.now() / 1000)) {
  if (!purchase || purchase.state !== 'awaiting') return { ok: false, reason: 'not_awaiting' };
  if (!purchase.authNonce || !purchase.authValidBefore) return { ok: false, reason: 'no_authorization_issued' };
  if (!auth || !isAddress(auth.from) || normAddr(auth.from) === ZERO_ADDRESS) return { ok: false, reason: 'bad_from' };
  if (purchase.fromAddr && normAddr(auth.from) !== normAddr(purchase.fromAddr)) return { ok: false, reason: 'wrong_sender' };
  if (Number(purchase.authValidBefore) <= nowSec + 60) return { ok: false, reason: 'expired' };
  let sig;
  try {
    const { ethers } = require('ethers');
    sig = ethers.Signature.from(auth.signature ? auth.signature : { v: auth.v, r: auth.r, s: auth.s });
    const message = authMessage(purchase, payTo, auth.from);
    const signer = ethers.verifyTypedData(USDC_DOMAIN, AUTH_TYPES, message, sig);
    if (normAddr(signer) !== normAddr(auth.from)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, message, sig: { v: sig.v, r: sig.r, s: sig.s } };
  } catch (e) {
    return { ok: false, reason: 'bad_signature' };
  }
}

// ---- proof that a transfer is the claimant's -------------------------------
// A tx hash is public: anyone watching the store's address sees it. A claim by
// hash for a purchase that named no wallet (or one the watcher would not give
// the transfer to) must carry the sender's EIP-191 signature over this text,
// which binds the purchase and the transaction so it cannot be reused.
function claimMessage(publicId, txHash) {
  return `Ghost Signals Records: I sent the payment for purchase ${publicId} in transaction ${String(txHash).toLowerCase()}.`;
}
/** The address that signed claimMessage(publicId, txHash), or null. */
function claimSigner(publicId, txHash, signature) {
  try {
    const { ethers } = require('ethers');
    return normAddr(ethers.verifyMessage(claimMessage(publicId, txHash), signature));
  } catch { return null; }
}

function toChecksum(a) { const { ethers } = require('ethers'); return ethers.getAddress(normAddr(a)); }

// ---- download tokens: HMAC over (purchase, expiry), base64url, no state --
function signDownload(secret, publicId, expSec) {
  const mac = crypto.createHmac('sha256', secret).update(`${publicId}.${expSec}`).digest('base64url').slice(0, 32);
  return `${expSec}.${mac}`;
}
function verifyDownload(secret, publicId, token, nowSec) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m || !secret) return false;
  const exp = parseInt(m[1], 10);
  if (exp < nowSec) return false;
  const want = Buffer.from(signDownload(secret, publicId, exp));
  const got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'release';
}

/** The note that ships inside every zip. Plain words; the buyer's copy of the deal. */
function readmeText({ title, artist, year, tracks, publicUrl, credits }) {
  const list = tracks.map((t, i) => `  ${String(i + 1).padStart(2, '0')}  ${t.title}`).join('\n');
  return [
    `${title}`,
    `${artist}${year ? `, ${year}` : ''}`,
    '',
    'Tracks',
    list,
    '',
    credits || `Written, performed and produced by ${artist}. Cover art by ${artist}.`,
    `Released by Ghost Signals Records, ${publicUrl}`,
    '',
    'What you may do with these files',
    'They are yours to keep: play them on any device you own, copy them between',
    'your own devices, back them up. Please do not re-sell them, upload them to',
    'streaming or file-sharing services, or use them in your own commercial work.',
    `If you want to do something like that, write to us: kannaka@spacechild.love.`,
    '',
    'Thank you for buying the record. It keeps the station on the air.',
    '',
  ].join('\n');
}

module.exports = {
  USDC_BASE, CHAIN_ID, TRANSFER_TOPIC, USDC_DOMAIN, AUTH_TYPES,
  isAddress, normAddr, isTxHash, isBytes32, addrTopic, topicAddr, microToUsdc, transferCalldata,
  parseTransferLog, matchTransfer, ledgerKey, signDownload, verifyDownload, slug, readmeText,
  authMessage, authTypedData, checkAuthorization, toChecksum, ZERO_ADDRESS,
  claimMessage, claimSigner,
};
