'use strict';
// The generator, direct: submit, poll, download. No SDK. Every quirk that
// cost time is written down where it is handled.
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const { URL } = require('node:url');

function request(method, url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${u.hostname}${u.pathname}`)));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

class Suno {
  constructor({ key, model, base, callbackUrl, userAgent }) {
    this.key = key; this.model = model; this.base = base.replace(/\/+$/, ''); this.callbackUrl = callbackUrl; this.ua = userAgent;
  }

  headers(json = true) {
    // Cloudflare in front of the API answers a default library UA with error 1010.
    const h = { authorization: `Bearer ${this.key}`, 'user-agent': this.ua, accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  /** Submit one track. Returns the task id. Throws with `code` = the API's
   *  code on refusal; a style naming a real artist returns SENSITIVE_WORD_ERROR
   *  in the message. */
  async generate({ title, style, lyrics, instrumental = false }) {
    const body = JSON.stringify({
      customMode: true,
      instrumental,
      model: this.model,
      title: String(title).slice(0, 100),
      style: String(style).slice(0, 1000),
      prompt: instrumental ? '' : String(lyrics).slice(0, 3000),
      callBackUrl: this.callbackUrl || undefined,
    });
    const r = await request('POST', `${this.base}/api/v1/generate`, { headers: this.headers(), body });
    let j;
    try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error(`suno generate: HTTP ${r.status} non-json`); }
    if (r.status !== 200 || j.code !== 200 || !j.data || !j.data.taskId) {
      const err = new Error(`suno generate refused: ${j.msg || r.status}`);
      err.code = j.code; err.msg = j.msg;
      err.sensitive = /sensitive/i.test(String(j.msg || ''));
      throw err;
    }
    return j.data.taskId;
  }

  /** Credits remaining on the generator account, or null if it will not say.
   *  `/api/v1/generate/credit` is the endpoint that exists; `get-credits`
   *  404s. */
  async credits() {
    try {
      const r = await request('GET', `${this.base}/api/v1/generate/credit`, { headers: this.headers(false), timeoutMs: 20000 });
      const j = JSON.parse(r.body.toString('utf8'));
      return typeof j.data === 'number' ? j.data : null;
    } catch {
      return null;
    }
  }

  /** One poll. Returns { status, clips: [{audioUrl, duration, title}] }. */
  async status(taskId) {
    const r = await request('GET', `${this.base}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, { headers: this.headers(false) });
    let j;
    try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error(`suno status: HTTP ${r.status} non-json`); }
    const d = j.data || {};
    const clips = ((d.response && d.response.sunoData) || []).map((c) => ({ audioUrl: c.audioUrl || c.sourceAudioUrl || '', duration: Number(c.duration) || 0, title: c.title || '' }));
    return { status: d.status || 'UNKNOWN', clips, raw: j };
  }

  /** Poll until SUCCESS or a terminal failure. */
  async wait(taskId, { intervalMs = 15000, maxMs = 20 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const t0 = Date.now();
    for (;;) {
      const s = await this.status(taskId);
      if (s.status === 'SUCCESS' && s.clips.some((c) => c.audioUrl)) return s;
      if (/FAIL|ERROR|SENSITIVE/i.test(s.status)) throw Object.assign(new Error(`suno task ${taskId}: ${s.status}`), { status: s.status });
      if (Date.now() - t0 > maxMs) throw new Error(`suno task ${taskId}: timed out in ${s.status}`);
      await sleep(intervalMs);
    }
  }

  /** The audio CDN refuses a library UA with 403; send a browser one and
   *  follow redirects by hand. */
  async download(url, file, hops = 0) {
    const r = await request('GET', url, { headers: { 'user-agent': this.ua, accept: '*/*' }, timeoutMs: 180000 });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location && hops < 5) return this.download(new URL(r.headers.location, url).toString(), file, hops + 1);
    if (r.status !== 200) throw new Error(`download ${r.status} for ${url.slice(0, 80)}`);
    fs.writeFileSync(file, r.body);
    return r.body.length;
  }
}

/** The longer of the two variants is the more developed arrangement. */
function pickClip(clips) {
  return clips.filter((c) => c.audioUrl).sort((a, b) => b.duration - a.duration)[0] || null;
}

module.exports = { Suno, pickClip, request };
