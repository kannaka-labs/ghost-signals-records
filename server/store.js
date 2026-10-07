'use strict';
// The record store: finished albums for sale as downloads, paid in USDC on
// Base. The chain is the payment processor: a buyer sends USDC to the
// label's address, the store watches the USDC contract for Transfers to that
// address and matches each one to an open purchase. One Transfer pays for one
// thing, ever (the ledger key is the tx hash + log index). Nothing here holds
// a private key: the address only receives.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { now } = require('./db');
const core = require('./store-core');
const { writeZip } = require('./zip');
const { smtpSend } = require('./mail');

const RPC_CHUNK = 2000; // blocks per eth_getLogs call: public nodes cap the range

/** JSON-RPC over fetch, trying each URL in turn. Public Base nodes are free
 *  and occasionally refuse or stall; a second one keeps payments flowing. */
function makeRpc(urls, userAgent) {
  const list = urls.filter(Boolean);
  return async function rpc(method, params) {
    let lastErr;
    for (const url of list) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': userAgent || 'GhostSignalsRecords/0.1' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`rpc ${url}: http ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
        return j.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no rpc url configured');
  };
}

class Store {
  constructor(db, cfg, { rpc, log, ffmpeg } = {}) {
    this.db = db;
    this.cfg = cfg;
    this.s = cfg.store || {};
    this.log = log || (() => {});
    this.rpc = rpc || makeRpc(this.s.rpcUrls || [], cfg.userAgent);
    this.ffmpeg = ffmpeg === undefined ? 'ffmpeg' : ffmpeg; // null = no previews
    this._timer = null;
  }

  /** The store can take money once it has an address to be paid at and a
   *  secret to sign download links with. */
  enabled() { return Boolean(core.isAddress(this.s.payTo) && this.s.downloadSecret); }

  dir(sku) { return path.join(this.cfg.dataDir, 'releases', sku); }

