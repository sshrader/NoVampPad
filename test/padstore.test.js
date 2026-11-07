'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPadStore, messageFor } = require('../padstore.js');
const { verifySignature } = require('../sigverify.js');
const { createApp } = require('../server.js');
const { createArt } = require('../art.js');

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  return { address, sign: msg => crypto.sign(null, Buffer.from(msg), privateKey).toString('base64') };
}
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]);
const quiet = { log() {}, error() {} };

function form(w, over, now) {
  const f = Object.assign({ slug: 'neon-desk', name: 'Neon Desk', tagline: 'Fresh coins daily', accent: '#5b8cff', corners: 'round', ownerPct: 15, ownerWallet: w.address, links: {}, logo: png().toString('base64'), ts: now }, over);
  f.signature = w.sign(messageFor(f));
  return f;
}

test('signatures: only the wallet that signed the exact message passes', () => {
  const w = wallet(), other = wallet();
  const sig = w.sign('hello');
  assert.equal(verifySignature(w.address, 'hello', sig), true);
  assert.equal(verifySignature(w.address, 'hello!', sig), false);
  assert.equal(verifySignature(other.address, 'hello', sig), false);
  assert.equal(verifySignature(w.address, 'hello', 'not-a-signature'), false);
  assert.equal(verifySignature('nope', 'hello', sig), false);
});

test('a pad is created from a signed form and read back', () => {
  let t = 1000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10 });
  assert.equal(store.maxOwnerPct, 40);
  const w = wallet();
  const r = store.create(form(w, {}, t), { ip: '1.1.1.1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.pad.slug, 'neon-desk');
  assert.equal(store.get('neon-desk').ownerPct, 15);
  assert.equal(store.list().length, 1);
  assert.ok(store.logo('neon-desk').buf.length > 100);
  const pad = store.toPad('neon-desk');
  assert.equal(pad.name, 'Neon Desk');
  assert.equal(pad.theme.dark.accent, '#5b8cff');
  assert.equal(pad.extra.ownerWallet, w.address);
});

test('creation is refused for bad input, bad or old signatures, taken names and too many pads', () => {
  let t = 5000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10, perIpPerHour: 100 });
  const w = wallet();
  const ip = { ip: '2.2.2.2' };
  const code = (over, who) => store.create(form(who || w, over, t), ip);
  assert.equal(code({ slug: 'A' }).body.error, 'bad_slug');
  assert.equal(code({ slug: 'admin' }).body.error, 'slug_reserved');
  assert.equal(code({ name: 'x' }).body.error, 'bad_name');
  assert.equal(code({ accent: 'red' }).body.error, 'bad_color');
  assert.equal(code({ ownerPct: 41 }).body.error, 'bad_fee_share');
  assert.equal(code({ ownerPct: 1.5 }).body.error, 'bad_fee_share');
  assert.equal(code({ logo: 'AAAA' }).body.error, 'bad_logo');
  assert.equal(code({ links: { twitter: 'https://evil.example/x' } }).body.error, 'bad_links');
  // a signature by another wallet, or over different words, is refused
  const forged = form(w, {}, t); forged.signature = wallet().sign(messageFor(forged));
  assert.equal(store.create(forged, ip).body.error, 'bad_signature');
  const tampered = form(w, {}, t); tampered.ownerPct = 5;
  assert.equal(store.create(tampered, ip).body.error, 'bad_signature');
  // a signature that is too old
  const old = form(w, {}, t - 11 * 60000);
  assert.equal(store.create(old, ip).body.error, 'stale_signature');
  assert.equal(store.size(), 0);
  assert.equal(code({}).status, 201);
  assert.equal(code({}).body.error, 'slug_taken');
  assert.equal(code({ slug: 'two' }).status, 201);
  assert.equal(code({ slug: 'three' }).status, 201);
  assert.equal(code({ slug: 'four' }).body.error, 'too_many_pads');
});

test('pads and logos survive a restart when there is a data folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padstore-'));
  const t = Date.now();
  const opts = { file: path.join(dir, 'p.json'), logoDir: path.join(dir, 'logos'), logger: quiet, platformPct: 10 };
  const a = createPadStore(opts);
  assert.equal(a.create(form(wallet(), {}, t), { ip: 'x' }).status, 201);
  const b = createPadStore(opts);
  assert.equal(b.get('neon-desk').name, 'Neon Desk');
  assert.ok(b.logo('neon-desk').buf.length > 100);
});

