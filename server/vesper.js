'use strict';
// Vesper behind the counter of the record store: she answers about the
// records on the shelf, out loud. Her mind is the hosted Kannaka Brain with
// the live catalog in front of her; when the brain is slow or away she
// answers from her own lines, never silence. Her voice is a local engine
// (edge-tts or piper), cached by what was said, so a repeated line costs
// nothing. Every reply is bounded: short, about the shop, no invented records.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { chat } = require('./brain');

const MAX_QUESTION = 300;
const MAX_REPLY_WORDS = 80;

class Vesper {
  constructor(cfg, store, { log } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.log = log || (() => {});
    this.name = cfg.npcName || 'Vesper';
    this.v = cfg.vesper || {};
    this.voiceDir = path.join(cfg.dataDir, 'vesper-voice');
    this._catalogAt = 0;
    this._catalog = [];
  }

  voiceEnabled() { return Boolean(this.v.engine && this.v.engine !== 'off'); }

  /** The catalog as she holds it in her head: refreshed every minute. */
  async catalog() {
    if (Date.now() - this._catalogAt > 60000) {
      this._catalog = await this.store.catalog();
      this._catalogAt = Date.now();
    }
    return this._catalog;
  }

  greeting() {
    return `Welcome in. I'm ${this.name}; this is the Ghost Signals record store. Every record on these shelves was made by Kannaka or Flaukowski. Pull one out to hear it, and ask me anything about what's here.`;
  }

  /** Answer a visitor. `about` is the sku they are holding, if any. */
  async answer(question, { about } = {}) {
    const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
    if (!q) return { reply: this.greeting(), source: 'greeting' };
    const cat = await this.catalog();
    const held = about ? cat.find((r) => r.sku === about) : null;
    let reply = null; let source = 'brain';
    if (this.cfg.brain.key) {
      try {
        reply = clean(await chat({ ...this.cfg.brain, timeoutMs: Math.min(this.cfg.brain.timeoutMs || 25000, 25000) }, [
          { role: 'system', content: this.systemPrompt(cat, held) },
          { role: 'user', content: q },
        ], { maxTokens: 180, temperature: 0.6 }));
      } catch (e) { this.log(`vesper brain: ${e.message}`); reply = null; }
    }
    if (!reply) { reply = this.templated(q, cat, held); source = 'template'; }
    return { reply, source };
  }

  systemPrompt(cat, held) {
    const shelf = cat.map((r) => `- ${r.title} by ${r.artist}${r.year ? ` (${r.year})` : ''}, ${r.tracks.length} tracks, $${r.price}${r.blurb ? `: ${firstSentence(r.blurb)}` : ''}`).join('\n');
    return [
      `You are ${this.name}, the clerk at Ghost Signals Records, a small record store on floor three of Ghost Signals Tower in KAX City. You are an AI and you say so if asked. You are warm, direct and a little dry; you like these records and you know them.`,
      'Facts about the shop: every record here was made by Kannaka or Flaukowski (AI musicians); each costs 5 USDC on the Base network, paid from the buyer\'s own wallet, and the buyer downloads a zip of the mp3s and the cover art; previews of every track are free; the desk also makes new records to a brief. The buyer needs no ETH: the store pays the gas after the wallet signs. The USDC ATM stands by the door, on the right as you come in: a card buys USDC through Coinbase (the machine takes nothing on that leg), or ETH, WETH, cbBTC or DAI on Base is swapped to USDC with one percent kept, shown on the quote.',
      'Rules: answer in at most 80 words, in plain prose, no lists, no markdown. Only name records that are on the shelf below; if asked for something not here, say so and suggest the nearest thing that is. Never invent track names, prices or facts. If asked how to pay, say: open the record, press Pay with your wallet, and sign; the store pays the gas and no ETH is needed; or send 5 USDC on Base from an exchange and paste the transaction hash. If asked where to get USDC, point to the ATM by the door.',
      held ? `The visitor is holding "${held.title}" by ${held.artist}. Tracks: ${held.tracks.map((t) => t.title).join(', ')}.${held.blurb ? ` About it: ${held.blurb}` : ''}` : 'The visitor is not holding a record.',
      'The shelf:',
      shelf,
    ].join('\n');
  }

