'use strict';
// What the studio sells, and the vocabulary the NPC steers people toward.
// Pure: no I/O.

const TIERS = {
  ep: { key: 'ep', label: 'EP', tracks: 4, blurb: 'four tracks, one idea seen from four sides' },
  album: { key: 'album', label: 'Album', tracks: 8, blurb: 'eight tracks, a full arc' },
  double: { key: 'double', label: 'Double album', tracks: 12, blurb: 'twelve tracks, a world' },
};

/** Genre families the NPC offers when someone has no words yet. Every phrase
 *  is instrument/era/mood vocabulary only: the generator refuses real artist
 *  names outright (SENSITIVE_WORD_ERROR), so the palette never contains one. */
const PALETTE = [
  { key: 'bass-lofi', label: 'heavy bass with lofi warmth', style: 'heavy bass electronic with lofi warmth, 140 BPM halftime feel, rounded sub-bass, dusty tape saturation, crisp hi-hats, wide pad haze' },
  { key: 'synthwave', label: 'night-drive synthwave', style: 'synthwave at 100 BPM, analog arpeggios, gated reverb drums, neon pad washes, restrained female vocal' },
  { key: 'folk', label: 'acoustic folk with strings', style: 'acoustic folk, fingerpicked guitar, upright bass, cello swells, warm male vocal, room reverb' },
  { key: 'jazz', label: 'late-night jazz trio', style: 'late-night jazz trio, brushed drums, walking bass, sparse piano, smoky tenor sax, live room' },
  { key: 'ambient', label: 'ambient electronica', style: 'ambient electronica at 90 BPM, evolving pads, granular textures, soft sub pulse, occasional whispered vocal' },
  { key: 'rock', label: 'garage rock with grit', style: 'garage rock, overdriven guitars, live drums, punchy bass, raw shouted vocal, short and loud' },
  { key: 'hiphop', label: 'boom-bap hip hop', style: 'boom-bap hip hop at 90 BPM, dusty drum break, chopped soul sample, deep bass, confident male rap vocal' },
  { key: 'orchestral', label: 'cinematic orchestral', style: 'cinematic orchestral, string ostinato, brass swells, taiko hits, choir pad, no vocals' },
  { key: 'metal', label: 'atmospheric metal', style: 'atmospheric metal, tremolo guitars, blast beats into halftime, growled verse over clean sung chorus' },
  { key: 'pop', label: 'bright modern pop', style: 'bright modern pop at 120 BPM, punchy drums, plucked synth hook, layered female vocal, big chorus' },
];

/** Art directions the NPC offers for the cover. */
const ART_DIRECTIONS = [
  'painted, textured brushwork, a single figure and a lot of sky',
  'high-contrast photographic, night city, neon reflections',
  'flat geometric print, three colours, bold type-free composition',
  'ink and gold leaf on dark paper, ornamental',
  'soft film grain, dawn light, an empty landscape',
  'pixel art, sixteen colours, a scene with one impossible detail',
];

function tierFor(key) {
  return TIERS[key] || null;
}

function tierForTrackCount(n) {
  if (n <= 4) return TIERS.ep;
  if (n <= 8) return TIERS.album;
  return TIERS.double;
}

module.exports = { TIERS, PALETTE, ART_DIRECTIONS, tierFor, tierForTrackCount };
