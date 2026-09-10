'use strict';
// Read a request body as ONE buffer. Concatenating chunks as strings splits a
// multibyte character across a chunk boundary and corrupts it, which once
// broke a payment webhook's HMAC permanently. Buffer first, decode once.
function readBody(req, limitBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (d) => {
      if (done) return;
      size += d.length;
      if (size > limitBytes) { done = true; reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJson(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
}

module.exports = { readBody, readJson };
