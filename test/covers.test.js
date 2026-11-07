'use strict';
// The cover queue: kannaka-art paints on a GPU elsewhere, this server leases
// jobs to the runner and takes the pictures back. Nothing here may block or
// fail an order; every failure ends in one of our own sleeves.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-c-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PORT = '0';
process.env.GSR_BIND = '127.0.0.1';
process.env.GSR_ADMIN_TOKEN = 'adm';
process.env.GSR_COVER_TOKEN = 'cov-secret';
process.env.GSR_PUBLIC_URL = 'https://records.test';
const cfg = require('../server/config');
const { Db } = require('../server/db');
const { Orders } = require('../server/orders');
const { Covers, ffmpegCrop } = require('../server/covers');
const art = require('../server/art');
const { ART_DIRECTIONS } = require('../server/catalog');
const worker = require('../server/worker');
const { main } = require('../server/index');

// kannaka_art.py _FORBIDDEN_RE, copied by hand: the planner refuses a whole
// batch for one subject that matches it.
const PLANNER_RE = /\b(texts?|logos?|letters?|words?|signs?|signage|signposts?)\b/i;

// ---- PNG fixtures -----------------------------------------------------------
function crc32(buf) {
  let c; const t = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A grayscale PNG; `noise` makes it incompressible (a big file), else flat (tiny). */
function png(w, h, { noise = true, seed = 1 } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  if (noise) { const r = crypto.createHash('sha256').update(String(seed)).digest(); crypto.randomFillSync(raw); raw[1] = r[0]; }
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
const BIG = png(1024, 1024, { seed: 1 });
const BIG2 = png(1024, 1024, { seed: 2 });
/** Stands in for ffmpeg: writes a valid 1024 px PNG and remembers the call. */
const crops = [];
const fakeCrop = async (src, dst) => { crops.push(src); fs.writeFileSync(dst, png(1024, 1024, { seed: crops.length + 100 })); };

const BRIEF = { theme: 'a lighthouse keeper who stops writing letters to his sister', style: 'ambient electronica', tier: 'ep', albumTitle: 'The Last Word Sign', trackTitles: ['One', 'Two', 'Three', 'Four'], artDirection: '' };

async function fresh(name, coverOpts = {}) {
  const db = await new Db(path.join(tmp, `${name}.sqlite`)).open();
  const orders = new Orders(db, cfg);
  const covers = new Covers(db, cfg, { crop: fakeCrop, ...coverOpts });
  return { db, orders, covers };
}
async function claimedOrder(orders, brief = BRIEF) {
  const o = await orders.createFromBrief(brief, { origin: 'web', email: 'buyer@example.org' });
  await orders.comp(o, 'test');
  return orders.claimNextBuild();
}

// ---- the subject ------------------------------------------------------------
test('the cover subject never carries the title, a planner-refused word, a face, or "album cover"; it always asks for a silhouette; <= 300 chars', () => {
  const s = art.coverSubject(BRIEF);
  assert.doesNotMatch(s, PLANNER_RE);
  assert.doesNotMatch(s, /Last Word|album cover|poster|typography|"/i);
  assert.match(s, /faceless silhouette$/);
  assert.ok(s.length <= art.MAX_SUBJECT);
  const long = art.coverSubject({ theme: 'x '.repeat(400) + 'text letters logo signs signage words', artDirection: 'a poster with typography and a portrait face, '.repeat(10) });
  assert.ok(long.length <= 300, `${long.length}`);
  assert.match(long, /faceless silhouette$/, 'the silhouette clause survives the cut');
  assert.doesNotMatch(long, PLANNER_RE);
  assert.doesNotMatch(long, /portrait|\bface\b|poster|typography/i);
  for (const d of ART_DIRECTIONS) assert.doesNotMatch(art.coverSubject({ theme: 'rain', artDirection: d }), PLANNER_RE, d);
  // The art's own copy of the regex agrees with the planner's.
  for (const w of ['text', 'Texts', 'logo', 'letters', 'word', 'sign', 'signage', 'signposts']) assert.deepEqual(art.plannerForbidden(`a ${w} here`), [w.toLowerCase()]);
  assert.deepEqual(art.plannerForbidden('Ghost Signals by design'), []);
});

test('a theme asking for explicit or violent imagery is dropped; the art direction paints alone', () => {
  const s = art.coverSubject({ theme: 'a naked woman covered in blood', artDirection: 'ink and gold leaf on dark paper' });
  assert.doesNotMatch(s, /naked|blood|woman/);
  assert.match(s, /^ink and gold leaf on dark paper, a quiet landscape at dusk/);
  const d = art.coverSubject({ theme: 'rain on a tin roof', artDirection: 'explicit erotic photograph' });
  assert.match(d, /^painted, textured brushwork/);
  assert.match(d, /rain on a tin roof/);
});

test('a house sleeve is the same for the same order, from the label pool only', () => {
  const files = ['h01.png', 'h02.png', 'h03.png', 'h04.png'];
  assert.equal(art.pickHouseSleeve('order-a', files), art.pickHouseSleeve('order-a', [...files].reverse()));
  assert.equal(art.pickHouseSleeve('x', []), null);
  const seen = new Set(Array.from({ length: 40 }, (_, i) => art.pickHouseSleeve(`o${i}`, files)));
  assert.ok(seen.size > 1);
});

// ---- the queue --------------------------------------------------------------
test('lease hands out only what the painter needs, expires, and is leasable again; release costs no attempt, fail does', async () => {
  const { db, orders, covers } = await fresh('lease');
  const o = await claimedOrder(orders);
  await covers.enqueue(o);
  await covers.enqueue(o); // a rebuild re-claims: still one job
  assert.equal((await db.all('SELECT * FROM cover_jobs')).length, 1);
  const t0 = new Date('2030-01-01T00:00:00Z');
  const [j] = await covers.lease(8, t0);
  assert.deepEqual(Object.keys(j).sort(), ['attempt', 'gen', 'jobId', 'leaseId', 'subject']);
  assert.doesNotMatch(JSON.stringify(j), /buyer@example|Last Word|lighthouse keeper who stops writing letters/);
  assert.equal((await covers.lease(8, new Date(t0.getTime() + 60 * 60000))).length, 0, 'held for 90 minutes');
  const [again] = await covers.lease(8, new Date(t0.getTime() + 91 * 60000));
  assert.equal(again.jobId, j.jobId, 'an expired lease goes back to the queue');
  assert.notEqual(again.leaseId, j.leaseId);
  assert.equal(await covers.release(j.jobId, { gen: 0, leaseId: j.leaseId }), false, 'the old holder cannot release a re-leased job');
  assert.equal(await covers.release(again.jobId, { gen: 0, leaseId: again.leaseId }), true);
  let row = await covers.get(o.id);
  assert.equal(row.state, 'queued'); assert.equal(row.attempts, 0);
  const [third] = await covers.lease(8);
  assert.equal(await covers.fail(third.jobId, { gen: 0, leaseId: third.leaseId, reason: 'no passing candidate' }), true);
  row = await covers.get(o.id);
  assert.equal(row.attempts, 1); assert.equal(row.state, 'queued');
  await db.close();
});

test('cancelled and refunded orders are never leased', async () => {
  const { db, orders, covers } = await fresh('cancel');
  const a = await claimedOrder(orders);
  await covers.enqueue(a);
  await db.run('UPDATE orders SET refunded_at=? WHERE id=?', [new Date().toISOString(), a.id]);
  assert.equal((await covers.lease(8)).length, 0);
  await db.run('UPDATE orders SET refunded_at=NULL WHERE id=?', [a.id]);
  assert.equal(await covers.cancel(a.id), true);
  assert.equal((await covers.lease(8)).length, 0);
  await db.close();
});

test('ingest refuses a bad signature, wrong dimensions, a tiny file, a stale generation; crops; a repeat is a no-op and other bytes are a 409', async () => {
  const { db, orders, covers } = await fresh('ingest');
  const o = await claimedOrder(orders);
  await covers.enqueue(o);
  const [j] = await covers.lease(8);
  const up = (body, gen = 0) => covers.ingest(j.jobId, { gen, body, meta: 'abc123|42|gpu-l4' });
  assert.equal((await up(Buffer.from('GIF89a not a png at all, nope, not even close'))).body.reason, 'not_png');
  assert.equal((await up(png(1024, 768))).body.reason, 'bad_dimensions');
  assert.equal((await up(png(512, 512))).body.reason, 'bad_dimensions');
  assert.equal((await up(png(1024, 1024, { noise: false }))).body.reason, 'too_small');
  assert.equal((await up(BIG, 1)).status, 409, 'another generation');
  assert.equal((await covers.ingest('0000000000000000', { gen: 0, body: BIG })).status, 404);
  const n = crops.length;
  const r = await up(BIG);
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(crops.length, n + 1, 'the crop ran');
  const dir = covers.orderDir(o.publicId);
  assert.ok(fs.existsSync(path.join(dir, 'cover.png')));
  assert.match(fs.readFileSync(path.join(dir, 'cover.meta'), 'utf8'), /^kannaka-art\|abc123\|42\|gpu-l4\|[0-9a-f]{64}$/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /upload|incoming|tmp/.test(f)), [], 'no temp files left');
  const before = fs.readFileSync(path.join(dir, 'cover.png'));
  const again = await up(BIG);
  assert.equal(again.status, 200); assert.equal(again.body.already, true);
  assert.equal(crops.length, n + 1, 'a repeat is not cropped again');
  assert.equal((await up(BIG2)).status, 409, 'different bytes never replace a done cover');
  assert.ok(fs.readFileSync(path.join(dir, 'cover.png')).equals(before));
  const row = await covers.get(o.id);
  assert.equal(row.state, 'done'); assert.equal(row.source, 'kannaka-art'); assert.equal(row.lease_id, null);
  await db.close();
});

test('a repeat upload after a crash between the state change and the rename puts the file in place', async () => {
  const { db, orders, covers } = await fresh('heal');
  const o = await claimedOrder(orders);
  await covers.enqueue(o);
  const [j] = await covers.lease(8);
  assert.equal((await covers.ingest(j.jobId, { gen: 0, body: BIG, meta: 'p|1|x' })).status, 200);
  const dir = covers.orderDir(o.publicId);
  fs.unlinkSync(path.join(dir, 'cover.png')); fs.unlinkSync(path.join(dir, 'cover.meta')); // as if the process died
  const r = await covers.ingest(j.jobId, { gen: 0, body: BIG, meta: 'p|1|x' });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'cover.png')));
  assert.equal(fs.readFileSync(path.join(dir, 'cover.meta'), 'utf8'), (await covers.get(o.id)).meta);
  await db.close();
});

