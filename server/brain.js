'use strict';
// The hosted Kannaka Brain, OpenAI-compatible, over https with no SDK.
// Every call has a timeout and a fallback; the studio never waits on it.
const https = require('node:https');
const { URL } = require('node:url');

function chat({ base, key, model, timeoutMs, userAgent }, messages, { maxTokens = 400, temperature = 0.7 } = {}) {
  return new Promise((resolve, reject) => {
    if (!key) return reject(new Error('no brain key'));
    const u = new URL(base.replace(/\/+$/, '') + '/chat/completions');
    const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false });
    const req = https.request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'content-length': Buffer.byteLength(body), 'user-agent': userAgent || 'ghost-signals-records' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`brain ${res.statusCode}: ${text.slice(0, 200)}`));
        try {
          const j = JSON.parse(text);
          const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (typeof out !== 'string') return reject(new Error('brain: no content'));
          resolve(out.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('brain timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Parse a list the model returned, one item per line, numbered or not. */
function parseList(text, n) {
  const items = String(text || '').split(/\n+/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim().replace(/^["'“]+|["'”]+$/g, '').trim())
    .filter((l) => l && l.length <= 100 && !/^(here|sure|okay|of course)/i.test(l));
  const seen = new Set();
  const out = [];
  for (const i of items) { const k = i.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(i); } }
  return n ? out.slice(0, n) : out;
}

module.exports = { chat, parseList };
