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

test('the agents guide is not shadowed by the record route', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  process.env.GSR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-ag-')); process.env.GSR_PORT = '0'; process.env.GSR_BIND = '127.0.0.1';
  process.env.GSR_BASE_RPC_URLS = 'http://127.0.0.1:9/'; process.env.GSR_FFMPEG = '';
  const { main } = require('../server/index');
  const server = await main();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/store/agent-guide`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.steps[1], /402/);
    assert.equal((await fetch(`${base}/api/store/no-such-record`)).status, 404);
    const g = await (await fetch(`${base}/api/vesper/greeting`)).json();
    assert.match(g.reply, /Vesper/);
    assert.equal(g.audio, null, 'voice off in tests');
    assert.equal((await fetch(`${base}/vendor/three.module.min.js`)).status, 200);
    assert.equal((await fetch(`${base}/vendor/../server/index.js`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
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
