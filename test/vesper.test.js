'use strict';
// Vesper answers about the shelf. Without a brain key she answers from her
// own lines; without a voice engine she answers in text only; the routes
// never block on either.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clean, firstSentence, Vesper } = require('../server/vesper');

const cat = [
  { sku: 'a', title: 'Alpha Record', artist: 'Kannaka', year: 2026, price: '5', tracks: [{ title: 'One' }, { title: 'Two' }], blurb: 'Two songs about the first light. Then more words.' },
  { sku: 'b', title: 'Beta Record', artist: 'Flaukowski', year: 2026, price: '5', tracks: [{ title: 'Three' }], blurb: null },
];
const cfg = { npcName: 'Vesper', dataDir: require('node:os').tmpdir(), brain: { key: '' }, vesper: { engine: 'off' } };
const v = new Vesper(cfg, { catalog: async () => cat });

test('clean: strips markdown, caps the length at a sentence end', () => {
  assert.equal(clean('**Vesper:** Hello *there*.'), 'Hello there.');
  const long = Array(100).fill('word').join(' ') + '. Tail words here';
  const out = clean(long);
  assert.ok(out.split(' ').length <= 81, out);
  assert.ok(/[.!?]$/.test(out));
  assert.equal(clean(''), null);
});

test('firstSentence takes one sentence, not a fragment', () => {
  assert.equal(firstSentence('Two songs about the first light. Then more words.'), 'Two songs about the first light.');
  assert.equal(firstSentence('short'), 'short');
});

test('without a brain she still answers, about the shelf and about payment', async () => {
  const pay = await v.answer('how do I pay for this?');
  assert.equal(pay.source, 'template');
  assert.match(pay.reply, /Five USDC/);
  const held = await v.answer('tell me about this one', { about: 'a' });
  assert.match(held.reply, /Alpha Record/);
  assert.match(held.reply, /2 tracks/);
  const rec = await v.answer('what do you recommend?');
  assert.match(rec.reply, /Record by (Kannaka|Flaukowski)/);
  const empty = await v.answer('');
  assert.equal(empty.source, 'greeting');
  assert.match(v.greeting(), /Vesper/);
});

test('the system prompt names every record and the one being held, and the voice is off cleanly', async () => {
  const sp = v.systemPrompt(cat, cat[1]);
  assert.match(sp, /Alpha Record by Kannaka/);
  assert.match(sp, /holding "Beta Record"/);
  assert.match(sp, /at most 80 words/);
  assert.equal(await v.speak('hello'), null);
  assert.equal(v.voiceFile('../etc/passwd'), null);
  assert.equal(v.voiceEnabled(), false);
});
