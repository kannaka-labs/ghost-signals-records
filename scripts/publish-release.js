#!/usr/bin/env node
'use strict';
// Publish a release to the running store through its admin API:
//   GSR_ADMIN_TOKEN=... node scripts/publish-release.js manifest.json [more.json ...]
// The manifest's file paths are paths on the store's own machine (the server
// copies them into its data dir). Prints the public URL of each record.
const fs = require('node:fs');

const base = (process.env.GSR_BASE || 'http://127.0.0.1:8890').replace(/\/+$/, '');
const token = process.env.GSR_ADMIN_TOKEN;
if (!token) { console.error('GSR_ADMIN_TOKEN is required'); process.exit(2); }
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: publish-release.js manifest.json [...]'); process.exit(2); }

(async () => {
  let failed = 0;
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = await fetch(`${base}/admin/releases`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(m) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { failed++; console.error(`${f}: ${r.status} ${j.error || ''}`); continue; }
    console.log(`${j.sku}: ${j.tracks.length} tracks, ${(j.zipBytes / 1e6).toFixed(1)} MB -> ${base}/store/${j.sku}`);
  }
  process.exit(failed ? 1 : 0);
})();
