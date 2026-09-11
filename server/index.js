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
const { Atelier } = require('./art');

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
  const suno = cfg.suno.key ? new Suno({ ...cfg.suno, userAgent: cfg.userAgent }) : null;
  const desk = new Desk(cfg, orders, stripe, log, suno);
  const kax = (cfg.kax.agentToken || cfg.kax.towerCredential) && cfg.kax.storey ? new Kax({ ...cfg.kax, userAgent: cfg.userAgent }) : null;
  const tower = new Tower(cfg, db, orders, desk, kax, log);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
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
        });
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
      let m;
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
        if (ok) log(`radio spin requested: ${o.publicId} track ${n} (${tracks[n - 1].title})`);
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

  server.on('close', () => db.close());
  await new Promise((resolve) => server.listen(cfg.port, cfg.bind, resolve));
  log(`listening on ${cfg.bind}:${server.address().port}; payments ${stripe.enabled() ? 'on' : 'OFF (503)'}; tower ${tower.enabled() ? 'on' : 'OFF (503)'}; kax agent ${kax ? 'on' : 'off'}; brain ${cfg.brain.key ? 'on' : 'off'}`);
  return server;
}

if (require.main === module) main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });

module.exports = { main, allow };