test('a late upload is accepted after the lease expired, and upgrades a house sleeve', async () => {
  const houseDir = path.join(tmp, 'house-late'); fs.mkdirSync(houseDir, { recursive: true });
  fs.writeFileSync(path.join(houseDir, 'gsr-house-01.png'), png(1024, 1024, { seed: 77 }));
  const { db, orders, covers } = await fresh('late');
  covers.c = { ...covers.c, houseDir, deadlineHours: 8 };
  const o = await claimedOrder(orders);
  await covers.enqueue(o);
  const [j] = await covers.lease(8);
  // Nine hours later the sweep gives it a house sleeve, the lease long gone.
  const swept = await covers.sweep(new Date(Date.now() + 9 * 3600000));
  assert.equal(swept.length, 1); assert.equal(swept[0].house, 'gsr-house-01.png');
  assert.equal((await covers.get(o.id)).state, 'house');
  const dir = covers.orderDir(o.publicId);
  assert.match(fs.readFileSync(path.join(dir, 'cover.meta'), 'utf8'), /^house\|gsr-house-01\.png\|/);
  const r = await covers.ingest(j.jobId, { gen: 0, body: BIG, meta: 'p|2|gpu-a10' });
  assert.equal(r.status, 200); assert.equal(r.upgradedHouse, true);
  assert.equal((await covers.get(o.id)).source, 'kannaka-art');
  assert.ok(fs.readdirSync(dir).some((f) => /^cover\.previous-\d+\.png$/.test(f)), 'the house sleeve is kept beside it');
  assert.equal((await covers.sweep(new Date(Date.now() + 99 * 3600000))).length, 0, 'a done cover is never swept');
  await db.close();
});

