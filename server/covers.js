'use strict';
// The cover queue. A job is enqueued when the worker claims an order, so the
// picture is painted while the generator builds the tracks; delivery never
// waits for it. The painter is kannaka-art on a qBraid GPU, driven by a
// runner on debain2 that PULLS work over HTTPS (debain2 cannot reach this box
// any other way):
//
//   GET  /internal/covers/lease?max=8      -> jobs, each leased for 90 min
//   POST /internal/covers/<jobId>          image/png -> cropped, cover.png
//   POST /internal/covers/<jobId>/fail     a pod ran and nothing passed
//   POST /internal/covers/<jobId>/release  busy / no capacity / no credits
//
// States: queued -> leased -> done | house; cancelled. `house` is one of the
// label's own generic sleeves, applied by the worker's sweep when a job runs
// past its deadline or its attempts; a late real cover still upgrades it.
// Every state change is ONE compare-and-set on (job, gen, state) BEFORE any
// file moves, so the web process (ingest) and the worker (sweep) cannot both
// win. Cover state lives here and in cover.meta, never in album.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { now } = require('./db');
const { coverSubject, pngInfo, pickHouseSleeve } = require('./art');

const PENDING = ['queued', 'leased'];
const LEASABLE_ORDER_STATES = ['paid', 'building', 'delivered', 'failed'];

function orderDirFor(cfg, publicId) { return path.join(cfg.dataDir, 'orders', publicId); }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rand = () => crypto.randomBytes(6).toString('hex');
const minutesFrom = (iso, at = Date.now()) => Math.max(0, Math.floor((at - Date.parse(iso)) / 60000));

/** Square-crop and resize with ffmpeg: 40 px off left and right, 80 px off the
 *  bottom (where SDXL signs its work), back to 1024 x 1024. Async, niced, with
 *  a timeout: this box has one CPU and serves the radio. */
