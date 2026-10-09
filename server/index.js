'use strict';
// The studio's front door: the desk for the web, the album pages, the two
// webhooks (Stripe, the tower), and a small admin surface. Plain node:http.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./config');
const { Db } = require('./db');
const { Orders } = require('./orders');
const { Stripe } = require('./stripe');
const { Desk } = require('./desk');
const { Tower } = require('./tower');
const { Kax } = require('./kax');
const { readBody, readJson } = require('./read-body');
const { TIERS, PALETTE, ART_DIRECTIONS } = require('./catalog');
const { orderDir, buildCover, safeName } = require('./worker');
const { Suno } = require('./suno');
const { smtpSend } = require('./mail');
const { Atelier } = require('./art');
const { Store } = require('./store');
const { Relayer } = require('./gasless');
const { Atm } = require('./atm');
const { microToUsdc } = require('./store-core');
const { Vesper, MAX_QUESTION } = require('./vesper');

const log = (m) => console.log(`[records ${new Date().toISOString()}] ${m}`);
const PUBLIC = path.join(__dirname, '..', 'public');

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(data);
}

function html(res, status, file, vars = {}) {
  let page = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  for (const [k, v] of Object.entries(vars)) page = page.split(`{{${k}}}`).join(v);
  send(res, status, page, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A per-visitor cookie names the web session; nothing else identifies a
// web visitor until they type an email at checkout.
function cookie(req) {
  const m = /(?:^|;\s*)gsr=([A-Za-z0-9_-]{8,40})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

// Per-IP throttle on the desk and checkout: a small token bucket.
const buckets = new Map();
function allow(ip, capacity = 30, perMs = 60000) {
  const nowMs = Date.now();
  const b = buckets.get(ip) || { tokens: capacity, at: nowMs };
  b.tokens = Math.min(capacity, b.tokens + ((nowMs - b.at) / perMs) * capacity);
  b.at = nowMs;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}

async function main(opts = {}) {
  const db = await new Db(path.join(cfg.dataDir, 'records.sqlite')).open();
  const orders = new Orders(db, cfg);
  const stripe = new Stripe(cfg, orders, log);
  const suno = cfg.suno.key ? new Suno({ ...cfg.suno, userAgent: cfg.userAgent }) : null;
  const desk = new Desk(cfg, orders, stripe, log, suno);
  const kax = (cfg.kax.agentToken || cfg.kax.towerCredential) && cfg.kax.storey ? new Kax({ ...cfg.kax, userAgent: cfg.userAgent }) : null;
  const tower = new Tower(cfg, db, orders, desk, kax, log);
  const relayer = new Relayer(cfg.store, { log, chain: opts.relayChain });
  const store = new Store(db, cfg, { log, ffmpeg: process.env.GSR_FFMPEG === '' ? null : (process.env.GSR_FFMPEG || 'ffmpeg'), relayer: relayer.enabled() ? relayer : null });
  const vesper = new Vesper(cfg, store, { log });
  const atm = new Atm(cfg.atm, { log, fetch: opts.atmFetch });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let m;
    try {
      // ---- health + catalog ------------------------------------------
      if (p === '/api/health') {
        const f = cfg.free || {};
        const freeOpen = f.mode === 'on' || (f.mode !== 'off' && !stripe.enabled());
        const since = new Date(Date.now() - (f.windowHours || 24) * 3600 * 1000).toISOString();
        return send(res, 200, {
          ok: true,
          payments: stripe.enabled(),
          tower: tower.enabled(),
          npc: cfg.npcName,
          storey: cfg.kax.storey || null,
          floor: { canWrite: Boolean(kax && kax.canWriteFloor()), canSpeak: Boolean(kax && kax.canSpeak()) },
          free: { open: freeOpen, mode: f.mode, grantedInWindow: await orders.freeGrantedSince(since), dailyLimit: f.dailyLimit, maxTier: f.maxTier },
          store: { selling: store.enabled(), releases: (await store.catalog()).length },
        });
      }

      // ---- the record store: finished albums, paid in USDC on Base ---------
      if (p === '/api/store') {
        const releases = await store.catalog();
        return send(res, 200, {
          selling: store.enabled(),
          price: releases.length ? releases[0].price : undefined,
          payTo: store.enabled() ? store.paymentTerms({ publicId: '-', amountMicro: cfg.store.priceMicro }).payTo : null,
          releases: releases.map((r) => publicRelease(r)),
        }, undefined, { 'cache-control': 'public, max-age=60' });
      }
      if ((m = /^\/api\/store\/([a-z0-9-]{1,48})$/.exec(p)) && req.method === 'GET' && m[1] !== 'agent-guide') {
        const r = await store.release(m[1]);
        if (!r) return send(res, 404, { error: 'no such record' });
        return send(res, 200, { selling: store.enabled(), ...publicRelease(r) }, undefined, { 'cache-control': 'public, max-age=60' });
      }
      // Open a purchase. Returns the terms (address, amount, calldata). The
      // same body serves an agent as a 402: send the USDC, then POST the tx.
      if ((m = /^\/api\/store\/([a-z0-9-]{1,48})\/buy$/.exec(p)) && req.method === 'POST') {
        if (!allow(ip, 10)) return send(res, 429, { error: 'slow down' });
        const body = await readJson(req, 4 * 1024);
        const email = typeof body.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ? body.email.trim().slice(0, 200) : undefined;
        const purchase = await store.buy(m[1], { email, fromAddr: typeof body.from === 'string' ? body.from : undefined });
        return send(res, 402, { purchase: publicPurchase(purchase, store, cfg), payment: { ...store.paymentTerms(purchase), gasless: await store.gaslessTerms(purchase) } });
      }
      if ((m = /^\/api\/purchase\/([A-Za-z0-9_-]{16,32})$/.exec(p)) && req.method === 'GET') {
        const purchase = await store.purchase(m[1]);
        if (!purchase) return send(res, 404, { error: 'not found' });
        const rel = await store.release(purchase.sku, { includeUnpublished: true });
        const payment = purchase.state === 'awaiting' ? { ...store.paymentTerms(purchase), gasless: await store.gaslessTerms(purchase) } : null;
        return send(res, 200, { purchase: publicPurchase(purchase, store, cfg), payment, release: rel ? publicRelease(rel) : null });
      }
      // Gasless: the buyer signed the authorization the store issued; the
      // relayer submits it and pays the gas. The chain then settles the
      // purchase exactly as a plain transfer would (watcher or /tx claim).
      if ((m = /^\/api\/purchase\/([A-Za-z0-9_-]{16,32})\/authorize$/.exec(p)) && req.method === 'POST') {
        if (!allow(ip, 10)) return send(res, 429, { error: 'slow down' });
        const purchase = await store.purchase(m[1]);
        if (!purchase) return send(res, 404, { error: 'not found' });
        const body = await readJson(req, 4 * 1024);
        const auth = { from: typeof body.from === 'string' ? body.from : '', signature: typeof body.signature === 'string' ? body.signature : undefined, v: body.v, r: body.r, s: body.s };
        const r = await store.relay(purchase, auth);
        const fresh = await store.purchase(m[1]);
        return send(res, r.ok ? 200 : 409, { ...r, purchase: publicPurchase(fresh, store, cfg) });
      }
      if ((m = /^\/api\/purchase\/([A-Za-z0-9_-]{16,32})\/tx$/.exec(p)) && req.method === 'POST') {
        if (!allow(ip, 40)) return send(res, 429, { error: 'slow down' });
        const purchase = await store.purchase(m[1]);
        if (!purchase) return send(res, 404, { error: 'not found' });
        const body = await readJson(req, 2 * 1024);
        const r = await store.claimTx(purchase, body.hash);
        const fresh = await store.purchase(m[1]);
        return send(res, r.ok ? 200 : 409, { ...r, purchase: publicPurchase(fresh, store, cfg) });
      }
      // The zip, behind a signed, expiring token. The purchase page mints a
      // fresh token on every visit, so the page is the durable link.
      if ((m = /^\/dl\/([A-Za-z0-9_-]{16,32})$/.exec(p))) {
        const purchase = await store.purchase(m[1]);
        if (!purchase || purchase.state !== 'paid') return send(res, 404, 'not found', 'text/plain');
        if (!store.verifyToken(purchase.publicId, url.searchParams.get('t'))) return send(res, 403, 'this download link has expired; open your purchase page for a fresh one', 'text/plain');
        const rel = await store.release(purchase.sku, { includeUnpublished: true });
        const file = rel && path.join(store.dir(rel.sku), rel.zipFile);
        if (!file || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
        const st = fs.statSync(file);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': st.size, 'content-disposition': `attachment; filename="${rel.zipFile}"`, 'cache-control': 'private, no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      // Public files of a release: the cover, a 512 px thumbnail of it (made
      // on first request; the shop's shelves load 39 of these, not 39 full
      // covers), and the previews.
      if ((m = /^\/store\/([a-z0-9-]{1,48})\/(cover\.(?:png|jpg)|cover-512\.jpg|preview-\d{2}\.mp3)$/.exec(p))) {
        const r = await store.release(m[1]);
        if (!r) return send(res, 404, 'not found', 'text/plain');
        let file = path.join(store.dir(r.sku), m[2]);
        if (m[2] === 'cover-512.jpg' && !fs.existsSync(file)) file = (await store.thumbnail(r)) || file;
        if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, fs.readFileSync(file), m[2].endsWith('.mp3') ? 'audio/mpeg' : m[2].endsWith('.jpg') ? 'image/jpeg' : 'image/png', { 'cache-control': 'public, max-age=86400' });
      }

      // ---- Vesper, the clerk ------------------------------------------------
      if (p === '/api/vesper/greeting') {
        const text = vesper.greeting();
        return send(res, 200, { name: vesper.name, reply: text, audio: await vesper.speak(text), voice: vesper.voiceEnabled() });
      }
      if (p === '/api/vesper/say' && req.method === 'POST') {
        if (!allow(ip, 12)) return send(res, 429, { error: 'slow down' });
        const body = await readJson(req, 4 * 1024);
        const text = typeof body.text === 'string' ? body.text.slice(0, MAX_QUESTION) : '';
        const about = typeof body.about === 'string' && /^[a-z0-9-]{1,48}$/.test(body.about) ? body.about : undefined;
        const a = await vesper.answer(text, { about });
        const audio = body.voice === false ? null : await vesper.speak(a.reply);
        return send(res, 200, { name: vesper.name, reply: a.reply, source: a.source, audio });
      }
      if ((m = /^\/vesper\/voice\/([a-f0-9]{24}\.mp3)$/.exec(p))) {
        const f = vesper.voiceFile(m[1]);
        if (!f) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, fs.readFileSync(f), 'audio/mpeg', { 'cache-control': 'public, max-age=604800' });
      }
      // How an agent buys: the same terms a browser gets, written down once.
      if (p === '/api/store/agent-guide') {
        return send(res, 200, {
          store: 'Ghost Signals Records',
          catalog: `${cfg.publicUrl}/api/store`,
          steps: [
            `GET ${cfg.publicUrl}/api/store and pick a sku.`,
            `POST ${cfg.publicUrl}/api/store/<sku>/buy with JSON {"from": "<your wallet address>", "email": "<optional>"}; the 402 reply carries payment.payTo, payment.amountMicro, payment.asset (USDC on Base, chain 8453) and payment.calldata for the transfer.`,
            'Either send exactly that amount of USDC to payTo from the wallet you named (you pay the gas), or, with no ETH at all: sign payment.gasless.typedData (EIP-712, your address in message.from) with eth_signTypedData_v4 and POST {"from", "signature"} to payment.gasless.submitUrl; the store submits it and pays the gas. payment.gasless.enabled is false when the relayer is off or dry.',
            `POST ${cfg.publicUrl}/api/purchase/<publicId>/tx with {"hash": "<tx hash>"} (or wait: the store watches the chain and settles on its own).`,
            `GET ${cfg.publicUrl}/api/purchase/<publicId>: when state is "paid", purchase.download is your zip (mp3s, cover art, README).`,
          ],
          rules: ['One transfer pays for one purchase. A transfer mined before the purchase was opened does not count.', 'Downloads are for personal listening; see README.txt in the zip.'],
        }, undefined, { 'cache-control': 'public, max-age=3600' });
      }
      if ((m = /^\/vendor\/([a-z0-9][a-z0-9.-]{0,60}\.js)$/.exec(p))) {
        const f = path.join(PUBLIC, 'vendor', m[1]);
        if (!fs.existsSync(f)) return html(res, 404, 'notfound.html');
        return send(res, 200, fs.readFileSync(f), 'application/javascript; charset=utf-8', { 'cache-control': 'public, max-age=604800' });
      }
      if (p === '/store' || p === '/store/') return html(res, 200, 'store.html');
      if (p === '/store/list') return html(res, 200, 'store-list.html');
      // ---- the USDC ATM ------------------------------------------------------
      if (p === '/atm' || p === '/atm/') return html(res, 200, 'atm.html');
      if (p === '/api/atm') return send(res, 200, atm.config(), undefined, { 'cache-control': 'public, max-age=60' });
      if (p === '/api/atm/session' && req.method === 'POST') {
        if (!allow(ip, 6)) return send(res, 429, { error: 'slow down' });
        const body = await readJson(req, 2 * 1024);
        const r = await atm.session({ address: typeof body.address === 'string' ? body.address : '', amount: body.amount, currency: typeof body.currency === 'string' ? body.currency : undefined, ip });
        return send(res, r.ok ? 200 : 503, r);
      }
      // The swap desk: an indicative price (GET) or a firm, sendable quote
      // (POST, with the taker's address). The 0x key never leaves this process.
      if (p === '/api/atm/swap' && (req.method === 'GET' || req.method === 'POST')) {
        if (!allow(ip, 20)) return send(res, 429, { error: 'slow down' });
        const body = req.method === 'POST' ? await readJson(req, 2 * 1024) : Object.fromEntries(url.searchParams);
        const r = await atm.swapQuote({ sellToken: body.sellToken, sellAmount: body.sellAmount, taker: typeof body.taker === 'string' ? body.taker : undefined, firm: req.method === 'POST' });
        return send(res, r.ok ? 200 : (r.reason === 'swap_not_configured' ? 503 : 400), r);
      }
      if ((m = /^\/store\/([a-z0-9-]{1,48})$/.exec(p))) {
        const r = await store.release(m[1]);
        if (!r) return html(res, 404, 'notfound.html');
        return html(res, 200, 'release.html', { SKU: esc(r.sku), TITLE: esc(r.title), PID: '' });
      }
      if ((m = /^\/p\/([A-Za-z0-9_-]{16,32})$/.exec(p))) {
        const purchase = await store.purchase(m[1]);
        const r = purchase && await store.release(purchase.sku, { includeUnpublished: true });
        if (!r) return html(res, 404, 'notfound.html');
        return html(res, 200, 'release.html', { SKU: esc(r.sku), TITLE: esc(r.title), PID: esc(purchase.publicId) });
      }
      if (p === '/api/credits') {
        const c = suno ? await suno.credits() : null;
        return send(res, 200, { credits: c, perTrackEstimate: (cfg.free || {}).creditsPerTrack, floor: (cfg.free || {}).minCredits });
      }
      if (p === '/api/catalog') return send(res, 200, { tiers: Object.values(TIERS).map((t) => ({ ...t, priceCents: cfg.prices[t.key] })), currency: cfg.currency, palette: PALETTE.map(({ key, label }) => ({ key, label })), artDirections: ART_DIRECTIONS, freeOpen: desk.freeDoorOpen(), freeMaxTier: (cfg.free || {}).maxTier });

      // ---- the desk, on the web -----------------------------------------
      if (p === '/api/desk' && req.method === 'POST') {
        if (!allow(ip)) return send(res, 429, { error: 'slow down' });
        const body = await readJson(req, 16 * 1024);
        let sid = cookie(req) || (typeof body.session === 'string' ? body.session : null);
        let session = sid ? await orders.sessionById(sid) : null;
        if (!session) {
          session = await orders.newSession(null, 'web');
          sid = session.id;
        }
        const setCookie = { 'set-cookie': `gsr=${sid}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure` };
        if (body.reset) { session = await orders.newSession(null, 'web'); return send(res, 200, { session: session.id, reply: desk.opening(session), step: session.state.step }, undefined, { 'set-cookie': `gsr=${session.id}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure` }); }
        if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 200, { session: sid, reply: desk.opening(session), step: session.state.step }, undefined, setCookie);
        const email = typeof body.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ? body.email.trim().slice(0, 200) : undefined;
        const r = await desk.turn(session, body.text.slice(0, 4000), { principal: null, origin: 'web', email });
        return send(res, 200, { session: sid, reply: r.reply, step: r.session.state.step, brief: r.session.state.brief, order: r.order ? { publicId: r.order.publicId, state: r.order.state, checkoutUrl: r.order.checkoutUrl, priceCents: r.order.priceCents } : null }, undefined, setCookie);
      }

      // ---- the shelf: albums whose buyers chose to show them ---------------
      if (p === '/api/showcase') {
        const rows = await orders.featured(24);
        return send(res, 200, {
          albums: rows.map(({ order: o, tracks }) => ({
            publicId: o.publicId,
            album: o.brief.albumTitle,
            tier: o.tierLabel,
            theme: o.brief.theme,
            style: o.brief.style,
            note: o.shareNote || null,
            deliveredAt: o.deliveredAt,
            cover: fs.existsSync(path.join(orderDir(o), 'cover.png')) ? `/album/${o.publicId}/file/cover.png` : null,
            radioTrack: o.radioTrackIdx === null || o.radioTrackIdx === undefined ? null : o.radioTrackIdx + 1,
            radioAired: Boolean(o.radioAiredAt),
            tracks: tracks.filter((t) => t.file).map((t) => ({
              n: t.idx + 1, title: t.title, duration: t.duration_sec,
              file: `/album/${o.publicId}/file/${encodeURIComponent(t.file)}`,
            })),
          })),
        });
      }

      // ---- an order's public state + files ----------------------------------
      if ((m = /^\/api\/album\/([A-Za-z0-9_-]{16,32})$/.exec(p))) {
        const o = await orders.getByPublicId(m[1]);
        if (!o) return send(res, 404, { error: 'not found' });
        const tracks = await orders.tracks(o.id);
        return send(res, 200, { publicId: o.publicId, state: o.state, album: o.brief.albumTitle, tier: o.tierLabel, tracks: tracks.map((t) => ({ n: t.idx + 1, title: t.title, status: t.status, file: t.file ? `/album/${o.publicId}/file/${encodeURIComponent(t.file)}` : null, duration: t.duration_sec })), cover: fs.existsSync(path.join(orderDir(o), 'cover.png')) ? `/album/${o.publicId}/file/cover.png` : null, checkoutUrl: o.state === 'quoted' ? o.checkoutUrl : null, deliveredAt: o.deliveredAt, featured: Boolean(o.featuredAt), note: o.shareNote || null, radioTrack: o.radioTrackIdx === null || o.radioTrackIdx === undefined ? null : o.radioTrackIdx + 1, radioAired: Boolean(o.radioAiredAt) });
      }
      // The buyer's two decisions. Knowing the album's link is the capability:
      // the same thing that lets you play it lets you share it or spend its
      // spin. Both are reversible except an airing that already happened.
      if ((m = /^\/api\/album\/([A-Za-z0-9_-]{16,32})\/(feature|radio)$/.exec(p)) && req.method === 'POST') {
        if (!allow(ip, 20)) return send(res, 429, { error: 'slow down' });
        const o = await orders.getByPublicId(m[1]);
        if (!o) return send(res, 404, { error: 'not found' });
        if (o.state !== 'delivered') return send(res, 409, { error: 'the record is not finished yet' });
        const body = await readJson(req, 8 * 1024);
        if (m[2] === 'feature') {
          const on = body.on !== false;
          const ok = await orders.setFeatured(o.id, on, body.note);
          return send(res, ok ? 200 : 409, { ok, featured: on });
        }
        if (o.radioAiredAt) return send(res, 409, { error: 'that record has had its spin' });
        const n = Number(body.track);
        const tracks = await orders.tracks(o.id);
        if (!Number.isInteger(n) || n < 1 || n > tracks.length || !tracks[n - 1].file) return send(res, 400, { error: `track must be 1 to ${tracks.length}` });
        const ok = await orders.requestRadio(o.id, n - 1);
        if (ok) {
          log(`radio spin requested: ${o.publicId} track ${n} (${tracks[n - 1].title})`);
          // The spin needs a person to put it on the air, so tell one.
          if (cfg.mail.operator) {
            smtpSend(cfg.mail, {
              to: cfg.mail.operator,
              subject: `[records] radio spin: ${o.brief.albumTitle}, track ${n}`,
              text: `"${tracks[n - 1].title}" from "${o.brief.albumTitle}" is queued for its single airing.

`
                + `File: ${path.join(orderDir(o), tracks[n - 1].file)}
`
                + `Album: ${cfg.publicUrl}/album/${o.publicId}
`
                + `Queue: GET /admin/radio/queue
`
                + `When it has aired: POST /admin/orders/${o.id}/radio/aired
`,
            }).catch(() => {});
          }
        }
        return send(res, ok ? 200 : 409, { ok, track: n, title: tracks[n - 1].title });
      }

      if ((m = /^\/album\/([A-Za-z0-9_-]{16,32})\/file\/([^/]+)$/.exec(p))) {
        const o = await orders.getByPublicId(m[1]);
        if (!o || !['building', 'delivered'].includes(o.state)) return send(res, 404, 'not found', 'text/plain');
        const name = decodeURIComponent(m[2]);
        if (name.includes('/') || name.includes('..')) return send(res, 400, 'bad name', 'text/plain');
        const file = path.join(orderDir(o), name);
        if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
        const type = name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        const data = fs.readFileSync(file);
        return send(res, 200, data, type, { 'content-disposition': url.searchParams.has('dl') ? `attachment; filename="${name.replace(/"/g, '')}"` : 'inline', 'cache-control': 'private, max-age=3600' });
      }
      if ((m = /^\/album\/([A-Za-z0-9_-]{16,32})$/.exec(p))) {
        const o = await orders.getByPublicId(m[1]);
        if (!o) return html(res, 404, 'notfound.html');
        return html(res, 200, 'album.html', { PUBLIC_ID: esc(o.publicId), TITLE: esc(o.brief.albumTitle) });
      }

      // ---- webhooks ---------------------------------------------------------
      if (p === '/api/stripe/webhook' && req.method === 'POST') {
        const raw = await readBody(req, 1 << 20);
        const r = await stripe.webhook(raw, req.headers['stripe-signature']);
        return send(res, r.status, r.body, 'text/plain');
      }
      if (p === '/api/suno/callback' && req.method === 'POST') {
        await readBody(req, 1 << 20); // the worker polls; the callback is acknowledged and dropped
        return send(res, 200, { ok: true });
      }
      if (p === '/api/tower/events' && req.method === 'POST') {
        const raw = await readBody(req, 256 * 1024);
        const r = await tower.receive(raw, req.headers['x-tower-signature']);
        return send(res, r.status, r.body, 'text/plain');
      }

      // ---- admin (bearer ADMIN token) ----------------------------------------
      if (p.startsWith('/admin/')) {
        const auth = req.headers.authorization || '';
        if (!cfg.adminToken || auth !== `Bearer ${cfg.adminToken}`) return send(res, cfg.adminToken ? 401 : 503, { error: cfg.adminToken ? 'unauthorized' : 'admin token not set' });
        if (p === '/admin/orders' && req.method === 'GET') return send(res, 200, { orders: await orders.recent(100) });
        // The gasless relayer: its address and float, and whether it will relay now.
        if (p === '/admin/relayer' && req.method === 'GET') return send(res, 200, relayer.enabled() ? await relayer.status() : { enabled: false, reason: 'no_key' });
        if (p === '/admin/radio/queue' && req.method === 'GET') {
          const q = await orders.radioQueue();
          return send(res, 200, {
            queue: await Promise.all(q.map(async (o) => {
              const t = (await orders.tracks(o.id))[o.radioTrackIdx];
              return { orderId: o.id, publicId: o.publicId, album: o.brief.albumTitle, track: o.radioTrackIdx + 1, title: t && t.title, file: t && path.join(orderDir(o), t.file), requestedAt: o.radioRequestedAt };
            })),
          });
        }
        if ((m = /^\/admin\/orders\/([0-9a-f-]{36})\/radio\/aired$/.exec(p)) && req.method === 'POST') {
          return send(res, 200, { ok: await orders.markRadioAired(m[1]) });
        }
        if ((m = /^\/admin\/orders\/([0-9a-f-]{36})\/(comp|retry|cancel)$/.exec(p)) && req.method === 'POST') {
          const o = await orders.get(m[1]);
          if (!o) return send(res, 404, { error: 'not found' });
          if (m[2] === 'comp') return send(res, 200, await orders.comp(o, 'admin'));
          if (m[2] === 'retry') return send(res, 200, { ok: await orders.requeue(o.id) });
          if (m[2] === 'cancel') return send(res, 200, { ok: await orders.move(o.id, o.state, 'cancelled') });
        }
        if ((m = /^\/admin\/orders\/([0-9a-f-]{36})\/track\/(\d+)\/rebuild$/.exec(p)) && req.method === 'POST') {
          // A delivered order goes back to the floor for one track; the worker
          // resumes and skips every finished track.
          const o = await orders.get(m[1]);
          if (!o || o.state !== 'delivered') return send(res, 404, { error: 'no such delivered order' });
          const idx = parseInt(m[2], 10) - 1;
          const tr = (await orders.tracks(o.id)).find((t) => t.idx === idx);
          if (!tr || !(await orders.trackReset(o.id, idx))) return send(res, 404, { error: 'no such track' });
          const old = path.join(orderDir(o), `${String(idx + 1).padStart(2, '0')} - ${safeName(tr.title)}.mp3`);
          if (fs.existsSync(old)) fs.renameSync(old, old.replace(/\.mp3$/, `.previous-${Date.now()}.mp3`));
          await orders.db.run('UPDATE orders SET state=?, updated_at=? WHERE id=? AND state=?', ['paid', new Date().toISOString(), o.id, 'delivered']);
          return send(res, 200, { ok: true, track: idx + 1 });
        }
        if ((m = /^\/admin\/orders\/([0-9a-f-]{36})\/cover$/.exec(p)) && req.method === 'POST') {
          const o = await orders.get(m[1]);
          if (!o || !['building', 'delivered'].includes(o.state)) return send(res, 404, { error: 'no such buildable order' });
          const dir = orderDir(o);
          const f = path.join(dir, 'cover.png');
          if (fs.existsSync(f)) fs.renameSync(f, path.join(dir, `cover.previous-${Date.now()}.png`));
          const atelier = cfg.obc.jwt ? new Atelier({ ...cfg.obc, userAgent: cfg.userAgent }) : null;
          const source = await buildCover(o, atelier);
          return send(res, 200, { ok: source !== 'placeholder', source });
        }
        // The store's admin: publish a finished album from files on this
        // machine, list sales, give one away, nudge the chain watcher.
        if (p === '/admin/releases' && req.method === 'POST') return send(res, 200, await store.publish(await readJson(req, 64 * 1024)));
        if ((m = /^\/admin\/releases\/([a-z0-9-]{1,48})\/unpublish$/.exec(p)) && req.method === 'POST') return send(res, 200, { ok: await store.unpublish(m[1]) });
        if (p === '/admin/purchases' && req.method === 'GET') return send(res, 200, { purchases: await store.purchases(), unmatched: await store.unmatched() });
        if ((m = /^\/admin\/purchases\/([0-9a-f-]{36})\/comp$/.exec(p)) && req.method === 'POST') {
          const purchase = await store.purchaseById(m[1]);
          if (!purchase) return send(res, 404, { error: 'not found' });
          return send(res, 200, await store.comp(purchase, 'admin'));
        }
        if (p === '/admin/store/scan' && req.method === 'POST') return send(res, 200, await store.scan());
        if (p === '/admin/panel' && req.method === 'POST' && kax) { const body = await readJson(req); return send(res, 200, await kax.panel(body)); }
        if (p === '/admin/tower/webhook' && req.method === 'POST' && kax) {
          const body = await readJson(req);
          const url = typeof body.url === 'string' && body.url ? body.url : `${cfg.publicUrl}/api/tower/events`;
          const r = await kax.registerWebhook(url);
          // The secret is shown once by the tower; it is the operator's to
          // place in the env file. Never logged, never stored here.
          return send(res, r.status === 200 ? 200 : 502, { url, ...r.json });
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---- static pages -------------------------------------------------------
      if (p === '/' || p === '/desk') return html(res, 200, 'index.html', { NPC: esc(cfg.npcName) });
      if (p === '/desk/') return send(res, 301, '', 'text/plain', { location: '/desk' });
      if (/^\/[a-z0-9-]+\.(css|js)$/.test(p)) {
        const f = path.join(PUBLIC, p.slice(1));
        if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), p.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      }
      return html(res, 404, 'notfound.html');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log(`error ${req.method} ${p}: ${e.stack || e.message}`);
      return send(res, status, { error: status >= 500 ? 'internal error' : e.message });
    }
  });

  server.on('close', () => { store.stop(); db.close(); });
  await new Promise((resolve) => server.listen(cfg.port, cfg.bind, resolve));
  store.start();
  log(`listening on ${cfg.bind}:${server.address().port}; payments ${stripe.enabled() ? 'on' : 'OFF (503)'}; store ${store.enabled() ? 'selling (USDC on Base)' : 'catalog only'}; tower ${tower.enabled() ? 'on' : 'OFF (503)'}; kax agent ${kax ? 'on' : 'off'}; brain ${cfg.brain.key ? 'on' : 'off'}`);
  server.store = store;
  return server;
}

/** A release as the public sees it: files by URL, never by path. */
function publicRelease(r) {
  return {
    sku: r.sku, title: r.title, artist: r.artist, year: r.year, blurb: r.blurb, price: r.price, priceMicro: String(r.priceMicro),
    cover: r.coverFile ? `/store/${r.sku}/${r.coverFile}` : null, zipBytes: r.zipBytes,
    tracks: r.tracks.map((t) => ({ n: t.n, title: t.title, duration: t.duration, preview: t.preview ? `/store/${r.sku}/${t.preview}` : null })),
    url: `/store/${r.sku}`,
  };
}

function publicPurchase(p, store, cfg) {
  return {
    publicId: p.publicId, sku: p.sku, state: p.state, amount: microToUsdc(p.amountMicro),
    from: p.fromAddr, txHash: p.txHash, paidAt: p.paidAt, createdAt: p.createdAt,
    page: `${cfg.publicUrl}/p/${p.publicId}`,
    download: p.state === 'paid' ? `${cfg.publicUrl}/dl/${p.publicId}?t=${store.downloadToken(p.publicId)}` : null,
  };
}

if (require.main === module) main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });

module.exports = { main, allow };