const http = require('node:http');
const call = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], raw: Buffer.concat(chunks) }));
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});

test('server: build a pad over the API, then its page, logo and list are served; the pad page is only at /p/<name>', async () => {
  const store = createPadStore({ logger: quiet, platformPct: 10 });
  const srv = createApp({ art: createArt({}), padStore: store });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const cfg = JSON.parse((await call(port, 'GET', '/api/builder/config')).raw);
    assert.equal(cfg.maxOwnerPct, 40);
    const w = wallet();
    const made = await call(port, 'POST', '/api/pads', form(w, {}, Date.now()));
    assert.equal(made.status, 201);
    const page = await call(port, 'GET', '/p/neon-desk');
    assert.equal(page.status, 200);
    const html = page.raw.toString('utf8');
    assert.ok(html.includes('<title>Neon Desk</title>'));
    assert.ok(html.includes('--accent:#5b8cff'));
    assert.ok(html.includes('"ownerWallet":"' + w.address + '"'));
    assert.ok(!html.includes('{{'));
    const logo = await call(port, 'GET', '/pad-logo/neon-desk.png');
    assert.equal(logo.status, 200); assert.equal(logo.type, 'image/png');
    assert.equal((await call(port, 'GET', '/pad-logo/neon-desk.jpg')).status, 404);
    assert.equal((await call(port, 'GET', '/p/nope-nope')).status, 404);
    assert.equal((await call(port, 'GET', '/pad.html')).status, 404);
    assert.equal(JSON.parse((await call(port, 'GET', '/api/pads')).raw).pads.length, 1);
    assert.equal(JSON.parse((await call(port, 'GET', '/api/pads/neon-desk')).raw).pad.name, 'Neon Desk');
    // the upload route keeps a launcher's picture only if it really is one
    const up = await call(port, 'POST', '/api/art/upload', { image: png().toString('base64'), name: 'Cool Coin', ticker: '$cool', description: 'hi' });
    assert.equal(up.status, 200);
    const j = JSON.parse(up.raw);
    assert.equal(j.ticker, 'COOL');
    assert.equal((await call(port, 'GET', j.imageUrl)).status, 200);
    assert.equal((await call(port, 'POST', '/api/art/upload', { image: Buffer.from('<svg/>').toString('base64'), name: 'Cool', ticker: 'COOL' })).status, 400);
  } finally { await new Promise(r => srv.close(r)); }
});

test('a payout wallet is signed for, stored, and used as the fee receiver; empty means the owner', () => {
  const t = 7000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10, perIpPerHour: 100 });
  const w = wallet(), cold = wallet();
  const ip = { ip: '3.3.3.3' };
  // default: the signing wallet
  assert.equal(store.create(form(w, { slug: 'plain-one' }, t), ip).body.pad.payoutWallet, w.address);
  // a chosen payout wallet
  const r = store.create(form(w, { slug: 'cold-one', payoutWallet: cold.address }, t), ip);
  assert.equal(r.status, 201);
  assert.equal(r.body.pad.payoutWallet, cold.address);
  assert.equal(store.toPad('cold-one').extra.payoutWallet, cold.address);
  // swapping the payout address after signing breaks the signature
  const f = form(w, { slug: 'swap-one', payoutWallet: cold.address }, t);
  f.payoutWallet = wallet().address;
  assert.equal(store.create(f, ip).body.error, 'bad_signature');
  // a malformed payout address is refused
  assert.equal(store.create(form(w, { slug: 'bad-one', payoutWallet: 'nope' }, t), ip).body.error, 'bad_payout');
});