test('the sweep: attempts and "too small" twice end in a house sleeve; without a pool the job just waits; never another album cover', async () => {
  const houseDir = path.join(tmp, 'house-sweep'); fs.mkdirSync(houseDir, { recursive: true });
  const { db, orders, covers } = await fresh('sweep');
  covers.c = { ...covers.c, houseDir: path.join(tmp, 'no-such-dir') };
  const a = await claimedOrder(orders); await covers.enqueue(a);
  const b = await claimedOrder(orders); await covers.enqueue(b);
  const ja = (await covers.get(a.id)).job_id;
  const jb = (await covers.get(b.id)).job_id;
  // One tick each: lease everything, fail the one job, release the rest.
  const round = async (jobId, how) => {
    const got = await covers.lease(8);
    for (const x of got) {
      if (x.jobId === jobId) await covers.fail(x.jobId, { gen: 0, leaseId: x.leaseId, ...how });
      else await covers.release(x.jobId, { gen: 0, leaseId: x.leaseId });
    }
  };
  for (let i = 0; i < 3; i++) await round(ja, { reason: 'none passed' });
  for (let i = 0; i < 2; i++) await round(jb, { reason: 'too small', sizeOnly: true });
  assert.equal((await covers.sweep()).length, 0, 'no pool, no sleeve: the page keeps saying it is being painted');
  assert.equal((await covers.get(a.id)).state, 'queued');
  fs.writeFileSync(path.join(houseDir, 'gsr-house-01.png'), png(1024, 1024, { seed: 9 }));
  fs.writeFileSync(path.join(houseDir, 'README.txt'), 'not a sleeve');
  covers.c = { ...covers.c, houseDir };
  const did = await covers.sweep();
  assert.deepEqual(did.map((d) => d.why).sort(), ['attempts', 'too_small']);
  assert.equal((await covers.get(a.id)).state, 'house');
  assert.equal((await covers.get(b.id)).state, 'house');
  await db.close();
});

