'use strict';
// Gasless checkout: the buyer signs a USDC transfer authorization (EIP-3009,
// `transferWithAuthorization`) in their wallet and the store's relayer submits
// it, paying the Base network fee from a small ETH float. The buyer needs USDC
// and nothing else. The chain still settles the purchase the same way as a
// plain transfer: the authorization emits Transfer(from -> payTo), the watcher
// and the tx claim match it exactly as before.
//
// What the relayer key can and cannot do: it holds gas ETH only. It can submit
// a transfer the buyer signed, for the amount and recipient the buyer signed,
// and nothing else; USDC itself checks the signature on-chain. Losing the key
// loses the float, not a buyer's funds.
const { ethers } = require('ethers');
const core = require('./store-core');

const USDC_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

/** The real chain behind the relayer, through ethers. Tests inject a fake with
 *  the same four methods. */
function ethersChain({ rpcUrls, key }) {
  const provider = new ethers.FallbackProvider(
    rpcUrls.map((url, i) => ({ provider: new ethers.JsonRpcProvider(url, core.CHAIN_ID, { staticNetwork: true }), priority: i + 1, stallTimeout: 4000 })),
    core.CHAIN_ID, { quorum: 1 },
  );
  const wallet = new ethers.Wallet(key, provider);
  const usdc = new ethers.Contract(core.USDC_BASE, USDC_ABI, wallet);
  return {
    address: wallet.address,
    async relayerBalanceWei() { return provider.getBalance(wallet.address); },
    async balanceOf(addr) { return usdc.balanceOf(addr); },
    async authorizationState(addr, nonce) { return usdc.authorizationState(addr, nonce); },
    async send(a) {
      const tx = await usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
      return tx.hash;
    },
  };
}

class Relayer {
  /**
   * @param {object} s  cfg.store (relayerKey, rpcUrls, relayMinWei, relayPerHour, authMinutes)
   * @param {object} deps  { log, chain? }  chain = ethersChain by default
   */
  constructor(s, { log, chain } = {}) {
    this.s = s || {};
    this.log = log || (() => {});
    this.chain = null;
    if (chain) this.chain = chain;
    else if (/^0x[0-9a-fA-F]{64}$/.test(String(this.s.relayerKey || ''))) {
      try { this.chain = ethersChain({ rpcUrls: this.s.rpcUrls || [], key: this.s.relayerKey }); }
      catch (e) { this.log(`relayer: key rejected (${e.message})`); }
    }
    this.minWei = BigInt(this.s.relayMinWei || 20000000000000n); // 0.00002 ETH, about 50 transfers at Base prices
    this.perHour = this.s.relayPerHour || 60;
    this._sent = [];
  }

  enabled() { return Boolean(this.chain); }
  address() { return this.chain ? this.chain.address : null; }

  /** Live state for the operator: address, float, whether it will relay now. */
  async status() {
    if (!this.chain) return { enabled: false, reason: 'no_key' };
    let wei = null;
    try { wei = await this.chain.relayerBalanceWei(); } catch (e) { return { enabled: false, address: this.chain.address, reason: `rpc: ${e.message}` }; }
    const dry = BigInt(wei) < this.minWei;
    return { enabled: !dry, address: this.chain.address, balanceEth: ethers.formatEther(wei), minEth: ethers.formatEther(this.minWei), reason: dry ? 'relayer_dry' : null, sentLastHour: this._recent() };
  }

  _recent() {
    const cut = Date.now() - 3600000;
    this._sent = this._sent.filter((t) => t > cut);
    return this._sent.length;
  }

  /**
   * Check a signed authorization against what the store issued for this
   * purchase, then submit it. Returns { ok, txHash } or { ok: false, reason }.
   * `auth` = { from, signature } (65-byte hex) or { from, v, r, s }.
   */
  async relay(purchase, payTo, auth) {
    if (!this.chain) return { ok: false, reason: 'disabled' };
    const check = core.checkAuthorization(purchase, payTo, auth);
    if (!check.ok) return check;
    const { message, sig } = check;
    if (this._recent() >= this.perHour) return { ok: false, reason: 'relayer_busy' };
    let wei;
    try { wei = BigInt(await this.chain.relayerBalanceWei()); } catch (e) { return { ok: false, reason: `rpc: ${e.message}` }; }
    if (wei < this.minWei) { this.log(`relayer: float ${ethers.formatEther(wei)} ETH is below the floor; refusing`); return { ok: false, reason: 'relayer_dry' }; }
    try {
      const bal = BigInt(await this.chain.balanceOf(message.from));
      if (bal < BigInt(message.value)) return { ok: false, reason: 'insufficient_usdc' };
      if (await this.chain.authorizationState(message.from, message.nonce)) return { ok: false, reason: 'authorization_used' };
    } catch (e) { return { ok: false, reason: `rpc: ${e.message}` }; }
    try {
      const txHash = await this.chain.send({ ...message, v: sig.v, r: sig.r, s: sig.s });
      this._sent.push(Date.now());
      this.log(`relayed: ${purchase.sku} ${purchase.publicId} from ${message.from} tx ${txHash}`);
      return { ok: true, txHash };
    } catch (e) {
      this.log(`relay failed: ${purchase.publicId}: ${e.shortMessage || e.message}`);
      return { ok: false, reason: 'send_failed', detail: String(e.shortMessage || e.message).slice(0, 200) };
    }
  }
}

module.exports = { Relayer, ethersChain, USDC_ABI };
