#!/usr/bin/env node
'use strict';
// Draft a release manifest for publish-release.js from an album folder:
//   node scripts/draft-manifest.js --dir "/var/oled/kannaka/music/WHAT PERSISTED" \
//        --title "WHAT PERSISTED" --cover /home/opc/what-persisted/01_minutes_cover.png \
//        [--artist Kannaka] [--year 2026] [--blurb "..."] [--sku what-persisted] > wp.json
// Tracks are the folder's mp3s in name order ("NN - Title.mp3" -> Title).
// For albums kept as loose files, pass --tracks titles.txt (one title per
// line, in order) and --dir the folder holding them; each resolves to
// "<Title>.mp3" there. Anything that fails to resolve is reported and the
// draft is refused, so nothing half-finished reaches the store.
const fs = require('node:fs');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true; }
}
const need = (k) => { if (!args[k]) { console.error(`--${k} is required`); process.exit(2); } return args[k]; };
const dir = need('dir'); const title = need('title'); const cover = need('cover');
if (!fs.existsSync(cover)) { console.error(`cover not found: ${cover}`); process.exit(2); }

let tracks;
const strip = (s) => s.replace(/\.mp3$/i, '').replace(/^\d{1,3}\s*[-._]\s*/, '').trim();
if (args.tracks) {
  const titles = fs.readFileSync(args.tracks, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f));
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const missing = [];
  tracks = titles.map((t) => {
    const f = files.find((x) => norm(strip(x)) === norm(t)) || files.find((x) => norm(strip(x)).startsWith(norm(t)));
    if (!f) missing.push(t);
    return { title: t, file: f ? path.join(dir, f) : null };
  });
  if (missing.length) { console.error(`unresolved tracks in ${dir}:\n  ${missing.join('\n  ')}`); process.exit(1); }
} else {
  const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f) && !/preview|\.previous-/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) { console.error(`no mp3s in ${dir}`); process.exit(1); }
  tracks = files.map((f) => ({ title: strip(f), file: path.join(dir, f) }));
}
// --art-dir: every image in it rides along in the zip's art/ folder (the
// cover itself is left out of that list so it is not shipped twice).
let art;
if (args['art-dir']) {
  art = fs.readdirSync(args['art-dir']).filter((f) => /\.(png|jpe?g)$/i.test(f) && !/thumb/i.test(f)).sort().map((f) => path.join(args['art-dir'], f)).filter((f) => path.resolve(f) !== path.resolve(cover));
}
const out = { sku: args.sku || undefined, title, artist: args.artist || 'Kannaka', year: args.year ? parseInt(args.year, 10) : undefined, blurb: args.blurb || undefined, credits: args.credits || undefined, cover, tracks, art };
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