test('a re-roll is a new generation: old uploads are refused, the old cover stays until the new one lands, and a re-roll that gives up keeps it', async () => {
  const { db, orders, covers } = await fresh('reroll');
  const o = await claimedOrder(orders); await covers.enqueue(o);
  const [j] = await covers.lease(8);
  await covers.ingest(j.jobId, { gen: 0, body: BIG, meta: 'a|1|x' });
  const dir = covers.orderDir(o.publicId);
  const first = fs.readFileSync(path.join(dir, 'cover.png'));
  const row = await covers.reroll(o);
  assert.equal(row.gen, 1); assert.equal(row.state, 'queued'); assert.equal(row.attempts, 0); assert.equal(row.prev_source, 'kannaka-art');
  assert.ok(fs.readFileSync(path.join(dir, 'cover.png')).equals(first), 'the old cover stays meanwhile');
  assert.equal((await covers.ingest(j.jobId, { gen: 0, body: BIG2, meta: 'a|1|x' })).status, 409, 'an upload for the old generation');
  const [k] = await covers.lease(8);
  assert.equal(k.gen, 1);
  assert.equal((await covers.ingest(k.jobId, { gen: 1, body: BIG2, meta: 'b|2|x' })).status, 200);
  assert.ok(!fs.readFileSync(path.join(dir, 'cover.png')).equals(first));
  assert.ok(fs.readdirSync(dir).some((f) => /^cover\.previous-\d+\.png$/.test(f)));
  // A second re-roll that never arrives: the sweep keeps the cover, no house sleeve.
  await covers.reroll(o);
  const kept = fs.readFileSync(path.join(dir, 'cover.png'));
  const did = await covers.sweep(new Date(Date.now() + 9 * 3600000));
  assert.equal(did[0].kept, true);
  const after = await covers.get(o.id);
  assert.equal(after.state, 'done'); assert.equal(after.source, 'kannaka-art');
  assert.ok(fs.readFileSync(path.join(dir, 'cover.png')).equals(kept));
  await db.close();
});

