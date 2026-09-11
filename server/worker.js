'use strict';
// The studio floor: takes one paid order at a time and builds it, track by
// track, resumable. Lyrics from the brain (or the template), the generator
// for audio, the atelier for the cover, files under the order's directory,
// then delivered and mailed. A track that the generator refuses for its
// style gets one rewrite; a track that fails twice fails the order with a
// reason the operator can read, and the retry is a state move.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { Db, now } = require('./db');
const { Orders } = require('./orders');
const { Suno, pickClip } = require('./suno');
const { writeLyrics } = require('./lyrics');
const { Atelier, coverPrompt, placeholderPng } = require('./art');
const { smtpSend } = require('./mail');
const { chat } = require('./brain');

const log = (m) => console.log(`[worker ${new Date().toISOString()}] ${m}`);

function orderDir(order) { return path.join(cfg.dataDir, 'orders', order.publicId); }

function safeName(s) { return String(s).replace(/[^A-Za-z0-9 _.-]+/g, '').replace(/^[. _-]+/, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'track'; }

async function rewriteStyle(style) {
  try {
    const out = await chat(cfg.brain, [
      { role: 'system', content: 'Rewrite a music style description so it contains NO names of artists, bands, songs or labels. Keep the genre, tempo, instruments, era and mood. Output only the rewritten description, under 600 characters.' },
      { role: 'user', content: style },
    ], { maxTokens: 200, temperature: 0.3 });
    return out.replace(/["“”]/g, '').slice(0, 1000);
  } catch { return style.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, 'that sound'); }
}

async function buildTrack(orders, suno, order, track, deps) {
  const dir = orderDir(order);
  const brief = order.brief;
  const file = path.join(dir, `${String(track.idx + 1).padStart(2, '0')} - ${safeName(track.title)}.mp3`);
  if (track.status === 'done' && fs.existsSync(file)) return;
  await orders.trackUpdate(order.id, track.idx, { status: 'lyrics' });
  let lyrics = track.lyrics;
  if (!lyrics && !brief.instrumental) {
    const r = await writeLyrics(cfg.brain, { albumTitle: brief.albumTitle, theme: brief.theme, style: brief.style, title: track.title, index: track.idx, count: brief.trackTitles.length });
    lyrics = r.lyrics;
    if (r.source === 'template') log(`track ${track.idx + 1}: template lyrics (${r.reason || 'no brain'})`);
    await orders.trackUpdate(order.id, track.idx, { lyrics, status: 'lyrics' });
    fs.writeFileSync(path.join(dir, `lyrics_${String(track.idx + 1).padStart(2, '0')}.txt`), lyrics);
  }
  let style = brief.style;
  let taskId = track.suno_task_id;
  for (let attempt = 0; attempt < 2 && !taskId; attempt++) {
    try {
      taskId = await suno.generate({ title: track.title, style, lyrics: lyrics || '', instrumental: brief.instrumental });
    } catch (e) {
      if (e.sensitive && attempt === 0) { log(`track ${track.idx + 1}: style refused, rewriting`); style = await rewriteStyle(style); continue; }
      throw e;
    }
  }
  await orders.trackUpdate(order.id, track.idx, { suno_task_id: taskId, status: 'generating' });
  // A task can die on the generator's side (GENERATE_AUDIO_FAILED). One
  // fresh task is tried before the order fails; a dead task id is never
  // waited on again after a requeue.
  let s;
  try {
    s = await suno.wait(taskId, deps.wait || {});
  } catch (e) {
    if (!/FAIL|ERROR|SENSITIVE/i.test(String(e.status || e.message))) throw e;
    log(`track ${track.idx + 1}: task ${taskId} died (${e.message}); one fresh task`);
    await orders.trackUpdate(order.id, track.idx, { suno_task_id: null, status: 'lyrics' });
    taskId = await suno.generate({ title: track.title, style, lyrics: lyrics || '', instrumental: brief.instrumental });
    await orders.trackUpdate(order.id, track.idx, { suno_task_id: taskId, status: 'generating' });
    s = await suno.wait(taskId, deps.wait || {});
  }
  const clip = pickClip(s.clips);
  if (!clip) throw new Error(`track ${track.idx + 1}: no audio in result`);
  await suno.download(clip.audioUrl, file);
  await orders.trackUpdate(order.id, track.idx, { status: 'done', file: path.basename(file), duration_sec: clip.duration });
  log(`track ${track.idx + 1}/${brief.trackTitles.length} done: ${path.basename(file)} (${Math.round(clip.duration)} s)`);
}

async function buildCover(order, atelier) {
  const dir = orderDir(order);
  const file = path.join(dir, 'cover.png');
  if (fs.existsSync(file)) return 'kept';
  if (!atelier) { fs.writeFileSync(file, placeholderPng()); return 'placeholder'; }
  try {
    const r = await atelier.generate({ prompt: coverPrompt(order.brief), description: `Cover for "${order.brief.albumTitle}", a Ghost Signals Records album. ${order.brief.theme.slice(0, 200)}`, file });
    fs.writeFileSync(path.join(dir, 'cover.meta'), `${r.artifactId}|${r.url}`);
    return 'atelier';
  } catch (e) {
    log(`cover: ${e.message}; placeholder`);
    fs.writeFileSync(file, placeholderPng());
    return 'placeholder';
  }
}

async function buildOrder(orders, order, deps) {
  const dir = orderDir(order);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(order.brief, null, 2));
  const tracks = await orders.tracks(order.id);
  for (const t of tracks) await buildTrack(orders, deps.suno, order, t, deps);
  const cover = await buildCover(order, deps.atelier);
  const manifest = {
    album: order.brief.albumTitle, tier: order.tier, cover: 'cover.png', coverSource: cover,
    tracks: (await orders.tracks(order.id)).map((t) => ({ n: t.idx + 1, title: t.title, file: t.file, duration: t.duration_sec })),
    deliveredAt: now(),
  };
  fs.writeFileSync(path.join(dir, 'album.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function deliver(orders, order, manifest) {
  const url = `${cfg.publicUrl}/album/${order.publicId}`;
  await orders.move(order.id, 'building', 'delivered', { delivered_at: now() });
  if (order.email) {
    const text = `Your record is done.\n\n"${manifest.album}" — ${manifest.tracks.length} tracks.\n${url}\n\nThe page is private to that link. Downloads are on it.\n\nGhost Signals Records\n`;
    const ok = await smtpSend(cfg.mail, { to: order.email, subject: `"${manifest.album}" is ready`, text });
    log(`mail to ${order.email}: ${ok ? 'sent' : 'not sent'}`);
  }
  if (cfg.mail.operator) await smtpSend(cfg.mail, { to: cfg.mail.operator, subject: `[records] delivered: ${manifest.album}`, text: `${url}\norder ${order.id}\n` });
  return url;
}

async function tick(orders, deps) {
  const order = await orders.claimNextBuild();
  if (!order) return false;
  log(`building ${order.id} "${order.brief.albumTitle}" (${order.tier})`);
  try {
    const manifest = await buildOrder(orders, order, deps);
    const url = await deliver(orders, order, manifest);
    log(`delivered ${url}`);
  } catch (e) {
    log(`FAILED ${order.id}: ${e.message}`);
    await orders.move(order.id, 'building', 'failed', { failed_reason: String(e.message).slice(0, 500) });
    if (cfg.mail.operator) await smtpSend(cfg.mail, { to: cfg.mail.operator, subject: `[records] FAILED: ${order.brief.albumTitle}`, text: `order ${order.id}\n${e.message}\nRetry: POST /admin/orders/${order.id}/retry\n` });
  }
  return true;
}

async function main() {
  if (!cfg.suno.key) { log('SUNO_API_KEY not set; the worker cannot build. Exiting.'); process.exit(3); }
  const db = await new Db(path.join(cfg.dataDir, 'records.sqlite')).open();
  const orders = new Orders(db, cfg);
  const deps = {
    // The generator refuses a request without a callback URL even though
    // we poll; the studio answers 200 to whatever it posts there.
    suno: new Suno({ ...cfg.suno, callbackUrl: cfg.suno.callbackUrl || `${cfg.publicUrl}/api/suno/callback`, userAgent: cfg.userAgent }),
    atelier: cfg.obc.jwt ? new Atelier({ ...cfg.obc, userAgent: cfg.userAgent }) : null,
  };
  log(`worker up; data ${cfg.dataDir}; atelier ${deps.atelier ? 'on' : 'off (placeholder covers)'}; brain ${cfg.brain.key ? 'on' : 'off (template lyrics)'}`);
  for (;;) {
    let did = false;
    try { did = await tick(orders, deps); } catch (e) { log(`tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, did ? 2000 : 20000));
  }
}

if (require.main === module) main();

module.exports = { buildOrder, buildTrack, buildCover, deliver, tick, orderDir, safeName };