test('pad settings are checked: wallet lists, first-buy minimum, blocked words, and defaults', () => {
  const { normalizeSettings } = require('../padstore.js');
  const a = wallet().address, b = wallet().address;
  const ok = normalizeSettings({ ai: { coinMaker: true, style: 'pixel art' }, rules: { requireFirstBuy: true, minFirstBuySol: 0.1 }, access: { allow: [a, a], deny: [b] }, page: { about: 'Hello' } });
  assert.deepEqual(ok.settings.access.allow, [a]);           // duplicates are merged
  assert.equal(ok.settings.rules.minFirstBuySol, 0.1);
  assert.equal(ok.settings.ai.chat, true);                    // chat is on unless the owner turns it off
  assert.equal(normalizeSettings({}).settings.rules.requireFirstBuy, false);
  assert.equal(normalizeSettings({ access: { deny: ['nope'] } }).error, 'bad_list');
  assert.equal(normalizeSettings({ access: { deny: Array(101).fill(a) } }).error, 'bad_list');
  assert.equal(normalizeSettings({ rules: { requireFirstBuy: true, minFirstBuySol: 99 } }).error, 'bad_min_buy');
  assert.equal(normalizeSettings({ page: { about: 'a yellow Pikachu fan page' } }).error, 'blocked_name');
});

test('access: deny blocks launching and buying, a private pad limits launching to the list, the owner always passes', () => {
  const t = 8000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10, perIpPerHour: 100 });
  const w = wallet(), friend = wallet().address, stranger = wallet().address, banned = wallet().address;
  const ip = { ip: '4.4.4.4' };
  assert.equal(store.create(form(w, { slug: 'open-pad', settings: { access: { deny: [banned] } } }, t), ip).status, 201);
  assert.equal(store.accessFor('open-pad', stranger), '');
  assert.equal(store.accessFor('open-pad', banned), 'denied');
  assert.equal(store.buyBlocked('open-pad', banned), true);
  assert.equal(store.buyBlocked('open-pad', stranger), false);
  assert.equal(store.accessFor('open-pad', w.address), '');
  assert.equal(store.create(form(w, { slug: 'closed-pad', settings: { access: { allow: [friend], deny: [banned] } } }, t), ip).status, 201);
  assert.equal(store.accessFor('closed-pad', friend), '');
  assert.equal(store.accessFor('closed-pad', stranger), 'not_listed');
  assert.equal(store.buyBlocked('closed-pad', stranger), false);   // private limits launching, not trading
  assert.equal(store.accessFor('closed-pad', w.address), '');
  assert.equal(store.toPad('closed-pad').extra.private, true);
  assert.ok(!JSON.stringify(store.toPad('closed-pad').extra).includes(friend), 'the lists are not put in the page');
  assert.ok(!JSON.stringify(store.list()).includes(friend), 'nor in the public list');
});

test('the owner can update a pad with a signature; nobody else can; fixed fields stay fixed', () => {
  const { updateMessageFor } = require('../padstore.js');
  let t = 9000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10, perIpPerHour: 100 });
  const w = wallet(), other = wallet();
  store.create(form(w, { slug: 'edit-me' }, t), { ip: '5.5.5.5' });
  const upd = (who, over) => { const f = Object.assign({ slug: 'edit-me', ownerWallet: who.address, ts: t, accent: '#22c55e', tagline: 'New line', settings: { rules: { requireFirstBuy: true, minFirstBuySol: 0.2 } }, banner: png().toString('base64') }, over); f.signature = who.sign(updateMessageFor(f)); return f; };
  const ip = { ip: '5.5.5.5' };
  const r = store.update(upd(w), ip);
  assert.equal(r.status, 200);
  assert.equal(r.body.pad.accent, '#22c55e');
  assert.equal(r.body.pad.tagline, 'New line');
  assert.equal(r.body.pad.settings.rules.minFirstBuySol, 0.2);
  assert.equal(r.body.pad.name, 'Neon Desk');                 // unchanged
  assert.equal(r.body.pad.ownerPct, 15);                      // the fee share is fixed
  assert.ok(r.body.pad.bannerUrl.startsWith('/pad-banner/edit-me.'));
  assert.ok(store.banner('edit-me').buf.length > 100);
  assert.equal(store.update(upd(other), ip).body.error, 'not_owner');
  const forged = upd(w); forged.signature = other.sign(updateMessageFor(forged));
  assert.equal(store.update(forged, ip).body.error, 'bad_signature');
  assert.equal(store.update(upd(w, { ts: t - 3600000 }), ip).body.error, 'stale_signature');
  assert.equal(store.update(upd(w, { slug: 'nope-nope' }), ip).status, 404);
  const gone = store.update(upd(w, { removeBanner: true, banner: undefined }), ip);
  assert.equal(gone.body.pad.bannerUrl, '');
  assert.equal(store.banner('edit-me'), null);
});