test('an order that already had a cover before the queue existed is never repainted by a rebuild', async () => {
  const { db, orders, covers } = await fresh('legacy');
  const o = await claimedOrder(orders);
  const dir = covers.orderDir(o.publicId); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cover.png'), BIG);
  const row = await covers.enqueue(o);
  assert.equal(row.state, 'done'); assert.equal(row.source, 'legacy');
  assert.equal((await covers.lease(8)).length, 0);
  await db.close();
});

test('status counts pending covers, and an empty queue is 0 minutes old, not null', async () => {
  const { db, orders, covers } = await fresh('status');
  assert.deepEqual(await covers.status(), { queued: 0, leased: 0, oldestQueuedMinutes: 0 });
  const o = await claimedOrder(orders); await covers.enqueue(o);
  await covers.lease(8);
  const s = await covers.status(Date.now() + 30 * 60000);
  assert.equal(s.leased, 1); assert.equal(s.queued, 0);
  assert.ok(s.oldestQueuedMinutes >= 29 && s.oldestQueuedMinutes <= 31);
  await db.close();
});

test('a refunded order neither pages the queue probe nor gets a house sleeve', async () => {
  const houseDir = path.join(tmp, 'house-refund'); fs.mkdirSync(houseDir, { recursive: true });
  fs.writeFileSync(path.join(houseDir, 'gsr-house-01.png'), png(1024, 1024, { seed: 11 }));
  const { db, orders, covers } = await fresh('refund-status');
  covers.c = { ...covers.c, houseDir };
  const o = await claimedOrder(orders); await covers.enqueue(o);
  await db.run('UPDATE orders SET refunded_at=? WHERE id=?', [new Date().toISOString(), o.id]);
  assert.deepEqual(await covers.status(Date.now() + 7 * 3600000), { queued: 0, leased: 0, oldestQueuedMinutes: 0 });
  assert.equal((await covers.sweep(new Date(Date.now() + 9 * 3600000))).length, 0);
  assert.equal((await covers.get(o.id)).state, 'queued');
  await db.close();
});

test('place never leaves cover.png missing, and a house sleeve that raced a painted upload gives way to it', async () => {
  const houseDir = path.join(tmp, 'house-race'); fs.mkdirSync(houseDir, { recursive: true });
  fs.writeFileSync(path.join(houseDir, 'gsr-house-01.png'), png(1024, 1024, { seed: 12 }));
  const { db, orders, covers } = await fresh('race');
  covers.c = { ...covers.c, houseDir };
  const o = await claimedOrder(orders); await covers.enqueue(o);
  const job = await covers.get(o.id);
  const dir = covers.orderDir(o.publicId);
  // The web process paints between the sweep's CAS and its rename.
  const realPlace = covers.place.bind(covers);
  let raced = false;
  covers.place = (d, tmpOut, metaStr) => {
    if (!raced && metaStr.startsWith('house|')) {
      raced = true;
      const painted = path.join(d, 'cover.incoming-painted.png');
      fs.writeFileSync(painted, BIG2);
      const pm = `kannaka-art|x|1|gpu-l4|${'a'.repeat(64)}`;
      db.run(`UPDATE cover_jobs SET state='done', source='kannaka-art', meta=? WHERE job_id=?`, [pm, job.job_id]);
      realPlace(d, painted, pm);
    }
    const kept = realPlace(d, tmpOut, metaStr);
    assert.ok(fs.existsSync(path.join(d, 'cover.png')));
    return kept;
  };
  await covers.sweep(new Date(Date.now() + 9 * 3600000));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(raced);
  const row = await covers.get(o.id);
  assert.equal(row.state, 'done');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'cover.png')), BIG2, 'the painted cover stands');
  assert.equal(covers.fileMeta(dir), row.meta);
  await db.close();
});

