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
const { orderDir } = require('./worker');

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

async function main() {
  const db = await new Db(path.join(cfg.dataDir, 'records.sqlite')).open();
  const orders = new Orders(db, cfg);
  const stripe = new Stripe(cfg, orders, log);
  const desk = new Desk(cfg, orders, stripe, log);
  const kax = cfg.kax.agentToken && cfg.kax.storey ? new Kax({ ...cfg.kax, userAgent: cfg.userAgent }) : null;
  const tower = new Tower(cfg, db, orders, desk, kax, log);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      // ---- health + catalog ------------------------------------------
      if (p === '/api/health') return send(res, 200, { ok: true, payments: stripe.enabled(), tower: tower.enabled(), npc: cfg.npcName, storey: cfg.kax.storey || null });
      if (p === '/api/catalog') return send(res, 200, { tiers: Object.values(TIERS).map((t) => ({ ...t, priceCents: cfg.prices[t.key] })), currency: cfg.currency, palette: PALETTE.map(({ key, label }) => ({ key, label })), artDirections: ART_DIRECTIONS });

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

      // ---- an order's public state + files ----------------------------------
      let m;
      if ((m = /^\/api\/album\/([A-Za-z0-9_-]{16,32})$/.exec(p))) {
        const o = await orders.getByPublicId(m[1]);
        if (!o) return send(res, 404, { error: 'not found' });
        const tracks = await orders.tracks(o.id);
        return send(res, 200, { publicId: o.publicId, state: o.state, album: o.brief.albumTitle, tier: o.tierLabel, tracks: tracks.map((t) => ({ n: t.idx + 1, title: t.title, status: t.status, file: t.file ? `/album/${o.publicId}/file/${encodeURIComponent(t.file)}` : null, duration: t.duration_sec })), cover: fs.existsSync(path.join(orderDir(o), 'cover.png')) ? `/album/${o.publicId}/file/cover.png` : null, checkoutUrl: o.state === 'quoted' ? o.checkoutUrl : null, deliveredAt: o.deliveredAt });
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
        if ((m = /^\/admin\/orders\/([0-9a-f-]{36})\/(comp|retry|cancel)$/.exec(p)) && req.method === 'POST') {
          const o = await orders.get(m[1]);
          if (!o) return send(res, 404, { error: 'not found' });
          if (m[2] === 'comp') return send(res, 200, await orders.comp(o, 'admin'));
          if (m[2] === 'retry') return send(res, 200, { ok: await orders.requeue(o.id) });
          if (m[2] === 'cancel') return send(res, 200, { ok: await orders.move(o.id, o.state, 'cancelled') });
        }
        if (p === '/admin/panel' && req.method === 'POST' && kax) { const body = await readJson(req); return send(res, 200, await kax.panel(body)); }
        return send(res, 404, { error: 'not found' });
      }

      // ---- static pages -------------------------------------------------------
      if (p === '/' || p === '/desk') return html(res, 200, 'index.html', { NPC: esc(cfg.npcName) });
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

  server.on('close', () => db.close());
  await new Promise((resolve) => server.listen(cfg.port, cfg.bind, resolve));
  log(`listening on ${cfg.bind}:${server.address().port}; payments ${stripe.enabled() ? 'on' : 'OFF (503)'}; tower ${tower.enabled() ? 'on' : 'OFF (503)'}; kax agent ${kax ? 'on' : 'off'}; brain ${cfg.brain.key ? 'on' : 'off'}`);
  return server;
}

if (require.main === module) main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });

module.exports = { main, allow };
