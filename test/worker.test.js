'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// The worker reads its config at require time; point it at a temp dir first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-w-'));
process.env.GSR_DATA_DIR = tmp;
process.env.GSR_PUBLIC_URL = 'https://records.test';
const cfg = require('../server/config');
const { Db } = require('../server/db');
const { Orders } = require('../server/orders');
const worker = require('../server/worker');
const { pickClip } = require('../server/suno');

const BRIEF = { theme: 'a long drive home after a funeral', style: 'night-drive synthwave, analog arpeggios', tier: 'ep', albumTitle: 'The Long Way', trackTitles: ['One', 'Two', 'Three', 'Four'], artDirection: '' };

/** A generator that refuses the first style once, then produces two clips. */
function fakeSuno({ refuseFirst = false } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async generate({ style }) {
      calls += 1;
      if (refuseFirst && calls === 1) { const e = new Error('SENSITIVE_WORD_ERROR'); e.sensitive = true; throw e; }
      if (/that sound|no names/.test(style) || !refuseFirst || calls > 1) return `task-${calls}`;
      return `task-${calls}`;
    },
    async wait(taskId) { return { status: 'SUCCESS', clips: [{ audioUrl: `https://cdn/${taskId}-a`, duration: 120 }, { audioUrl: `https://cdn/${taskId}-b`, duration: 181 }] }; },
    async download(url, file) { fs.writeFileSync(file, `mp3:${url}`); return 10; },
  };
}

test('the longer clip is picked', () => {
  assert.equal(pickClip([{ audioUrl: 'a', duration: 100 }, { audioUrl: 'b', duration: 150 }, { audioUrl: '', duration: 999 }]).audioUrl, 'b');
});

test('a paid order builds every track, a placeholder cover, a manifest, and is delivered; a refused style is rewritten once', async () => {
  const db = await new Db(path.join(tmp, 'r.sqlite')).open();
  const orders = new Orders(db, cfg);
  const o = await orders.createFromBrief(BRIEF, { origin: 'web' });
  await orders.comp(o, 'test');
  const claimed = await orders.claimNextBuild();
  const suno = fakeSuno({ refuseFirst: true });
  const manifest = await worker.buildOrder(orders, claimed, { suno, atelier: null, wait: {} });
  assert.equal(manifest.tracks.length, 4);
  assert.equal(manifest.coverSource, 'placeholder');
  const dir = worker.orderDir(claimed);
  assert.ok(fs.existsSync(path.join(dir, '01 - One.mp3')));
  assert.ok(fs.existsSync(path.join(dir, 'cover.png')));
  assert.ok(fs.existsSync(path.join(dir, 'album.json')));
  assert.equal(fs.readFileSync(path.join(dir, '01 - One.mp3'), 'utf8'), 'mp3:https://cdn/task-2-b', 'the longer variant, after one rewrite');
  const tracks = await orders.tracks(claimed.id);
  assert.ok(tracks.every((t) => t.status === 'done' && t.duration_sec === 181));
  assert.ok(tracks.every((t) => t.lyrics && /\[Chorus\]/.test(t.lyrics)), 'template lyrics without a brain');
  const url = await worker.deliver(orders, claimed, manifest);
  assert.equal(url, `https://records.test/album/${claimed.publicId}`);
  assert.equal((await orders.get(claimed.id)).state, 'delivered');
  // Re-running the build is a no-op for finished tracks.
  const before = suno.calls();
  await worker.buildOrder(orders, await orders.get(claimed.id), { suno, atelier: null, wait: {} });
  assert.equal(suno.calls(), before);
  await db.close();
});

test('a generator failure fails the order with a readable reason and a retry requeues it', async () => {
  const db = await new Db(path.join(tmp, 'r2.sqlite')).open();
  const orders = new Orders(db, cfg);
  const o = await orders.createFromBrief(BRIEF, { origin: 'web' });
  await orders.comp(o, 'test');
  const bad = { async generate() { throw new Error('suno generate refused: quota'); } };
  const did = await worker.tick(orders, { suno: bad, atelier: null });
  assert.equal(did, true);
  const after = await orders.get(o.id);
  assert.equal(after.state, 'failed');
  assert.match(after.failedReason, /quota/);
  assert.equal(await orders.requeue(o.id), true);
  await db.close();
});

test('file names are safe', () => {
  assert.equal(worker.safeName('../../etc/passwd'), 'etcpasswd');
  assert.equal(worker.safeName('Song: "Quotes" & More?'), 'Song Quotes More');
});