  // ---- catalog ------------------------------------------------------------
  /**
   * Publish a finished album. `m` names the files on this machine:
   *   { sku?, title, artist, year?, blurb?, credits?, cover: path, tracks: [{ title, file: path }] }
   * Files are copied into the release dir as "NN - Title.mp3", a 45 s preview
   * is cut for each (when ffmpeg is present), a README goes in, and the zip is
   * written. Publishing the same sku again rebuilds it in place.
   */
  async publish(m) {
    if (!m || !m.title || !Array.isArray(m.tracks) || !m.tracks.length) throw Object.assign(new Error('a release needs a title and tracks'), { status: 400 });
    for (const t of m.tracks) if (!t.title || !t.file || !fs.existsSync(t.file)) throw Object.assign(new Error(`track file missing: ${t.file || t.title}`), { status: 400 });
    if (!m.cover || !fs.existsSync(m.cover)) throw Object.assign(new Error('cover file missing'), { status: 400 });
    const sku = core.slug(m.sku || m.title);
    const artist = m.artist || 'Kannaka';
    const dir = this.dir(sku);
    fs.mkdirSync(dir, { recursive: true });
    const coverExt = /\.jpe?g$/i.test(m.cover) ? 'jpg' : 'png';
    const coverFile = `cover.${coverExt}`;
    place(m.cover, path.join(dir, coverFile));
    const tracks = [];
    for (let i = 0; i < m.tracks.length; i++) {
      const t = m.tracks[i];
      const file = `${String(i + 1).padStart(2, '0')} - ${safeName(t.title)}.mp3`;
      place(t.file, path.join(dir, file));
      const duration = await this._probe(path.join(dir, file));
      const preview = `preview-${String(i + 1).padStart(2, '0')}.mp3`;
      const ok = await this._preview(path.join(dir, file), path.join(dir, preview));
      tracks.push({ n: i + 1, title: t.title, file, duration, preview: ok ? preview : null });
    }
    // Extra artwork (per-track covers, inner sleeves) rides along in art/.
    const art = [];
    if (Array.isArray(m.art) && m.art.length) {
      fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
      for (const f of m.art) {
        if (!fs.existsSync(f)) throw Object.assign(new Error(`art file missing: ${f}`), { status: 400 });
        const name = safeName(path.basename(f, path.extname(f))) + path.extname(f).toLowerCase();
        place(f, path.join(dir, 'art', name));
        art.push(name);
      }
    }
    const readme = core.readmeText({ title: m.title, artist, year: m.year, tracks, publicUrl: this.cfg.publicUrl, credits: m.credits });
    fs.writeFileSync(path.join(dir, 'README.txt'), readme);
    const zipName = `${sku}.zip`;
    const folder = `${safeName(artist)} - ${safeName(m.title)}`;
    const { bytes } = writeZip(path.join(dir, zipName), [
      ...tracks.map((t) => ({ name: `${folder}/${t.file}`, path: path.join(dir, t.file) })),
      { name: `${folder}/${coverFile}`, path: path.join(dir, coverFile) },
      ...art.map((a) => ({ name: `${folder}/art/${a}`, path: path.join(dir, 'art', a) })),
      { name: `${folder}/README.txt`, data: Buffer.from(readme, 'utf8') },
    ]);
    const existing = await this.db.get('SELECT sku FROM releases WHERE sku=?', [sku]);
    const row = [m.title, artist, m.year || null, m.blurb || null, coverFile, zipName, bytes, JSON.stringify(tracks), this.s.priceMicro, now()];
    if (existing) await this.db.run('UPDATE releases SET title=?, artist=?, year=?, blurb=?, cover_file=?, zip_file=?, zip_bytes=?, tracks_json=?, price_micro=?, updated_at=? WHERE sku=?', [...row, sku]);
    else await this.db.run('INSERT INTO releases (title, artist, year, blurb, cover_file, zip_file, zip_bytes, tracks_json, price_micro, updated_at, sku, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [...row, sku, now()]);
    this.log(`published ${sku}: ${tracks.length} tracks, ${(bytes / 1e6).toFixed(1)} MB`);
    return this.release(sku);
  }

  async unpublish(sku) {
    const r = await this.db.run('UPDATE releases SET published_at=NULL, updated_at=? WHERE sku=?', [now(), sku]);
    return r.changes === 1;
  }

  async catalog() {
    return (await this.db.all('SELECT * FROM releases WHERE published_at IS NOT NULL ORDER BY year DESC, title ASC')).map(hydrateRelease);
  }

  async release(sku, { includeUnpublished = false } = {}) {
    const row = await this.db.get('SELECT * FROM releases WHERE sku=?', [sku]);
    if (!row || (!row.published_at && !includeUnpublished)) return null;
    return hydrateRelease(row);
  }

  /** What a page (or an agent) needs to pay: the address, the amount, and the
   *  exact calldata for a wallet. The same block answers a 402. */
  paymentTerms(purchase) {
    return {
      chainId: core.CHAIN_ID,
      network: 'base',
      asset: core.USDC_BASE,
      assetSymbol: 'USDC',
      payTo: core.normAddr(this.s.payTo),
      amountMicro: String(purchase.amountMicro),
      amount: core.microToUsdc(purchase.amountMicro),
      calldata: core.transferCalldata(this.s.payTo, purchase.amountMicro),
      confirmations: this.s.confirmations,
      claimUrl: `${this.cfg.publicUrl}/api/purchase/${purchase.publicId}/tx`,
      statusUrl: `${this.cfg.publicUrl}/api/purchase/${purchase.publicId}`,
    };
  }

  // ---- purchases ----------------------------------------------------------
  async buy(sku, { email, fromAddr } = {}) {
    const rel = await this.release(sku);
    if (!rel) throw Object.assign(new Error('no such record'), { status: 404 });
    if (!this.enabled()) throw Object.assign(new Error('the store is not taking payments yet'), { status: 503 });
    const from = fromAddr ? core.normAddr(fromAddr) : null;
    if (fromAddr && !from) throw Object.assign(new Error('bad wallet address'), { status: 400 });
    // A transfer mined before the purchase was opened cannot be its payment.
    // A little slack for clock skew between us and the node.
    let fromBlock = null;
    try { fromBlock = Math.max(0, parseInt(await this.rpc('eth_blockNumber', []), 16) - 30); } catch (e) { this.log(`buy: head block unavailable (${e.message})`); }
    const id = crypto.randomUUID();
    const publicId = crypto.randomBytes(16).toString('base64url');
    await this.db.run(
      'INSERT INTO purchases (id, public_id, sku, state, amount_micro, pay_to, from_addr, from_block, email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, publicId, sku, 'awaiting', rel.priceMicro, core.normAddr(this.s.payTo), from, fromBlock, email || null, now(), now()],
    );
    return this.purchase(publicId);
  }

  async purchase(publicId) {
    const row = await this.db.get('SELECT * FROM purchases WHERE public_id=?', [publicId]);
    return row ? hydratePurchase(row) : null;
  }

  async purchaseById(id) {
    const row = await this.db.get('SELECT * FROM purchases WHERE id=?', [id]);
    return row ? hydratePurchase(row) : null;
  }

  /** The buyer (or their page) hands us the hash of the transfer they sent. We
   *  read the receipt ourselves; the hash is only a pointer. */
  async claimTx(purchase, txHash) {
    if (!core.isTxHash(txHash)) return { ok: false, reason: 'bad_hash' };
    if (purchase.state !== 'awaiting') return { ok: true, already: true, state: purchase.state };
    const receipt = await this.rpc('eth_getTransactionReceipt', [txHash.toLowerCase()]);
    if (!receipt) return { ok: false, reason: 'pending' };
    if (receipt.status !== '0x1') return { ok: false, reason: 'tx_failed' };
    const head = parseInt(await this.rpc('eth_blockNumber', []), 16);
    const reasons = [];
    for (const log of receipt.logs || []) {
      const t = core.parseTransferLog(log);
      if (!t) continue;
      const m = core.matchTransfer(purchase, t, { payTo: this.s.payTo, headBlock: head, confirmations: this.s.confirmations });
      if (!m.ok) { reasons.push(m.reason); continue; }
      return this.settle(purchase, t);
    }
    return { ok: false, reason: reasons.includes('unconfirmed') ? 'unconfirmed' : reasons[0] || 'no_transfer_to_us' };
  }

  /** Record the payment exactly once and open the download. */
  async settle(purchase, t) {
    const key = core.ledgerKey(t);
    const cents = Math.round(Number(t.micro) / 10000);
    let fresh;
    try {
      await this.db.run('INSERT INTO ledger (key, order_id, kind, amount_cents, currency, ref, created_at) VALUES (?,?,?,?,?,?,?)', [key, purchase.id, 'usdc', cents, 'usdc', t.txHash, now()]);
      fresh = true;
    } catch (e) {
      if (!/UNIQUE|PRIMARY KEY/i.test(String(e.message))) throw e;
      // Seen before. Either this purchase already settled on it (a replayed
      // claim), or the watcher filed it as unmatched before the buyer told us
      // whose it was: that row may be taken over, once.
      const row = await this.db.get('SELECT * FROM ledger WHERE key=?', [key]);
      if (row.order_id === purchase.id) return { ok: true, already: true, state: 'paid' };
      if (row.kind !== 'unmatched') return { ok: false, reason: 'transfer_already_used' };
      const r = await this.db.run('UPDATE ledger SET order_id=?, kind=? WHERE key=? AND kind=?', [purchase.id, 'usdc', key, 'unmatched']);
      if (r.changes !== 1) return { ok: false, reason: 'transfer_already_used' };
      fresh = true;
    }
    const moved = (await this.db.run(
      'UPDATE purchases SET state=?, tx_hash=?, log_index=?, from_addr=COALESCE(from_addr, ?), paid_at=?, updated_at=? WHERE id=? AND state=?',
      ['paid', t.txHash, t.logIndex, t.from, now(), now(), purchase.id, 'awaiting'],
    )).changes === 1;
    if (moved) {
      this.log(`paid: ${purchase.sku} ${purchase.publicId} by ${t.from} tx ${t.txHash}`);
      this._mailReceipt(await this.purchase(purchase.publicId)).catch(() => {});
    }
    return { ok: true, already: !fresh && !moved, state: 'paid' };
  }

  /** The operator gives a record away. */
  async comp(purchase, who) {
    if (purchase.state !== 'awaiting') return { ok: false, reason: `state ${purchase.state}` };
    await this.db.run('INSERT OR IGNORE INTO ledger (key, order_id, kind, amount_cents, currency, ref, created_at) VALUES (?,?,?,?,?,?,?)', [`comp:${purchase.id}`, purchase.id, 'comp', 0, 'usdc', String(who || 'admin'), now()]);
    const moved = (await this.db.run('UPDATE purchases SET state=?, comped_at=?, paid_at=?, updated_at=? WHERE id=? AND state=?', ['paid', now(), now(), now(), purchase.id, 'awaiting'])).changes === 1;
    if (moved) this._mailReceipt(await this.purchase(purchase.publicId)).catch(() => {});
    return { ok: moved };
  }

  // ---- the watcher: Transfers to our address, matched to open purchases --
  /** Scan new blocks for USDC Transfers to the label's address. Called on a
   *  timer; safe to call again before the last call finished (it will not). */
  async scan() {
    if (!this.enabled() || this._scanning) return { scanned: 0 };
    this._scanning = true;
    try {
      const head = parseInt(await this.rpc('eth_blockNumber', []), 16);
      const safeHead = head - Math.max(0, this.s.confirmations - 1);
      let from = parseInt((await this.db.get('SELECT v FROM kv WHERE k=?', ['usdc_last_block']) || {}).v || '', 10);
      if (!Number.isFinite(from)) {
        // First run: start here. The past holds no purchases of ours.
        await this.db.run('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)', ['usdc_last_block', String(safeHead)]);
        return { scanned: 0, head };
      }
      from += 1;
      let matched = 0; let seen = 0;
      while (from <= safeHead) {
        const to = Math.min(safeHead, from + RPC_CHUNK - 1);
        const logs = await this.rpc('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: core.USDC_BASE, topics: [core.TRANSFER_TOPIC, null, core.addrTopic(this.s.payTo)] }]);
        for (const log of logs || []) {
          const t = core.parseTransferLog(log);
          if (!t || t.removed) continue;
          seen++;
          if (await this.db.get('SELECT key FROM ledger WHERE key=?', [core.ledgerKey(t)])) continue;
          const candidates = (await this.db.all('SELECT * FROM purchases WHERE state=? AND amount_micro=? AND from_addr=? ORDER BY created_at ASC', ['awaiting', Number(t.micro), t.from])).map(hydratePurchase);
          const p = candidates.find((c) => core.matchTransfer(c, t, { payTo: this.s.payTo, headBlock: head, confirmations: this.s.confirmations }).ok);
          if (p) { const r = await this.settle(p, t); if (r.ok && !r.already) matched++; continue; }
          // Money arrived that no named buyer explains: keep it on the books so
          // a later claim (or the operator) can attach it. A buyer paying from
          // a wallet they did not name hands us the tx hash and takes it then.
          await this.db.run('INSERT OR IGNORE INTO ledger (key, order_id, kind, amount_cents, currency, ref, created_at) VALUES (?,?,?,?,?,?,?)', [core.ledgerKey(t), '', 'unmatched', Math.round(Number(t.micro) / 10000), 'usdc', `${t.txHash} from ${t.from}`, now()]);
          this.log(`unmatched USDC transfer: ${core.microToUsdc(t.micro)} from ${t.from} tx ${t.txHash}`);
        }
        await this.db.run('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)', ['usdc_last_block', String(to)]);
        from = to + 1;
      }
      return { scanned: seen, matched, head };
    } finally {
      this._scanning = false;
    }
  }

  start() {
    if (this._timer || !this.enabled()) return;
    const tick = () => this.scan().catch((e) => this.log(`scan: ${e.message}`));
    this._timer = setInterval(tick, this.s.scanMs || 15000);
    this._timer.unref();
    // The first look waits a beat so a caller can finish wiring (tests swap
    // the chain in after the server is up); the timer is never a reason the
    // process stays alive.
    this._first = setTimeout(tick, Math.min(2000, this.s.scanMs || 15000));
    this._first.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._first) clearTimeout(this._first);
    this._timer = null; this._first = null;
  }

  // ---- downloads ------------------------------------------------------------
  downloadToken(publicId, nowSec = Math.floor(Date.now() / 1000)) {
    return core.signDownload(this.s.downloadSecret, publicId, nowSec + (this.s.tokenHours || 72) * 3600);
  }

  verifyToken(publicId, token, nowSec = Math.floor(Date.now() / 1000)) {
    return core.verifyDownload(this.s.downloadSecret, publicId, token, nowSec);
  }

  async purchases(limit = 100) {
    return (await this.db.all('SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?', [limit])).map(hydratePurchase);
  }

  async unmatched() {
    return this.db.all('SELECT * FROM ledger WHERE kind=? ORDER BY created_at DESC', ['unmatched']);
  }

  async _mailReceipt(p) {
    if (!p || !p.email) return false;
    const rel = await this.release(p.sku, { includeUnpublished: true });
    const link = `${this.cfg.publicUrl}/p/${p.publicId}`;
    return smtpSend(this.cfg.mail, {
      to: p.email,
      subject: `Your download: ${rel ? rel.title : p.sku}`,
      text: `Thank you. Your copy of ${rel ? `"${rel.title}" by ${rel.artist}` : p.sku} is ready.\n\n`
        + `Download page (keep this link; it is your copy):\n  ${link}\n\n`
        + `The zip holds the mp3s, the cover and a short note on what you may do with them.\n`
        + (p.txHash ? `\nPaid with USDC on Base, transaction ${p.txHash}\n` : '')
        + `\nGhost Signals Records\n${this.cfg.publicUrl}\n`,
    });
  }

  _probe(file) {
    if (!this.ffmpeg) return Promise.resolve(null);
    return new Promise((resolve) => {
      const [cmd, args] = gently(this.ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      execFile(cmd, args, { timeout: 20000 }, (err, out) => {
        const n = parseFloat(String(out || '').trim());
        resolve(!err && Number.isFinite(n) ? Math.round(n) : null);
      });
    });
  }

  _preview(src, out) {
    if (!this.ffmpeg) return Promise.resolve(false);
    const sec = this.s.previewSec || 45;
    return new Promise((resolve) => {
      const [cmd, args] = gently(this.ffmpeg, ['-y', '-v', 'error', '-i', src, '-t', String(sec), '-af', `afade=t=out:st=${sec - 3}:d=3`, '-c:a', 'libmp3lame', '-b:a', '96k', out]);
      execFile(cmd, args, { timeout: 120000 }, (err) => resolve(!err && fs.existsSync(out)));
    });
  }
}

/** Put `src` at `dst`: a hard link when both sit on one filesystem (the music
 *  dir and the store share the big disk, so a release costs no second copy
 *  of its audio), a copy otherwise. */
function place(src, dst) {
  try { fs.unlinkSync(dst); } catch { /* nothing there */ }
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

/** The encoder runs beside a live radio on one CPU: lowest priority, where
 *  the platform has `nice`. */
function gently(cmd, args) {
  return process.platform === 'win32' ? [cmd, args] : ['nice', ['-n', '15', cmd, ...args]];
}

function safeName(s) { return String(s).replace(/[^A-Za-z0-9 _.,'()&-]+/g, '').replace(/^[. _-]+/, '').trim().replace(/\s+/g, ' ').slice(0, 70) || 'track'; }

function hydrateRelease(row) {
  return {
    sku: row.sku, title: row.title, artist: row.artist, year: row.year, blurb: row.blurb,
    coverFile: row.cover_file, zipFile: row.zip_file, zipBytes: row.zip_bytes,
    tracks: JSON.parse(row.tracks_json || '[]'), priceMicro: row.price_micro, price: core.microToUsdc(row.price_micro),
    publishedAt: row.published_at, updatedAt: row.updated_at,
  };
}

function hydratePurchase(row) {
  return {
    id: row.id, publicId: row.public_id, sku: row.sku, state: row.state, amountMicro: row.amount_micro, payTo: row.pay_to,
    fromAddr: row.from_addr, fromBlock: row.from_block, email: row.email, txHash: row.tx_hash, logIndex: row.log_index,
    paidAt: row.paid_at, compedAt: row.comped_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = { Store, makeRpc, safeName };