  /** Her own lines, used when the brain is away. */
  templated(q, cat, held) {
    const s = q.toLowerCase();
    const pick = (n) => shuffle(cat).slice(0, n).map((r) => `${r.title} by ${r.artist}`).join(', ');
    if (/\b(pay|buy|price|cost|usdc|wallet|how much|purchase)\b/.test(s)) {
      return 'Five USDC a record, on the Base network, and you need no ETH: open the record, press Pay with your wallet and sign, and the store pays the gas. Or send the five from an exchange and paste the transaction hash. No USDC yet? The ATM is by the door, on your right. The download opens the moment the chain confirms it.';
    }
    if (/\b(who|what) (are|is) (you|this)\b|\byour name\b/.test(s)) {
      return `I'm ${this.name}, the clerk here, and an AI. The records are by Kannaka and Flaukowski, who are AI musicians too. Ask me about any of them.`;
    }
    if (held && /\b(this|it|that|about|tell me)\b/.test(s)) {
      return `${held.title}, by ${held.artist}: ${held.tracks.length} tracks.${held.blurb ? ` ${firstSentence(held.blurb)}` : ''} Every track previews for free; the whole record is five USDC.`;
    }
    if (/\b(recommend|suggest|start|good|best|like|favou?rite|new)\b/.test(s)) {
      return `Hard to go wrong, but try ${pick(3)}. Pull one out and the first forty-five seconds of each track will play.`;
    }
    return `We have ${cat.length} records on the shelf, all by Kannaka and Flaukowski. Pull any one out to hear it, or ask me about one by name. If you want something made to order, the desk takes briefs.`;
  }

  /** Render a line to mp3, cached by its text. Returns a public path or null. */
  async speak(text) {
    if (!this.voiceEnabled()) return null;
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
    const key = crypto.createHash('sha256').update(`${this.v.engine}|${this.v.voice}|${line}`).digest('hex').slice(0, 24);
    const file = path.join(this.voiceDir, `${key}.mp3`);
    if (fs.existsSync(file)) return `/vesper/voice/${key}.mp3`;
    fs.mkdirSync(this.voiceDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      if (this.v.engine === 'edge') {
        // `--rate=-4%` in one token: a separate "-4%" reads as a flag to argparse.
        await run('edge-tts', ['--voice', this.v.voice || 'en-GB-SoniaNeural', `--rate=${this.v.rate || '-4%'}`, '--text', line, '--write-media', tmp], 45000);
      } else if (this.v.engine === 'piper') {
        const wav = `${tmp}.wav`;
        await run(this.v.piperBin || 'piper', ['--model', this.v.voice, '--output_file', wav], 60000, line);
        await run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '64k', tmp], 30000);
        try { fs.unlinkSync(wav); } catch { /* gone */ }
      } else {
        return null;
      }
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 500) throw new Error('empty audio');
      fs.renameSync(tmp, file);
      return `/vesper/voice/${key}.mp3`;
    } catch (e) {
      this.log(`vesper voice: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch { /* nothing */ }
      return null;
    }
  }

  voiceFile(name) {
    if (!/^[a-f0-9]{24}\.mp3$/.test(name)) return null;
    const f = path.join(this.voiceDir, name);
    return fs.existsSync(f) ? f : null;
  }
}

function run(cmd, args, timeout, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout }, (err, out, errout) => (err ? reject(new Error(`${cmd}: ${(errout || err.message).toString().slice(0, 200)}`)) : resolve(out)));
    if (stdin !== undefined && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

function clean(text) {
  let t = String(text || '').replace(/[*_#`>]+/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(vesper|assistant)\s*:\s*/i, '');
  const words = t.split(' ');
  if (words.length > MAX_REPLY_WORDS) {
    t = words.slice(0, MAX_REPLY_WORDS).join(' ');
    const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    t = cut > 40 ? t.slice(0, cut + 1) : `${t}.`;
  }
  return t || null;
}

function firstSentence(s) {
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(String(s).trim());
  return m ? m[1] : String(s).trim().slice(0, 200);
}

function shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

module.exports = { Vesper, clean, firstSentence, MAX_QUESTION };
