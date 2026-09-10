'use strict';
// The order: a brief, a price, a payment, a build, a delivery. Pure state and
// validation; the database and the worker call these and never invent a
// transition of their own.

const { TIERS } = require('./catalog');

/** Order states, in the only order they may move. */
const STATES = ['briefing', 'quoted', 'paid', 'building', 'delivered', 'failed', 'cancelled'];

const TRANSITIONS = {
  briefing: ['quoted', 'cancelled'],
  quoted: ['paid', 'briefing', 'cancelled'],
  paid: ['building', 'cancelled'],
  building: ['delivered', 'failed'],
  delivered: [],
  failed: ['building'], // an operator may retry
  cancelled: [],
};

function canMove(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

const LIMITS = { theme: 600, style: 1000, title: 100, artDirection: 400, trackTitle: 100 };

/** Words that trip the generator's policy at the style field. The full list
 *  is not knowable; this catches the obvious shape (a capitalised multiword
 *  proper name, or "X-style"/"like X") so the NPC can ask for instrument and
 *  mood vocabulary instead. The generator is the final judge and the worker
 *  handles its refusal too. */
function properNounRisk(style) {
  const s = String(style || '');
  const risks = [];
  const m = s.match(/\b(?:like|sounds like|in the style of|style of|inspired by|a la|à la)\s+([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)*)/g);
  if (m) risks.push(...m);
  const caps = s.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  if (caps) {
    for (const c of caps) {
      // Sentence starts and common genre capitals are fine.
      if (/^(?:Heavy|Bright|Late|Night|Deep|Dark|Warm|Soft|Slow|Fast|Big|Low|High|Old|New)\b/.test(c)) continue;
      risks.push(c);
    }
  }
  return risks;
}

/** Validate a brief for quoting. Returns { ok, errors[] , brief } with the
 *  brief normalised (trimmed, capped, titles deduplicated). */
function validateBrief(raw) {
  const errors = [];
  const b = {};
  const str = (k, max, required) => {
    const v = raw && raw[k] !== undefined && raw[k] !== null ? String(raw[k]).trim() : '';
    if (!v && required) errors.push(`${k} is required`);
    if (v.length > max) errors.push(`${k} is longer than ${max} characters`);
    b[k] = v.slice(0, max);
  };
  str('theme', LIMITS.theme, true);
  str('style', LIMITS.style, true);
  str('albumTitle', LIMITS.title, true);
  str('artDirection', LIMITS.artDirection, false);
  const tier = TIERS[raw && raw.tier];
  if (!tier) errors.push('tier must be one of ep, album, double');
  b.tier = tier ? tier.key : '';
  let titles = Array.isArray(raw && raw.trackTitles) ? raw.trackTitles.map((t) => String(t || '').trim().slice(0, LIMITS.trackTitle)).filter(Boolean) : [];
  const seen = new Set();
  titles = titles.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (tier && titles.length !== tier.tracks) errors.push(`trackTitles must have exactly ${tier.tracks} distinct titles for ${tier.label}`);
  b.trackTitles = titles;
  b.instrumental = Boolean(raw && raw.instrumental);
  const risks = properNounRisk(b.style);
  if (risks.length) errors.push(`style names what looks like an artist or band (${risks.slice(0, 3).join('; ')}); describe the sound with genre, era, instruments and mood instead`);
  return { ok: errors.length === 0, errors, brief: b };
}

function priceCentsFor(tier, prices) {
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier ${tier}`);
  return prices[t.key];
}

/** A public id nobody can guess: 22 chars of base64url from 16 random bytes. */
function newPublicId(randomBytes) {
  return randomBytes(16).toString('base64url');
}

/** The idempotency key Stripe sees for an order's checkout: one session per
 *  order per attempt count, so a retry after a failed create is a new key
 *  and a double-click is the same key. */
function checkoutIdempotencyKey(orderId, attempt) {
  return `gsr_checkout:${orderId}:${attempt}`;
}

module.exports = {
  STATES, TRANSITIONS, LIMITS, canMove, validateBrief, properNounRisk, priceCentsFor, newPublicId, checkoutIdempotencyKey,
};
