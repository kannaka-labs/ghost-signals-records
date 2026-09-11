'use strict';
// The free door: while the house has generator credits and no card is being
// taken, an album is on the house. Pure policy, so every refusal has a reason
// a person can read and a test can pin.
//
// Why caps at all: a free album spends real generator credit. The caps are
// what keep one visitor, or one loud day, from emptying the tank before the
// operator notices.

const { TIERS } = require('./catalog');

/** Tier order, smallest first, for the max-tier cap. */
const ORDER = ['ep', 'album', 'double'];

/**
 * Decide whether this order may be built free.
 *
 * @param {object} a
 * @param {'auto'|'on'|'off'} a.mode        `auto` = free only while payments are unconfigured
 * @param {boolean} a.paymentsEnabled       whether Stripe is configured
 * @param {string}  a.tier                  the order's tier
 * @param {string}  a.maxTier               the largest tier the house gives away
 * @param {number|null} a.credits           generator credits remaining, or null if unknown
 * @param {number}  a.creditsPerTrack       estimated cost of one track
 * @param {number}  a.minCredits            credits that must remain AFTER this album
 * @param {number}  a.grantedToday          free albums already granted in the window
 * @param {number}  a.dailyLimit            how many the house gives per window
 * @param {number}  a.grantedToVisitor      free albums this visitor already has
 * @param {number}  a.visitorLimit          how many one visitor may have
 * @returns {{ok: boolean, reason: string, estimate: number|null}}
 */
function freeAllowed(a) {
  const tracks = (TIERS[a.tier] || {}).tracks || 0;
  const estimate = Number.isFinite(a.creditsPerTrack) ? tracks * a.creditsPerTrack : null;
  const no = (reason) => ({ ok: false, reason, estimate });

  if (a.mode === 'off') return no('the free door is closed');
  if (a.mode !== 'on' && a.paymentsEnabled) return no('payments are configured; the free door is closed');
  if (!TIERS[a.tier]) return no(`unknown tier ${a.tier}`);

  const maxIdx = ORDER.indexOf(a.maxTier);
  if (maxIdx >= 0 && ORDER.indexOf(a.tier) > maxIdx) {
    return no(`the house gives away up to ${TIERS[a.maxTier].label.toLowerCase()}; this is a ${TIERS[a.tier].label.toLowerCase()}`);
  }
  if (a.grantedToVisitor >= a.visitorLimit) {
    return no(a.visitorLimit === 1 ? 'you already have one on the house' : `you already have ${a.grantedToVisitor} on the house`);
  }
  if (a.grantedToday >= a.dailyLimit) return no("the house's free albums for today are gone");
  if (a.credits === null) return no('the generator did not report its credits');
  if (estimate !== null && a.credits - estimate < a.minCredits) {
    return no('the house is low on generator credit');
  }
  return { ok: true, reason: 'on the house while credits last', estimate };
}

/** What a visitor is told when the door is shut and no card can be taken. */
function heldLine(reason, publicId) {
  return `I cannot start this one yet: ${reason}. Your order is held as ${publicId}; the operator can release it.`;
}

module.exports = { freeAllowed, heldLine, ORDER };
