'use strict';
// The A&R desk: a conversation that ends in a brief. Pure and deterministic:
// every step knows what it asks, how to read an answer, and what comes next.
// A language model may REPHRASE a step's line in the NPC's voice and PROPOSE
// titles; it never decides the state. Without a model the templated lines
// are the conversation, and the studio still sells albums.

const { TIERS, PALETTE, ART_DIRECTIONS } = require('./catalog');
const { validateBrief, properNounRisk, LIMITS } = require('./order-core');

const STEPS = ['greet', 'theme', 'style', 'size', 'album_title', 'track_titles', 'art', 'confirm', 'checkout', 'done'];

function fresh() {
  return { step: 'greet', brief: { theme: '', style: '', tier: '', albumTitle: '', trackTitles: [], artDirection: '', instrumental: false }, proposals: {}, turns: 0 };
}

const YES = /^(y|yes|yeah|yep|sure|ok|okay|go|do it|confirm|confirmed|sounds good|let'?s go|deal)\b/i;
const NO = /^(n|no|nope|nah|not yet|change|edit|back|wait)\b/i;

function numberWord(s) {
  const m = String(s).toLowerCase().match(/\b(four|4|eight|8|twelve|12|ep|album|double)\b/);
  if (!m) return null;
  const w = m[1];
  if (w === 'four' || w === '4' || w === 'ep') return 'ep';
  if (w === 'eight' || w === '8' || w === 'album') return 'album';
  return 'double';
}

/** Split a free-text list of titles: newlines, semicolons, commas, or
 *  numbered lines. Quotes stripped. */
function parseTitles(text) {
  const raw = String(text || '');
  let parts;
  if (/\n/.test(raw)) parts = raw.split(/\n+/);
  else if (/;/.test(raw)) parts = raw.split(/;/);
  else parts = raw.split(/,(?![^"]*")/);
  return parts
    .map((p) => p.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim())
    .filter((p) => p.length > 0 && p.length <= LIMITS.trackTitle);
}

/** The line the NPC says for a state, templated. `proposals` may carry
 *  model-made titles; the template uses them when present. */
function line(state, ctx) {
  const name = ctx.npcName || 'Vesper';
  const b = state.brief;
  const tier = TIERS[b.tier];
  const dollars = (c) => `$${(c / 100).toFixed(0)}`;
  switch (state.step) {
    case 'greet':
      return `${name} here, A&R at Ghost Signals Records. You leave with a finished album: your theme, your sound, titles, a cover, every track built and delivered to a private page. Tell me what this record is about. One sentence is enough; a paragraph is better.`;
    case 'theme':
      return `What is the record about? A feeling, a story, a place, a person, a season of your life. Say it plainly and I will keep it.`;
    case 'style': {
      const pal = PALETTE.slice(0, 5).map((p) => p.label).join(' / ');
      return `Now the sound. Describe it with instruments, tempo, era and mood, not with the names of artists; the studio refuses those. If you have no words yet, pick one: ${pal}, or ask for more.`;
    }
    case 'size':
      return `How big? An EP is four tracks (${dollars(ctx.prices.ep)}), an album is eight (${dollars(ctx.prices.album)}), a double is twelve (${dollars(ctx.prices.double)}).`;
    case 'album_title': {
      const p = state.proposals.albumTitles;
      return p && p.length
        ? `A title. Three from me: ${p.map((t) => `"${t}"`).join(', ')}. Take one, or give me yours.`
        : `A title for the record. Give me yours, or say "you choose" and I will offer three.`;
    }
    case 'track_titles': {
      const n = tier ? tier.tracks : 8;
      const p = state.proposals.trackTitles;
      return p && p.length === n
        ? `${n} tracks. My running order: ${p.map((t, i) => `${i + 1}. ${t}`).join('; ')}. Say "keep" to take it, or give me ${n} titles of your own, one per line.`
        : `${n} track titles, one per line, or say "you choose".`;
    }
    case 'art':
      return `The cover. Describe what you want to see, or pick: ${ART_DIRECTIONS.slice(0, 3).map((a, i) => `(${i + 1}) ${a}`).join('; ')}. Or say "skip" and I will read the theme.`;
    case 'confirm': {
      const price = ctx.prices[b.tier];
      const brief = `Here is the brief. "${b.albumTitle}", ${tier.label.toLowerCase()}, ${tier.tracks} tracks: ${b.trackTitles.join(' · ')}. Sound: ${b.style.slice(0, 160)}${b.style.length > 160 ? '…' : ''}. Cover: ${b.artDirection || 'from the theme'}.`;
      return ctx.freeOpen
        ? `${brief} The house is covering albums while its credits last, so there is nothing to pay. Say "confirm" and I will send it to the floor; say "change" and tell me what.`
        : `${brief} ${dollars(price)}. Say "confirm" and I will hand you the payment link; say "change" and tell me what.`;
    }
    case 'checkout':
      if (ctx.freeUrl) {
        return `On the house while the studio's credits last. I have already sent it to the floor. Your album page: ${ctx.freeUrl} . It fills in as each track finishes, an hour or two for the lot.`;
      }
      if (ctx.heldLine) return ctx.heldLine;
      return `The link is ready: ${ctx.checkoutUrl || '(payment is not configured yet; the operator has been told)'} . When it clears, the studio starts. Building takes an hour or two; the page is yours the moment it is done.`;
    case 'done':
      return `Paid, and the studio is on it. Your album page: ${ctx.albumUrl || '(pending)'} . Come back any time.`;
    default:
      return `…`;
  }
}

/** Advance the conversation with the visitor's text. Returns
 *  { state, reply, needs } where `needs` names a side effect the caller may
 *  perform before replying: 'propose_album_titles', 'propose_track_titles',
 *  'quote' (the brief is complete and validated), 'more_palette'. */
function advance(state, text, ctx) {
  const s = JSON.parse(JSON.stringify(state));
  s.turns += 1;
  const t = String(text || '').trim();
  const b = s.brief;
  let needs = null;
  let note = '';

  switch (s.step) {
    case 'greet':
    case 'theme':
      if (t.length < 8) { note = 'A little more than that; a sentence will do.'; break; }
      b.theme = t.slice(0, LIMITS.theme);
      s.step = 'style';
      break;
    case 'style': {
      if (/^more$|more options|ask for more/i.test(t)) { needs = 'more_palette'; note = PALETTE.map((p) => p.label).join(' / '); break; }
      const pick = PALETTE.find((p) => t.toLowerCase().includes(p.label) || t.toLowerCase() === p.key || t.toLowerCase().includes(p.key));
      const style = pick ? pick.style : t;
      if (style.length < 8) { note = 'Give me instruments, tempo, mood. Or pick from the list.'; break; }
      const risks = properNounRisk(style);
      if (risks.length) { note = `That names what sounds like an artist (${risks[0]}). The studio will refuse it. Tell me what they sound like instead: instruments, tempo, era, mood.`; break; }
      b.style = style.slice(0, LIMITS.style);
      b.instrumental = /\binstrumental\b|\bno vocals?\b/i.test(t);
      s.step = 'size';
      break;
    }
    case 'size': {
      const tier = numberWord(t);
      if (!tier) { note = 'Four, eight or twelve?'; break; }
      b.tier = tier;
      s.step = 'album_title';
      needs = 'propose_album_titles';
      break;
    }
    case 'album_title': {
      const p = s.proposals.albumTitles || [];
      if (/you choose|your pick|surprise me|you pick/i.test(t)) {
        if (p.length) { b.albumTitle = p[0]; s.step = 'track_titles'; needs = 'propose_track_titles'; }
        else { needs = 'propose_album_titles'; }
        break;
      }
      const m = t.match(/^(?:the )?(?:first|second|third|1st|2nd|3rd|[123])\b/i);
      if (m && p.length) {
        const idx = /first|1/.test(m[0].toLowerCase()) ? 0 : /second|2/.test(m[0].toLowerCase()) ? 1 : 2;
        b.albumTitle = p[Math.min(idx, p.length - 1)];
      } else {
        const chosen = p.find((x) => x.toLowerCase() === t.replace(/^["']|["']$/g, '').toLowerCase());
        b.albumTitle = (chosen || t.replace(/^["'“]+|["'”]+$/g, '')).slice(0, LIMITS.title);
      }
      if (b.albumTitle.length < 1) { note = 'A title, please.'; break; }
      s.step = 'track_titles';
      needs = 'propose_track_titles';
      break;
    }
    case 'track_titles': {
      const n = TIERS[b.tier].tracks;
      const p = s.proposals.trackTitles || [];
      if (/^keep\b|you choose|your order|take it|those/i.test(t) && p.length === n) {
        b.trackTitles = p.slice();
      } else {
        const titles = parseTitles(t);
        if (titles.length !== n) { note = `I count ${titles.length}; I need exactly ${n}. One per line.${p.length === n ? ' Or say "keep" for mine.' : ''}`; break; }
        b.trackTitles = titles;
      }
      s.step = 'art';
      break;
    }
    case 'art': {
      if (/^skip\b|from the theme|you choose/i.test(t)) b.artDirection = '';
      else {
        const m = t.match(/^\(?([1-6])\)?$/);
        b.artDirection = (m ? ART_DIRECTIONS[parseInt(m[1], 10) - 1] : t).slice(0, LIMITS.artDirection);
      }
      const v = validateBrief(b);
      if (!v.ok) { note = `Something in the brief will not build: ${v.errors[0]}. Let us fix the sound.`; s.step = 'style'; break; }
      s.brief = v.brief;
      s.step = 'confirm';
      break;
    }
    case 'confirm': {
      if (YES.test(t)) { s.step = 'checkout'; needs = 'quote'; break; }
      if (NO.test(t) || /\b(theme|sound|style|title|titles|tracks|cover|art|size)\b/i.test(t)) {
        const which = (t.match(/\b(theme|sound|style|title|titles|tracks|cover|art|size)\b/i) || [])[1] || '';
        const w = which.toLowerCase();
        s.step = w === 'theme' ? 'theme' : (w === 'sound' || w === 'style') ? 'style' : w === 'size' ? 'size' : (w === 'title') ? 'album_title' : (w === 'titles' || w === 'tracks') ? 'track_titles' : (w === 'cover' || w === 'art') ? 'art' : 'theme';
        note = `Say the new ${w || 'theme'}.`;
        break;
      }
      note = 'Confirm, or tell me what to change: theme, sound, size, title, tracks, cover.';
      break;
    }
    case 'checkout':
    case 'done':
      note = s.step === 'checkout' ? 'The link is above. When it clears, I start.' : 'Your album page is above.';
      break;
    default:
      break;
  }

  const reply = (note ? note + ' ' : '') + line(s, ctx);
  return { state: s, reply: reply.trim(), needs };
}

module.exports = { STEPS, fresh, advance, line, parseTitles };
