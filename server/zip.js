'use strict';
// A zip writer with no dependency. Entries are STORED, not deflated: mp3 and
// png do not compress, and a stored zip opens everywhere (Finder, Explorer,
// phones). Names are UTF-8 (general-purpose bit 11). No zip64: an album is
// tens of megabytes, far under the 4 GB line, and the writer refuses past it.
const fs = require('node:fs');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/**
 * Write `entries` ([{ name, path }] or [{ name, data: Buffer }]) to `outPath`.
 * Returns { bytes, entries }. Streams one entry at a time; the whole archive
 * is never held in memory.
 */
function writeZip(outPath, entries, { mtime = new Date() } = {}) {
  const fd = fs.openSync(outPath, 'w');
  let offset = 0;
  const central = [];
  const { time, date } = dosDateTime(mtime);
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const data = e.data !== undefined ? e.data : fs.readFileSync(e.path);
      if (data.length >= 0xFFFFFFFF) throw new Error(`${e.name}: too large for a plain zip`);
      const crc = crc32(data);
      const localOffset = offset;
      write(Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
      ]));
      write(data);
      central.push(Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(localOffset), name,
      ]));
    }
    const cdStart = offset;
    for (const c of central) write(c);
    const cdSize = offset - cdStart;
    write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)]));
  } finally {
    fs.closeSync(fd);
  }
  return { bytes: offset, entries: central.length };
}

/** Read back a zip's directory: [{ name, size, crc }]. Enough to prove a write. */
function listZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), crc: buf.readUInt32LE(p + 16), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { writeZip, listZip, crc32 };