test('server: the pad rules are enforced when preparing a launch', async () => {
  const store = createPadStore({ logger: quiet, platformPct: 10 });
  const w = wallet(), banned = wallet().address, stranger = wallet().address;
  assert.equal(store.create(form(w, { slug: 'rules-pad', settings: { rules: { requireFirstBuy: true, minFirstBuySol: 0.1 }, access: { deny: [banned] } } }, Date.now()), { ip: '6.6.6.6' }).status, 201);
  const seen = [];
  const launcher = { info: () => ({ enabled: true, platformPct: 10, cluster: 'devnet' }), prepare: async (b, c) => { seen.push({ b, c }); return { status: 200, body: { ok: true } }; } };
  const srv = createApp({ art: createArt({}), padStore: store, launcher });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const go = over => call(port, 'POST', '/api/launch/prepare', Object.assign({ name: 'Coin', symbol: 'COIN', creator: stranger, pad: 'rules-pad', firstBuySol: 0.2 }, over));
    assert.equal((await go()).status, 200);
    assert.equal(seen[0].c.pad.ownerPct, 15);
    const low = await go({ firstBuySol: 0.05 });
    assert.equal(low.status, 400);
    assert.equal(JSON.parse(low.raw).error, 'first_buy_required');
    assert.equal((await go({ firstBuySol: undefined })).status, 400);
    const no = await go({ creator: banned });
    assert.equal(no.status, 403);
    assert.equal(JSON.parse(no.raw).error, 'not_allowed');
    assert.equal(seen.length, 1);                              // the refused ones never reached the launcher
    assert.equal((await go({ creator: w.address })).status, 200); // the owner is never blocked
  } finally { await new Promise(r => srv.close(r)); }
});

test('server: text an owner writes (about, mascot) cannot break out of the pad page', async () => {
  const store = createPadStore({ logger: quiet, platformPct: 10 });
  const srv = createApp({ art: createArt({}), padStore: store });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const w = wallet();
    const evil = '</script><img src=x onerror=alert(1)> <b>hi</b>';
    const made = await call(port, 'POST', '/api/pads', form(w, { slug: 'evil-one', settings: { page: { about: evil }, ai: { mascotName: '"><svg onload=1>', mascotPersona: evil } } }, Date.now()));
    assert.equal(made.status, 201);
    const html = (await call(port, 'GET', '/p/evil-one')).raw.toString('utf8');
    assert.ok(!html.includes('</script><img'), 'no raw script end from the about text');
    assert.ok(!html.includes('<svg onload'));
    assert.ok(!html.includes('<b>hi</b>'));
  } finally { await new Promise(r => srv.close(r)); }
});

test('a pad can carry a pool pair, and a bad pair address is refused', () => {
  const { normalizeSettings } = require('../padstore.js');
  const mint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  const ok = normalizeSettings({ pair: { mint, symbol: 'TSLAx', name: 'Tesla xStock' } });
  assert.equal(ok.settings.pair.mint, mint);
  assert.equal(normalizeSettings({}).settings.pair.mint, '');
  assert.equal(normalizeSettings({ pair: { mint: 'not a key!' } }).error, 'bad_pair');
});

test('a holder-rewards pad pays the owner nothing, cannot also carry a pool pair, and stays that way', () => {
  const { normalizeSettings } = require('../padstore.js');
  assert.equal(normalizeSettings({}).settings.holderRewards, false);
  assert.equal(normalizeSettings({ holderRewards: true }).settings.holderRewards, true);
  assert.equal(normalizeSettings({ holderRewards: true, pair: { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' } }).error, 'holder_pair');
  const t = 9000000;
  const store = createPadStore({ now: () => t, logger: quiet, platformPct: 10, perIpPerHour: 100 });
  const w = wallet();
  const bad = store.create(form(w, { slug: 'hold-bad', ownerPct: 10, settings: { holderRewards: true } }, t), { ip: '7.7.7.7' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_fee_share');
  const ok = store.create(form(w, { slug: 'hold-ok', ownerPct: 0, settings: { holderRewards: true } }, t), { ip: '7.7.7.7' });
  assert.equal(ok.status, 201);
  assert.equal(store.settings('hold-ok').holderRewards, true);
});
