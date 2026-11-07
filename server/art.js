'use strict';
// Cover art, the pure half. The pictures are painted by our own generator,
// kannaka-art (SDXL on a qBraid GPU, driven from debain2 by
// ops/cover-runner/gsr_cover_runner.py); covers.js is the queue between this
// server and that runner. Nothing here touches the network or the disk.
const crypto = require('node:crypto');

// kannaka-art's planner refuses a subject that asks for writing, because SDXL
// renders writing as garbage. This is a copy of its regex (kannaka_art.py
// _FORBIDDEN_RE); the runner re-checks every subject with the planner's own
// function before a pod starts, so a drift here costs one job, not a batch.
const PLANNER_FORBIDDEN_RE = /\b(texts?|logos?|letters?|words?|signs?|signage|signposts?)\b/gi;

// Words that pull SDXL toward lettering or a framed "product" even though the
// planner allows them: an album cover has a title on it, a poster has type.
const LETTERING_RE = /\b(album\s+covers?|cover\s+art|album|posters?|typography|typefaces?|fonts?|titles?|captions?|lettering|headlines?|calligraphy|graffiti|banners?|labels?|books?|pages?|newspapers?|menus?|screens?|monitors?)\b/gi;

// Faces: the house rule is no faces at all; any figure is seen from behind or
// as a silhouette. These words ask for exactly what the rule forbids.
const FACE_RE = /\b(faces?|portraits?|selfies?|close-?ups?|headshots?|eyes)\b/gi;

// The theme and art direction are a buyer's free text, and SDXL base has no
// safety checker. A subject that asks for sexual or violent imagery is not
// painted: the theme is dropped and the art direction alone paints the sleeve.
const UNSAFE_RE = /\b(nsfw|nud(e|es|ity)|naked|topless|sex|sexy|sexual\w*|erotic\w*|porn\w*|explicit|genital\w*|breasts?|nipples?|lingerie|fetish\w*|bdsm|gore|gory|bloody|bleeding|blood|corpses?|dead\s+bod(y|ies)|dismember\w*|decapitat\w*|behead\w*|mutilat\w*|tortur\w*|suicide|self-?harm|murder\w*|kill\w*|wounds?|guts|massacre|execution|hanged|lynch\w*|swastika\w*|nazi\w*)\b/i;

const DEFAULT_DIRECTION = 'painted, textured brushwork, a single figure and a lot of sky';
const NEUTRAL_THEME = 'a quiet landscape at dusk, distant lights, still air';
const SILHOUETTE = 'any figure seen from behind or as a faceless silhouette';
const MAX_SUBJECT = 300;

function tidy(s) {
  return String(s || '')
    .replace(/["“”'‘’`]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([,.;:])(?:\s*[,.;:])+/g, '$1')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '')
    .trim();
}

function strip(s) {
  return tidy(String(s || '').replace(PLANNER_FORBIDDEN_RE, ' ').replace(LETTERING_RE, ' ').replace(FACE_RE, ' '));
}

/** The words of a subject the planner would refuse (lower case, sorted). */
function plannerForbidden(s) {
  const hits = String(s || '').match(PLANNER_FORBIDDEN_RE) || [];
  return [...new Set(hits.map((w) => w.toLowerCase()))].sort();
}

function unsafe(s) { return UNSAFE_RE.test(String(s || '')); }

/** The kannaka-art subject for an order's cover: art direction + theme, never
 *  the album title (a title in a prompt becomes lettering on the picture),
 *  never "album cover", no word the planner refuses, no face, and nothing a
 *  buyer could use to make us host explicit or gory imagery. At most 300
 *  characters, and the silhouette clause always survives the cut. */
function coverSubject({ theme, artDirection } = {}) {
  let dir = strip(artDirection);
  if (!dir || unsafe(dir)) dir = DEFAULT_DIRECTION;
  let th = strip(theme);
  if (!th || unsafe(th)) th = NEUTRAL_THEME;
  const tail = `, ${SILHOUETTE}`;
  let head = `${dir}, ${th}`;
  const room = MAX_SUBJECT - tail.length;
  if (head.length > room) head = tidy(head.slice(0, room).replace(/\s+\S*$/, ''));
  const out = tidy(`${head}${tail}`);
  // Belt and braces: the cut can never reintroduce a word, but a future edit
  // to the lists could; the planner would refuse the whole batch for one.
  return plannerForbidden(out).length ? tidy(out.replace(PLANNER_FORBIDDEN_RE, ' ')) : out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** {width, height} from a PNG's IHDR, or null when the bytes are not a PNG. */
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A house sleeve for an order: the same order always gets the same sleeve. */
function pickHouseSleeve(orderId, files) {
  const list = [...files].sort();
  if (!list.length) return null;
  const n = crypto.createHash('sha256').update(String(orderId)).digest().readUInt32BE(0);
  return list[n % list.length];
}

module.exports = { coverSubject, plannerForbidden, unsafe, pngInfo, pickHouseSleeve, PLANNER_FORBIDDEN_RE, MAX_SUBJECT, SILHOUETTE };