// ---- the worker -------------------------------------------------------------
const okSuno = {
  async generate() { return 'task'; },
  async wait() { return { status: 'SUCCESS', clips: [{ audioUrl: 'https://cdn/a', duration: 100 }] }; },
  async download(url, file) { fs.writeFileSync(file, 'mp3'); return 3; },
};

test('queueing a cover never blocks or fails an order: delivered with no cover, and the worker never writes one', async () => {
  const { db, orders, covers } = await fresh('nocover');
  const o = await orders.createFromBrief(BRIEF, { origin: 'web' });
  await orders.comp(o, 'test');
  const did = await worker.tick(orders, { suno: okSuno, covers, wait: {} });
  assert.equal(did, true);
  const after = await orders.get(o.id);
  assert.equal(after.state, 'delivered');
  assert.ok(!fs.existsSync(path.join(worker.orderDir(after), 'cover.png')));
  assert.equal((await covers.get(o.id)).state, 'queued');
  await db.close();
});

test('the deadline sweep runs on an idle tick and gives a house sleeve', async () => {
  const houseDir = path.join(tmp, 'house-idle'); fs.mkdirSync(houseDir, { recursive: true });
  fs.writeFileSync(path.join(houseDir, 'gsr-house-07.png'), png(1024, 1024, { seed: 7 }));
  const { db, orders, covers } = await fresh('idle');
  covers.c = { ...covers.c, houseDir, deadlineHours: 8 };
  const o = await claimedOrder(orders); await covers.enqueue(o);
  await db.run('UPDATE cover_jobs SET queued_at=? WHERE order_id=?', [new Date(Date.now() - 9 * 3600000).toISOString(), o.id]);
  const did = await worker.tick(orders, { suno: okSuno, covers });
  assert.equal(did, false, 'no order to build');
  assert.equal((await covers.get(o.id)).state, 'house');
  assert.ok(fs.existsSync(path.join(worker.orderDir(o), 'cover.png')));
  await db.close();
});

