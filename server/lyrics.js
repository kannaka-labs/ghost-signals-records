'use strict';
// Lyrics for one track: the brain writes them from the brief; without a brain
// a templated song still ships, honest about being a template. Output is the
// bracketed-section form the generator reads ([Verse], [Chorus]…).
const { chat } = require('./brain');

const SYSTEM = 'You write song lyrics. Output ONLY the lyrics, using section tags on their own lines: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus]. No title line, no commentary, no artist names. 16 to 28 short lines. Concrete images from the theme; the chorus repeats a line that carries the title.';

async function writeLyrics(brainCfg, { albumTitle, theme, style, title, index, count }) {
  const prompt = `Album: "${albumTitle}". Theme: ${theme}\nSound: ${style}\nThis is track ${index + 1} of ${count}, titled "${title}". Write its lyrics.`;
  // A 7B model on a CPU takes minutes for 500 tokens; the worker can wait.
  const cfg = { ...brainCfg, timeoutMs: Math.max(brainCfg.timeoutMs || 0, 600000) };
  try {
    const out = await chat(cfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 500, temperature: 0.8 });
    const cleaned = out.replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (cleaned.length >= 120 && /\[(?:verse|chorus)/i.test(cleaned)) return { lyrics: cleaned.slice(0, 3000), source: 'brain' };
    return { lyrics: templateLyrics({ title, theme }), source: 'template', reason: `brain output unusable (${cleaned.length} chars)` };
  } catch (e) {
    return { lyrics: templateLyrics({ title, theme }), source: 'template', reason: e.message };
  }
}

function templateLyrics({ title, theme }) {
  const t = String(title);
  const th = String(theme).replace(/\s+/g, ' ').trim();
  const frag = th.split(/[.;,]/).map((s) => s.trim()).filter(Boolean);
  const a = frag[0] || th;
  const b = frag[1] || a;
  return [
    '[Verse 1]', `We came here for ${a.toLowerCase()}`, 'Nobody told us what it costs', 'Every window on this street', 'Knows the name of what we lost', '',
    '[Chorus]', `${t}`, `Say it twice and mean it: ${t}`, 'Hold the line until the morning', `${t}`, '',
    '[Verse 2]', `They said ${b.toLowerCase()}`, 'We wrote it down and let it burn', 'Ash is just a kind of paper', 'Waiting for its turn', '',
    '[Chorus]', `${t}`, `Say it twice and mean it: ${t}`, 'Hold the line until the morning', `${t}`, '',
    '[Bridge]', 'If the signal fades, keep walking', 'The ghost of it is still a song', '',
    '[Chorus]', `${t}`, `Say it twice and mean it: ${t}`, 'Hold the line until the morning', `${t}`,
  ].join('\n');
}

/** Titles for an album, from the brain or from the theme. */
async function proposeAlbumTitles(brainCfg, { theme, style }, n = 3) {
  try {
    const out = await chat(brainCfg, [
      { role: 'system', content: 'You name records. Output exactly the requested number of album titles, one per line, no numbering, no quotes, no commentary. Two to five words each. No artist names.' },
      { role: 'user', content: `Theme: ${theme}\nSound: ${style}\nGive ${n} album titles.` },
    ], { maxTokens: 80, temperature: 0.9 });
    const { parseList } = require('./brain');
    const t = parseList(out, n);
    if (t.length === n) return t;
  } catch { /* fall through */ }
  const words = String(theme).split(/\W+/).filter((w) => w.length > 3).slice(0, 6);
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return [
    `${cap(words[0] || 'Signal')} ${cap(words[1] || 'Ghost')}`,
    `The ${cap(words[2] || 'Long')} ${cap(words[3] || 'Way')}`,
    `${cap(words[4] || 'After')} the ${cap(words[5] || 'Static')}`,
  ].slice(0, n);
}

async function proposeTrackTitles(brainCfg, { albumTitle, theme, style }, n) {
  try {
    const out = await chat(brainCfg, [
      { role: 'system', content: 'You name the tracks of a record so they read as one arc. Output exactly the requested number of titles, one per line, no numbering, no quotes, no commentary. One to five words each. No artist names.' },
      { role: 'user', content: `Album: "${albumTitle}"\nTheme: ${theme}\nSound: ${style}\nGive ${n} track titles in running order.` },
    ], { maxTokens: 200, temperature: 0.9 });
    const { parseList } = require('./brain');
    const t = parseList(out, n);
    if (t.length === n) return t;
  } catch { /* fall through */ }
  const seeds = ['Opening', 'The Door', 'First Light', 'Undertow', 'Halfway', 'The Turn', 'Static', 'Signal', 'Long Way Home', 'What Remains', 'Afterglow', 'Closing'];
  return seeds.slice(0, n).map((s, i) => (i === 0 ? `${albumTitle} (${s})` : s));
}

module.exports = { writeLyrics, templateLyrics, proposeAlbumTitles, proposeTrackTitles };
