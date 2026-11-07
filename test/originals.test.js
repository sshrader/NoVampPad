'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server.js');
const { createArt } = require('../art.js');
const { createUnique } = require('../unique.js');

const call = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
    let t = ''; res.on('data', d => { t += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } resolve({ status: res.statusCode, body: j }); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});

async function png(seed) {
  const sharp = require('sharp');
  const svg = seed === 'a' ? '<svg width="64" height="64"><circle cx="32" cy="32" r="20" fill="#f80"/></svg>' : '<svg width="64" height="64"><rect x="0" y="0" width="22" height="64" fill="#fff"/></svg>';
  return sharp({ create: { width: 64, height: 64, channels: 3, background: '#222' } }).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

test('the launch step refuses a coin that copies an earlier one, and frees the ticker if the launch fails', async () => {
  const art = createArt({});
  const A = art.seed(await png('a'), { name: 'Frog', ticker: 'FROG' });
  const B = art.seed(await png('b'), { name: 'Toad', ticker: 'TOAD' });
  let n = 0, fail = false;
  const launcher = { info: () => ({ enabled: true, cluster: 'devnet', platformPct: 10 }), prepare: async () => (fail ? { status: 502, body: { error: 'x' } } : { status: 200, body: { mint: 'Mint' + (++n), pool: 'Pool' + n } }), step: async () => ({ status: 200, body: { step: 'done' } }) };
  const unique = createUnique({ logger: { error() {} } });
  const server = createApp({ art, launcher, launches: null, unique });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const W1 = '6CYUEjx95WJSCsYzXoEK7qnvBsA3j6i3ncGm5osGTGik', W2 = '9yjvPVhA8JM3KCaHduVtawW7xnvkXWuLJEMAnkSvpN8r';
  try {
    assert.equal((await call(port, 'POST', '/api/launch/prepare', { name: 'Frog', symbol: 'FROG', creator: W1 })).body.error, 'picture_required');
    const first = await call(port, 'POST', '/api/launch/prepare', { name: 'Frog', symbol: 'FROG', creator: W1, art: A });
    assert.equal(first.status, 200);
    // while it is being signed, nobody else can take the ticker, the name or the picture
    assert.equal((await call(port, 'POST', '/api/launch/prepare', { name: 'Other', symbol: 'fr0g', creator: W2, art: B })).body.error, 'ticker_taken');
    assert.equal((await call(port, 'POST', '/api/launch/prepare', { name: 'The Frog Coin', symbol: 'ZZZ', creator: W2, art: B })).body.error, 'name_taken');
    assert.equal((await call(port, 'POST', '/api/launch/prepare', { name: 'Zed', symbol: 'ZED', creator: W2, art: A })).body.error, 'picture_taken');
    const ok = await call(port, 'POST', '/api/launch/prepare', { name: 'Toad', symbol: 'TOAD', creator: W2, art: B });
    assert.equal(ok.status, 200);
    // the step confirms the first coin for good
    await call(port, 'POST', '/api/launch/step', { mint: first.body.mint, creator: W1 });
    assert.equal(unique.size(), 1);
    // a failed prepare frees its hold, so the same coin can be tried again
    const D = art.seed(await require('sharp')({ create: { width: 64, height: 64, channels: 3, background: '#2a6' } }).composite([{ input: Buffer.from('<svg width="64" height="64"><polygon points="32,4 60,60 4,60" fill="#fff"/></svg>') }]).png().toBuffer(), { name: 'Tri', ticker: 'TRI' });
    fail = true;
    const bad = await call(port, 'POST', '/api/launch/prepare', { name: 'Tri', symbol: 'TRI', creator: W1, art: D });
    assert.equal(bad.status, 502);
    fail = false;
    assert.equal((await call(port, 'POST', '/api/launch/prepare', { name: 'Tri', symbol: 'TRI', creator: W2, art: D })).status, 200);
  } finally { server.close(); }
});

test('the home page list shows every coin on the site, including ones launched without a pad (the founder coin)', async () => {
  const { createLaunches } = require('../launches.js');
  const A = 'BgbV6XDdNYLu7eViCQayZk2tpwTeEGpeFwETYYi8gv2k', W = '6CYUEjx95WJSCsYzXoEK7qnvBsA3j6i3ncGm5osGTGik';
  const launches = createLaunches({ inspect: async () => ({ status: 200, body: { raisedSol: 0, thresholdSol: 85, progress: 0, migrated: false } }), logger: { error() {} } });
  launches.record({ pool: A, mint: A, name: 'Founder', symbol: 'NOVAMP', creator: W, art: '', pad: '' });
  const server = createApp({ art: createArt({}), launches, homePad: 'novamppad', launcher: { info: () => ({ enabled: true, cluster: 'devnet', platformPct: 10 }) } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await call(server.address().port, 'GET', '/api/launches?pad=novamppad');
    assert.equal(r.body.launches.length, 1);
    assert.equal(r.body.launches[0].symbol, 'NOVAMP');
  } finally { server.close(); }
});
