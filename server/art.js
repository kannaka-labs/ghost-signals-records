'use strict';
// Cover art from OpenBotCity's Pixel Atelier, as the studio's bot. Optional:
// without a bot token the album ships with a generated placeholder cover.
// Traps handled: the bot must be INSIDE the art studio (403 "not inside any
// building" otherwise), a real browser UA is required, one image per ~95 s.
const fs = require('node:fs');
const { request } = require('./suno');

const API = 'https://api.openbotcity.com';

class Atelier {
  constructor({ jwt, studioBuildingId, userAgent, gapMs }) {
    this.jwt = jwt; this.building = studioBuildingId; this.ua = userAgent; this.gapMs = gapMs;
    this.lastAt = 0;
  }

  headers() {
    return { authorization: `Bearer ${this.jwt}`, 'content-type': 'application/json', 'user-agent': this.ua, accept: '*/*' };
  }

  async enter() {
    const r = await request('POST', `${API}/buildings/enter`, { headers: this.headers(), body: JSON.stringify({ building_id: this.building }) });
    return r.status < 300;
  }

  /** Generate one image and save it. Returns { artifactId, url, bytes }. */
  async generate({ prompt, description, file, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const wait = this.gapMs - (Date.now() - this.lastAt);
    if (wait > 0) await sleep(wait);
    // The city wants the bot inside the studio AND the studio named in the
    // body (a 2026-09 change: "building_id required").
    await this.enter();
    let entered = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await request('POST', `${API}/artifacts/generate-image`, { headers: this.headers(), body: JSON.stringify({ building_id: this.building, prompt: String(prompt).slice(0, 500), description: String(description || '').slice(0, 480) }), timeoutMs: 180000 });
      this.lastAt = Date.now();
      const text = r.body.toString('utf8');
      if (r.status === 200) {
        let j; try { j = JSON.parse(text); } catch { j = {}; }
        const url = (j.data || {}).public_url || '';
        const artifactId = (j.data || {}).artifact_id || '';
        if (!url) { await sleep(60000); continue; }
        const img = await request('GET', url, { headers: { 'user-agent': this.ua, accept: '*/*' }, timeoutMs: 180000 });
        if (img.status !== 200) throw new Error(`cover download ${img.status}`);
        fs.writeFileSync(file, img.body);
        return { artifactId, url, bytes: img.body.length };
      }
      if (/not inside any building|building_id required/i.test(text) && entered) { entered = false; await this.enter(); await sleep(5000); continue; }
      if (r.status >= 400 && r.status < 500 && !/retry_after|rate/i.test(text)) throw new Error(`atelier ${r.status}: ${text.slice(0, 160)}`);
      let retry = 95;
      try { retry = (JSON.parse(text).retry_after || 95) + 10; } catch { /* keep */ }
      await sleep(retry * 1000);
    }
    throw new Error('cover generation failed after 3 attempts');
  }
}

/** A cover prompt from the brief. Opens with the art direction so the
 *  creative-loop detector sees a different fingerprint per album. */
function coverPrompt({ albumTitle, theme, artDirection }) {
  const dir = artDirection || 'painted, textured, one figure and a lot of sky';
  return `${dir}. Album cover for "${albumTitle}": ${theme}. No text, no letters, no logos.`.slice(0, 500);
}

/** A placeholder cover: a 1x1 PNG scaled by the page. Honest, not pretty. */
function placeholderPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
}

module.exports = { Atelier, coverPrompt, placeholderPng };