function ffmpegCrop(ffmpeg, { timeoutMs = 60000 } = {}) {
  return (src, dst) => new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-y', '-i', src, '-vf', 'crop=iw-80:iw-80:40:0,scale=1024:1024:flags=lanczos', '-frames:v', '1', dst];
    let err = '';
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid, 10); } catch { /* best effort */ }
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    child.stderr.on('data', (d) => { if (err.length < 500) err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(0, 200)}`)); });
  });
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${rand()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function rmQuiet(f) { try { fs.unlinkSync(f); } catch { /* gone */ } }

class Covers {
  /** opts.crop(src, dst): the image step (ffmpeg by default; tests inject one).
   *  opts.ffmpeg null/'' means no cropper: an upload answers 503 and the runner
   *  keeps the image for its next tick. */
  constructor(db, cfg, opts = {}) {
    this.db = db; this.cfg = cfg; this.c = cfg.covers || {};
    this.log = opts.log || (() => {});
    const ff = opts.ffmpeg !== undefined ? opts.ffmpeg : (process.env.GSR_FFMPEG === '' ? null : (process.env.GSR_FFMPEG || 'ffmpeg'));
    this.crop = opts.crop || (ff ? ffmpegCrop(ff) : null);
  }

  orderDir(publicId) { return orderDirFor(this.cfg, publicId); }

  async get(orderId) { return this.db.get('SELECT * FROM cover_jobs WHERE order_id=?', [orderId]); }
  async byJob(jobId) { return this.db.get('SELECT * FROM cover_jobs WHERE job_id=?', [jobId]); }

  /** Called when the worker claims an order. INSERT OR IGNORE: a rebuild
   *  re-claims the same order and must never reset a done or house job. An
   *  order that already has a cover on disk from before this queue existed
   *  (the Pixel Atelier days) is recorded as done/legacy, never repainted. */
  async enqueue(order) {
    const t = now();
    const legacy = fs.existsSync(path.join(this.orderDir(order.publicId), 'cover.png'));
    await this.db.run(
      'INSERT OR IGNORE INTO cover_jobs (order_id, job_id, subject, state, gen, source, queued_at, done_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [order.id, crypto.randomBytes(8).toString('hex'), coverSubject(order.brief), legacy ? 'done' : 'queued', 0, legacy ? 'legacy' : null, t, legacy ? t : null, t, t],
    );
    return this.get(order.id);
  }

  /** What album.json and the delivery mail say about the sleeve. */
  static sourceOf(job) {
    if (!job) return 'none';
    if (PENDING.includes(job.state)) return 'pending';
    if (job.state === 'house') return 'house';
    return job.source || job.state;
  }

  /** The operator's re-roll: a new generation of the same job. The old cover
   *  stays on the page until the new one arrives; an upload for the older
   *  generation is refused from now on. */
  async reroll(order) {
    const job = await this.get(order.id);
    const t = now();
    if (!job) {
      const legacy = fs.existsSync(path.join(this.orderDir(order.publicId), 'cover.png'));
      await this.db.run(
        'INSERT INTO cover_jobs (order_id, job_id, subject, state, gen, prev_source, queued_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [order.id, crypto.randomBytes(8).toString('hex'), coverSubject(order.brief), 'queued', 1, legacy ? 'legacy' : null, t, t, t],
      );
      return this.get(order.id);
    }
    await this.db.run(
      `UPDATE cover_jobs SET gen=gen+1, state='queued', attempts=0, size_fails=0, lease_id=NULL, leased_until=NULL,
         subject=?, prev_source=CASE WHEN state IN ('done','house') THEN source ELSE prev_source END,
         prev_meta=CASE WHEN state IN ('done','house') THEN meta ELSE prev_meta END,
         queued_at=?, last_reason='reroll', updated_at=? WHERE order_id=?`,
      [coverSubject(order.brief), t, t, order.id],
    );
    return this.get(order.id);
  }

  async cancel(orderId) {
    const r = await this.db.run(`UPDATE cover_jobs SET state='cancelled', lease_id=NULL, leased_until=NULL, updated_at=? WHERE order_id=? AND state IN ('queued','leased')`, [now(), orderId]);
    return r.changes === 1;
  }

  /** Hand out up to `max` jobs. An expired lease is leasable again. Only
   *  orders that are still wanted: not cancelled, not refunded or disputed. */
  async lease(max = 8, at = new Date()) {
    const nowIso = at.toISOString();
    const until = new Date(at.getTime() + (this.c.leaseMinutes || 90) * 60000).toISOString();
    const rows = await this.db.all(
      `SELECT c.* FROM cover_jobs c JOIN orders o ON o.id = c.order_id
        WHERE (c.state='queued' OR (c.state='leased' AND c.leased_until < ?))
          AND o.state IN (${LEASABLE_ORDER_STATES.map(() => '?').join(',')})
          AND o.refunded_at IS NULL AND o.disputed_at IS NULL
        ORDER BY c.queued_at ASC LIMIT ?`,
      [nowIso, ...LEASABLE_ORDER_STATES, Math.max(1, Math.min(8, max | 0))],
    );
    const out = [];
    for (const row of rows) {
      const leaseId = crypto.randomBytes(8).toString('hex');
      const r = await this.db.run(
        `UPDATE cover_jobs SET state='leased', lease_id=?, leased_until=?, updated_at=?
          WHERE order_id=? AND gen=? AND (state='queued' OR (state='leased' AND leased_until < ?))`,
        [leaseId, until, nowIso, row.order_id, row.gen, nowIso],
      );
      // Only what the painter needs: no email, no public id, no title.
      if (r.changes === 1) out.push({ jobId: row.job_id, gen: row.gen, leaseId, attempt: row.attempts, subject: row.subject });
    }
    return out;
  }

  /** The runner gives a job back without counting an attempt: the account
   *  was busy, there was no GPU capacity, the credit floor was hit, or it
   *  crashed before a pod ran. Only the current lease holder can. */
  async release(jobId, { gen, leaseId }) {
    const r = await this.db.run(
      `UPDATE cover_jobs SET state='queued', lease_id=NULL, leased_until=NULL, updated_at=? WHERE job_id=? AND gen=? AND lease_id=? AND state='leased'`,
      [now(), jobId, gen, leaseId],
    );
    return r.changes === 1;
  }

  /** A pod ran and no candidate passed: one attempt spent. `sizeOnly` counts
   *  the case where every candidate was simply too small a file (a very dark
   *  or minimal direction does that on every seed), which goes to the house
   *  sleeve sooner rather than spending sessions on a style. */
  async fail(jobId, { gen, leaseId, reason, sizeOnly }) {
    const r = await this.db.run(
      `UPDATE cover_jobs SET state='queued', attempts=attempts+1, size_fails=size_fails+?, last_reason=?, lease_id=NULL, leased_until=NULL, updated_at=?
        WHERE job_id=? AND gen=? AND lease_id=? AND state='leased'`,
      [sizeOnly ? 1 : 0, String(reason || 'failed').slice(0, 200), now(), jobId, gen, leaseId],
    );
    return r.changes === 1;
  }

  /** A painted cover arrives. Returns { status, body } for the route.
   *  Accepted while the job is not done for the SAME generation, even after
   *  its lease expired (a long tick, or an upload resumed by the next tick),
   *  and over a house sleeve. The same bytes again is a 200 no-op; different
   *  bytes for a done job is a 409, never a replacement. */
  async ingest(jobId, { gen, body, meta }) {
    const job = await this.byJob(jobId);
    if (!job) return { status: 404, body: { error: 'no such job' } };
    if (!Number.isInteger(gen) || gen !== job.gen) return { status: 409, body: { ok: false, reason: 'stale_gen', gen: job.gen } };
    const bodySha = sha256(body);
    const metaStr = `kannaka-art|${String(meta || '').replace(/[^A-Za-z0-9._|-]/g, '').slice(0, 160)}|${bodySha}`;
    const order = await this.db.get('SELECT id, public_id FROM orders WHERE id=?', [job.order_id]);
    if (!order) return { status: 404, body: { error: 'no such order' } };
    const dir = this.orderDir(order.public_id);
    if (job.state === 'done') {
      if (!job.meta || !job.meta.endsWith(`|${bodySha}`)) return { status: 409, body: { ok: false, reason: 'already_done' } };
      // Same bytes: a retry after a lost 200, or after a crash between the
      // state change and the rename. Make sure the file matches the row.
      if (this.fileMeta(dir) !== job.meta) {
        const r = await this.prepare(dir, body);
        if (r.error) return r.error;
        this.place(dir, r.tmpOut, job.meta);
      }
      return { status: 200, body: { ok: true, already: true } };
    }
    if (job.state === 'cancelled') return { status: 409, body: { ok: false, reason: 'cancelled' } };
    const r = await this.prepare(dir, body);
    if (r.error) return r.error;
    const t = now();
    const cas = await this.db.run(
      `UPDATE cover_jobs SET state='done', source='kannaka-art', meta=?, reviewed_at=NULL, lease_id=NULL, leased_until=NULL, done_at=?, updated_at=?
        WHERE job_id=? AND gen=? AND state IN ('queued','leased','house')`,
      [metaStr, t, t, jobId, gen],
    );
    if (cas.changes !== 1) {
      rmQuiet(r.tmpOut);
      const again = await this.byJob(jobId);
      if (again && again.state === 'done' && again.gen === gen && again.meta === metaStr) return { status: 200, body: { ok: true, already: true } };
      return { status: 409, body: { ok: false, reason: 'lost_race' } };
    }
    this.place(dir, r.tmpOut, metaStr);
    return { status: 200, body: { ok: true }, orderId: job.order_id, upgradedHouse: job.state === 'house' };
  }

  /** Validate and crop an upload into a temp file in the order directory.
   *  Returns { tmpOut } or { error: {status, body} }. */
  async prepare(dir, body) {
    const info = pngInfo(body);
    if (!info) return { error: { status: 400, body: { ok: false, reason: 'not_png' } } };
    if (info.width !== info.height || info.width < 1024) return { error: { status: 400, body: { ok: false, reason: 'bad_dimensions', width: info.width, height: info.height } } };
    if (body.length < (this.c.minBytes || 60000)) return { error: { status: 400, body: { ok: false, reason: 'too_small', bytes: body.length } } };
    if (!this.crop) return { error: { status: 503, body: { ok: false, reason: 'no_cropper' } } };
    fs.mkdirSync(dir, { recursive: true });
    const tag = rand();
    const tmpIn = path.join(dir, `cover.upload-${tag}.png`);
    const tmpOut = path.join(dir, `cover.incoming-${tag}.png`);
    fs.writeFileSync(tmpIn, body);
    try {
      await this.crop(tmpIn, tmpOut);
    } catch (e) {
      rmQuiet(tmpIn); rmQuiet(tmpOut);
      this.log(`cover crop failed: ${e.message}`);
      return { error: { status: 503, body: { ok: false, reason: 'crop_failed' } } };
    }
    rmQuiet(tmpIn);
    const out = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut) : null;
    const oi = out && pngInfo(out);
    if (!oi || oi.width !== 1024 || oi.height !== 1024) {
      rmQuiet(tmpOut);
      return { error: { status: 503, body: { ok: false, reason: 'crop_output_invalid' } } };
    }
    return { tmpOut };
  }

  /** Put a prepared file in place: the cover it replaces is kept beside it.
   *  The old file is linked (or copied) aside first and the new one renamed
   *  over it, so cover.png is never missing. Returns the kept path or null. */
  place(dir, tmpOut, metaStr) {
    const cover = path.join(dir, 'cover.png');
    let kept = null;
    if (fs.existsSync(cover)) {
      kept = path.join(dir, `cover.previous-${Date.now()}.png`);
      try { fs.linkSync(cover, kept); } catch { fs.copyFileSync(cover, kept); }
    }
    fs.renameSync(tmpOut, cover);
    writeAtomic(path.join(dir, 'cover.meta'), metaStr);
    return kept;
  }

  fileMeta(dir) {
    try { return fs.readFileSync(path.join(dir, 'cover.meta'), 'utf8').trim(); } catch { return null; }
  }

  houseSleeves() {
    const d = this.c.houseDir;
    try { return fs.readdirSync(d).filter((n) => /^[a-z0-9][a-z0-9_-]*\.png$/.test(n)); } catch { return []; }
  }

  /** The deadline sweep (the worker runs it every tick, idle or not). A job
   *  still pending past its deadline, its attempts, or two "too small" pods
   *  gets a house sleeve: one of the label's own generic images, the same
   *  one for the same order. Never another album's cover. A re-roll that
   *  gives up leaves the cover it was meant to replace. Returns what it did. */
  async sweep(at = new Date()) {
    const deadline = new Date(at.getTime() - (this.c.deadlineHours || 8) * 3600000).toISOString();
    const rows = await this.db.all(
      `SELECT c.*, o.public_id AS public_id FROM cover_jobs c JOIN orders o ON o.id = c.order_id
        WHERE c.state IN ('queued','leased') AND (c.queued_at < ? OR c.attempts >= ? OR c.size_fails >= ?)
          AND o.refunded_at IS NULL AND o.disputed_at IS NULL`,
      [deadline, this.c.maxAttempts || 3, this.c.maxSizeFails || 2],
    );
    const done = [];
    for (const job of rows) {
      const dir = this.orderDir(job.public_id);
      const why = job.queued_at < deadline ? 'deadline' : job.size_fails >= (this.c.maxSizeFails || 2) ? 'too_small' : 'attempts';
      const t = now();
      if (job.gen > 0 && job.prev_source && fs.existsSync(path.join(dir, 'cover.png'))) {
        const r = await this.db.run(
          `UPDATE cover_jobs SET state=?, source=?, meta=?, last_reason=?, lease_id=NULL, leased_until=NULL, updated_at=? WHERE order_id=? AND gen=? AND state IN ('queued','leased')`,
          [job.prev_source === 'house' ? 'house' : 'done', job.prev_source, job.prev_meta, `reroll gave up: ${why}`, t, job.order_id, job.gen],
        );
        if (r.changes === 1) done.push({ orderId: job.order_id, publicId: job.public_id, kept: true, why });
        continue;
      }
      const pick = pickHouseSleeve(job.order_id, this.houseSleeves());
      if (!pick) { this.log(`cover sweep: no house sleeves in ${this.c.houseDir}; order ${job.order_id} stays pending`); continue; }
      const src = fs.readFileSync(path.join(this.c.houseDir, pick));
      const metaStr = `house|${pick}|${sha256(src)}`;
      const r = await this.db.run(
        `UPDATE cover_jobs SET state='house', source='house', meta=?, last_reason=?, lease_id=NULL, leased_until=NULL, done_at=?, updated_at=? WHERE order_id=? AND gen=? AND state IN ('queued','leased')`,
        [metaStr, why, t, t, job.order_id, job.gen],
      );
      if (r.changes !== 1) continue; // an upload won the race; its cover stands
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `cover.incoming-${rand()}.png`);
      fs.writeFileSync(tmp, src);
      const kept = this.place(dir, tmp, metaStr);
      // The web process may have taken this row house -> done between our CAS
      // and our rename, and placed its painted cover first: ours would then
      // have overwritten it. Put the painted one back.
      const after = await this.byJob(job.job_id);
      if (after && after.meta !== metaStr && this.fileMeta(dir) === metaStr && kept && fs.existsSync(kept)) {
        fs.renameSync(kept, path.join(dir, 'cover.png'));
        writeAtomic(path.join(dir, 'cover.meta'), after.meta);
        this.log(`cover sweep: order ${job.order_id} was painted while the house sleeve went in; painted cover restored`);
        continue;
      }
      done.push({ orderId: job.order_id, publicId: job.public_id, house: pick, why });
    }
    return done;
  }

  /** Counts for the monitor. Pending = queued + leased; an empty queue is 0
   *  minutes old, not null (a null would fail the probe's condition). */
  async status(at = Date.now()) {
    const r = await this.db.get(
      `SELECT SUM(CASE WHEN c.state='queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN c.state='leased' THEN 1 ELSE 0 END) AS leased,
              MIN(CASE WHEN c.state IN ('queued','leased') THEN c.queued_at END) AS oldest
         FROM cover_jobs c JOIN orders o ON o.id = c.order_id WHERE o.refunded_at IS NULL AND o.disputed_at IS NULL`,
    );
    return { queued: (r && r.queued) || 0, leased: (r && r.leased) || 0, oldestQueuedMinutes: r && r.oldest ? minutesFrom(r.oldest, at) : 0 };
  }

  /** The operator has looked at a painted cover; it may go on the shelf. */
  async markReviewed(orderId) {
    const r = await this.db.run(`UPDATE cover_jobs SET reviewed_at=?, updated_at=? WHERE order_id=? AND state IN ('done','house')`, [now(), now(), orderId]);
    return r.changes === 1;
  }

  /** May the public shelf show this order's cover? A painted cover waits for
   *  the operator's look (SDXL has no safety checker and the theme is a
   *  buyer's free text); a house sleeve or an older cover may show. */
  static showable(job) {
    if (!job) return true;
    if (job.source === 'kannaka-art') return Boolean(job.reviewed_at);
    return true;
  }
}

module.exports = { Covers, ffmpegCrop, orderDirFor, PENDING };
