'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pads = require('../pads.js');
const { createApp } = require('../server.js');
const { createArt } = require('../art.js');

const get = (port, p) => new Promise((resolve, reject) => {
  require('node:http').get({ host: '127.0.0.1', port, path: p }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }));
  }).on('error', reject);
});
async function serve(pad) {
  const srv = createApp({ pad, art: createArt({}) });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise(r => srv.close(r)) };
}

test('the shipped pad files are valid, and hatchpad keeps the original wording', () => {
  const h = pads.load('hatchpad');
  assert.equal(h.name, 'HatchPad');
  assert.equal(h.promptLabel, 'What animal?');
  const r = pads.load('robots');
  assert.equal(r.name, 'BoltPad');
  assert.equal(r.theme.dark.accent, '#2fd6a0');
});

test('a pad file with a mistake is refused with a message that says what to fix', () => {
  const ok = { id: 'x1' };
  assert.equal(pads.normalize(ok).name, 'HatchPad'); // everything left out falls back
  assert.throws(() => pads.normalize({ id: 'Bad Id' }), /"id"/);
  assert.throws(() => pads.normalize({ id: 'x', name: 5 }), /"name" must be text/);
  assert.throws(() => pads.normalize({ id: 'x', name: 'a'.repeat(31) }), /longer than 30/);
  assert.throws(() => pads.normalize({ id: 'x', theme: { dark: { accent: 'red; } body{display:none' } } }), /hex colour/);
  assert.throws(() => pads.normalize({ id: 'x', theme: { dark: { sparkle: '#fff' } } }), /not a colour name/);
  assert.throws(() => pads.normalize({ id: 'x', theme: { fontDisplay: 'Sora"; x' } }), /font name/);
  assert.throws(() => pads.normalize({ id: 'x', theme: { fontsUrl: 'https://evil.example/css' } }), /Google Fonts/);
  assert.throws(() => pads.normalize({ id: 'x', fees: { wallet: 'nope' } }), /Solana address/);
  assert.throws(() => pads.normalize({ id: 'x', fees: { platformSharePct: 90 } }), /1 to 50/);
  assert.throws(() => pads.load('nothere'), /No pad file/);
  assert.throws(() => pads.load('../server'), /PAD must be/);
});

test('page text is escaped, and the theme and window.PAD are added to the head', () => {
  const pad = pads.normalize({ id: 'x', name: '<b>"Bolt" & Co</b>', theme: { dark: { accent: '#112233' }, light: { ground: '#fff' }, fontDisplay: 'Sora' } });
  const out = pads.applyToHtml('<head><title>{{name}}</title></head><p>{{tagline}} {{unknown}}</p>', pad, { origin: 'https://x.test' });
  assert.ok(out.includes('<title>&lt;b&gt;&quot;Bolt&quot; &amp; Co&lt;/b&gt;</title>'));
  assert.ok(out.includes('{{unknown}}')); // unknown tokens are left as they are
  assert.ok(out.includes('--accent:#112233;'));
  assert.ok(out.includes(':root[data-theme="light"]{--ground:#fff;}'));
  assert.ok(out.includes('--display:"Sora"'));
  const m = /window\.PAD=(\{.*?\});<\/script>/.exec(out);
  assert.equal(JSON.parse(m[1]).name, '<b>"Bolt" & Co</b>'); // data is JSON, with < escaped so it cannot close the script
  assert.ok(!/window\.PAD=[^;]*<\/b>/.test(out));
});

test('the server serves the pad: name, wording and colours on the page, stock files unchanged', async () => {
  const s = await serve(pads.load('robots'));
  try {
    const page = await get(s.port, '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('<title>BoltPad</title>'));
    assert.ok(page.body.includes('Build your own launchpad.'));
    assert.ok(page.body.includes('--accent:#2fd6a0'));
    assert.ok(page.body.includes('family=Space+Grotesk'));
    assert.ok(!page.body.includes('{{'), 'every token was filled');
    assert.ok(!/HatchPad/.test(page.body), 'no leftover brand name');
    const coin = await get(s.port, '/coin.html');
    assert.ok(coin.body.includes('Coin · BoltPad'));
    const admin = await get(s.port, '/admin');
    assert.ok(admin.body.includes('Fees · BoltPad'));
    const build = await get(s.port, '/build');
    assert.ok(build.body.includes('Build a pad · BoltPad'));
    const css = await get(s.port, '/app.css');
    assert.ok(!css.body.includes('id="pad-theme"'));
  } finally { await s.close(); }
});

test('the hatchpad pad serves the page much as before', async () => {
  const s = await serve(pads.load('hatchpad'));
  try {
    const page = await get(s.port, '/');
    assert.ok(page.body.includes('<title>HatchPad</title>'));
    assert.ok(!page.body.includes('id="pad-theme"')); // no colours set, so the stock stylesheet is untouched
  } finally { await s.close(); }
});

test('a pad can replace a stock file from its own assets folder, and only by plain name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pads-'));
  fs.writeFileSync(path.join(dir, 'mine.json'), JSON.stringify({ id: 'mine', name: 'Mine' }));
  fs.mkdirSync(path.join(dir, 'mine', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine', 'assets', 'icon.svg'), '<svg id="custom"/>');
  const s = await serve(pads.load('mine', dir));
  try {
    const icon = await get(s.port, '/icon.svg');
    assert.equal(icon.body, '<svg id="custom"/>');
    const stock = await get(s.port, '/app.css');
    assert.ok(stock.status === 200 && !stock.body.includes('custom'));
    const trav = await get(s.port, '/..%2Fpads%2Fhatchpad.json');
    assert.notEqual(trav.status, 200);
  } finally { await s.close(); }
});

test('the art studio uses the pad subject and style in its prompts', async () => {
  const calls = [];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  const art = createArt({
    provider: 'openai', apiKey: 'k', subject: 'robot', persona: 'cartoon robot mascot', imageStyle: 'A neon robot logo of: ', logger: { log() {}, error() {} },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      const ok = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
      if (/images/.test(url)) return ok({ data: [{ b64_json: png.toString('base64') }] });
      return ok({ choices: [{ message: { content: '{"name":"Bolt Buddy","ticker":"BOLT","description":"A tiny helper."}' } }] });
    }
  });
  const r = await art.generate({ animal: 'a toaster with one eye' }, { ip: '1.1.1.1' });
  assert.equal(r.status, 200);
  const img = calls.find(c => /images/.test(c.url)).body.prompt;
  assert.ok(img.startsWith('A neon robot logo of: a toaster with one eye'));
  assert.ok(img.includes('not based on any existing cartoon, game, brand or person')); // the safety wording stays
  const sys = calls.find(c => /chat/.test(c.url)).body.messages[0].content;
  assert.ok(sys.includes('description of a robot'));
});

test('"a" or "an" is chosen from the subject', () => {
  assert.equal(pads.normalize({ id: 'x', subject: 'animal' }).aSubject, 'an animal');
  assert.equal(pads.normalize({ id: 'x', subject: 'robot' }).aSubject, 'a robot');
  const out = pads.applyToHtml('<head></head>Accept {{aSubject}} first.', pads.load('hatchpad'), {});
  assert.ok(out.includes('Accept an animal first.'));
});
