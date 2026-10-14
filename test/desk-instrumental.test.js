'use strict';
// Outside audit 2026-10-14, finding F1: a brief that asked for "strictly
// instrumental, no vocals" came out with a style line ending in "restrained
// female vocal", because the matched palette preset was copied as is.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, advance, instrumentalStyle } = require('../server/npc-core');

// The sound description without the trailing statement the fix appends.
const sound = (style) => style.replace(/, instrumental, no vocals$/, '');
const VOCAL = /vocal|singer|singing|voice|choir|lyric/i;

const ctx = { npcName: 'Vesper', prices: { ep: 19, album: 39, double: 69 } };
function toStyleStep(text) {
  let s = fresh();
  s = advance(s, 'Theme: cold server rooms. No people.', ctx).state;
  return advance(s, text, ctx).state;
}

test('an instrumental brief keeps the preset sound but loses its vocal line', () => {
  const s = toStyleStep('strictly instrumental, no vocals, no singing, no voice. synthwave 100 BPM, neon pads only.');
  assert.equal(s.brief.instrumental, true);
  assert.doesNotMatch(sound(s.brief.style), VOCAL);
  assert.match(s.brief.style, /synthwave at 100 BPM/);
  assert.match(s.brief.style, /instrumental, no vocals$/);
});

test('"no singing" and "no voice" also mark the brief instrumental', () => {
  assert.equal(toStyleStep('synthwave, no singing please').brief.instrumental, true);
  assert.equal(toStyleStep('synthwave, no voice on it').brief.instrumental, true);
  assert.equal(toStyleStep('synthwave with a big chorus').brief.instrumental, false);
});

test('a vocal brief keeps the preset vocal line untouched', () => {
  const s = toStyleStep('synthwave');
  assert.equal(s.brief.instrumental, false);
  assert.match(s.brief.style, /restrained female vocal$/);
});

test('instrumentalStyle strips vocal phrases wherever they sit and states the fact once', () => {
  assert.equal(instrumentalStyle('bright modern pop at 120 BPM, punchy drums, plucked synth hook, layered female vocal, big chorus'),
    'bright modern pop at 120 BPM, punchy drums, plucked synth hook, big chorus, instrumental, no vocals');
  assert.doesNotMatch(sound(instrumentalStyle('ambient drones with whispered vocals and soft choir')), VOCAL);
  assert.match(instrumentalStyle('ambient drones with whispered vocals and soft choir'), /^ambient drones/);
  assert.equal(instrumentalStyle('lofi beats, instrumental'), 'lofi beats, instrumental');
  assert.equal(instrumentalStyle(''), 'instrumental, no vocals');
});