// ---- over HTTP --------------------------------------------------------------
async function call(base, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers, body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

test('the runner routes: own token only (503 unset, 401 wrong or empty), lease, upload, fail/release, status off the internet, album page with ?v', async () => {
  const server = await main({ coverCrop: fakeCrop });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer cov-secret' };
  try {
    const db = new Db(path.join(tmp, 'records.sqlite')); await db.open();
    const orders = new Orders(db, cfg);
    const covers = new Covers(db, cfg, { crop: fakeCrop });
    const o = await claimedOrder(orders);
    await covers.enqueue(o);

    assert.equal((await call(base, '/internal/covers/lease', { headers: { authorization: 'Bearer adm' } })).status, 401, 'the admin token is not the cover token');
    assert.equal((await call(base, '/internal/covers/lease', { headers: { authorization: 'Bearer ' } })).status, 401);
    assert.equal((await call(base, '/internal/covers/lease')).status, 401);
    const saved = cfg.covers.token; cfg.covers.token = '';
    assert.equal((await call(base, '/internal/covers/lease', { headers: { authorization: 'Bearer ' } })).status, 503, 'unset token: closed, even to an empty bearer');
    cfg.covers.token = saved;

    const a0 = await call(base, `/api/album/${o.publicId}`);
    assert.equal(a0.json.cover, null); assert.equal(a0.json.coverPending, true);

    const l = await call(base, '/internal/covers/lease?max=8', { headers: auth });
    assert.equal(l.status, 200); assert.equal(l.json.jobs.length, 1);
    const j = l.json.jobs[0];
    const up = (body, extra = {}) => call(base, `/internal/covers/${j.jobId}`, { method: 'POST', body, headers: { ...auth, 'content-type': 'image/png', 'x-cover-gen': String(j.gen), 'x-cover-meta': 'sha|7|gpu-l4', ...extra } });
    assert.equal((await up(Buffer.from('nope'), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await up(png(1024, 1024, { noise: false }))).status, 400);
    const big = png(2048, 2048, { seed: 3 }); // ~4.2 MB: over the upload limit
    assert.ok(big.length > cfg.covers.uploadLimit);
    const tooBig = await up(big).catch(() => ({ status: 413 }));
    assert.equal(tooBig.status, 413);
    const ok = await up(BIG);
    assert.equal(ok.status, 200);
    assert.equal((await up(BIG)).json.already, true);
    const a1 = await call(base, `/api/album/${o.publicId}`);
    assert.match(a1.json.cover, new RegExp(`^/album/${o.publicId}/file/cover\\.png\\?v=\\d+$`));
    assert.equal(a1.json.coverPending, false);
    const img = await fetch(base + a1.json.cover);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/album/${o.publicId}/file/cover.meta`)).status, 404, 'cover.meta is not public');

    // fail / release need the live lease; a wrong one is a 409.
    assert.equal((await call(base, `/internal/covers/${j.jobId}/fail`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ gen: 0, leaseId: 'nope', reason: 'x' }) })).status, 409);

    // Re-roll through admin: 202 at once, and the old cover stays.
    const rr = await call(base, `/admin/orders/${o.id}/cover`, { method: 'POST', headers: { authorization: 'Bearer adm' } });
    assert.equal(rr.status, 202); assert.equal(rr.json.gen, 1);
    assert.equal((await fetch(base + a1.json.cover)).status, 200);
    const prev = fs.readdirSync(path.join(tmp, 'orders', o.publicId)).filter((n) => n.startsWith('cover.previous-'));
    for (const n of prev) assert.equal((await fetch(`${base}/album/${o.publicId}/file/${n}`)).status, 404, 'a replaced cover is not public');
    const l2 = await call(base, '/internal/covers/lease', { headers: auth });
    const k = l2.json.jobs[0];
    assert.equal(k.gen, 1);
    const rel = await call(base, `/internal/covers/${k.jobId}/release`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ gen: k.gen, leaseId: k.leaseId }) });
    assert.equal(rel.status, 200);
    assert.equal((await covers.get(o.id)).attempts, 0, 'release costs no attempt');

    // The monitor's counts answer locally and not through the proxy.
    const s = await call(base, '/api/covers/status');
    assert.equal(s.status, 200); assert.equal(s.json.queued, 1); assert.equal(typeof s.json.oldestQueuedMinutes, 'number');
    assert.equal((await call(base, '/api/covers/status', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 404);

    // The shelf waits for the operator's look at a painted cover.
    await db.run('UPDATE orders SET state=?, featured_at=? WHERE id=?', ['delivered', new Date().toISOString(), o.id]);
    await db.run("UPDATE cover_jobs SET state='done', source='kannaka-art', reviewed_at=NULL WHERE order_id=?", [o.id]);
    let shelf = await call(base, '/api/showcase');
    assert.equal(shelf.json.albums[0].cover, null);
    assert.equal((await call(base, `/admin/orders/${o.id}/cover/ok`, { method: 'POST', headers: { authorization: 'Bearer adm' } })).json.ok, true);
    shelf = await call(base, '/api/showcase');
    assert.match(shelf.json.albums[0].cover, /cover\.png\?v=/);
    await db.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- the real cropper, when this machine has ffmpeg ---------------------------
const hasFfmpeg = spawnSync(process.env.GSR_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('ffmpeg crops a square 40 px off the sides and 80 off the bottom, back to 1024', { skip: !hasFfmpeg && 'no ffmpeg here', timeout: 300000 }, async () => {
  const src = path.join(tmp, 'crop-in.png'); const dst = path.join(tmp, 'crop-out.png');
  fs.writeFileSync(src, BIG);
  await ffmpegCrop(process.env.GSR_FFMPEG || 'ffmpeg', { timeoutMs: 240000 })(src, dst);
  assert.deepEqual(art.pngInfo(fs.readFileSync(dst)), { width: 1024, height: 1024 });
});
