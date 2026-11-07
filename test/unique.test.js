'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUnique, symbolKey, nameKey, imageHash, distance } = require('../unique.js');

test('tickers match through case, symbols, look-alike characters and accents', () => {
  const k = symbolKey('PEPE');
  for (const v of ['pepe', '$PEPE', 'P3P3', 'Pépé', 'ρεpε', 'p e p e', 'PEPE!']) assert.equal(symbolKey(v), k, v);
  assert.notEqual(symbolKey('PEPE2'), k);
  assert.equal(symbolKey('---'), '');
});

test('names ignore filler words and punctuation', () => {
  assert.equal(nameKey('The Pepe Coin'), nameKey('pepe'));
  assert.equal(nameKey('Official PEPE Token!'), nameKey('Pepe'));
  assert.notEqual(nameKey('Pepe Frog'), nameKey('Pepe'));
});

test('a second coin with the same ticker, name or picture is refused; your own unfinished launch does not block you', () => {
  let t = 1000;
  const u = createUnique({ now: () => t, logger: { error() {} }, ttlMs: 1000 });
  const a = { symbol: 'FROG', name: 'Frog Money', hash: 'd:00000000000000ff', creator: 'A' };
  assert.equal(u.check(a).ok, true);
  u.reserve('tmp1', a);
  u.rename('tmp1', 'MintA');
  // another wallet, same ticker (look-alike), different name and picture
  assert.equal(u.check({ symbol: 'fr0g', name: 'Other', hash: 'd:ffffffffffffffff', creator: 'B' }).error, 'ticker_taken');
  assert.equal(u.check({ symbol: 'ZZZ', name: 'The Frog Money Coin', hash: 'd:ffffffffffffffff', creator: 'B' }).error, 'name_taken');
  // picture one bit away
  assert.equal(u.check({ symbol: 'ZZZ', name: 'Different', hash: 'd:00000000000000fe', creator: 'B' }).error, 'picture_taken');
  assert.equal(u.check({ symbol: 'ZZZ', name: 'Different', hash: 'd:ffffffffffffff00', creator: 'B' }).ok, true);
  // the same wallet is not blocked by its own unfinished reservation
  assert.equal(u.check(a).ok, true);
  u.confirm('MintA');
  assert.equal(u.check(a).ok, false);
});

test('a held launch frees up after it expires, but a confirmed coin never does', () => {
  let t = 1000;
  const u = createUnique({ now: () => t, logger: { error() {} }, ttlMs: 1000 });
  u.reserve('m1', { symbol: 'AAA', name: 'Alpha', hash: '', creator: 'A' });
  assert.equal(u.check({ symbol: 'AAA', name: 'x', hash: '', creator: 'B' }).error, 'ticker_taken');
  t += 1500;
  assert.equal(u.check({ symbol: 'AAA', name: 'x', hash: '', creator: 'B' }).ok, true);
  // it was signed after all: on-chain wins
  assert.equal(u.confirm('m1'), true);
  t += 10 * 24 * 3600 * 1000;
  assert.equal(u.check({ symbol: 'AAA', name: 'x', hash: '', creator: 'B' }).error, 'ticker_taken');
  assert.equal(u.size(), 1);
});

test('releasing a failed launch frees its ticker', () => {
  const u = createUnique({ logger: { error() {} } });
  u.reserve('k', { symbol: 'BBB', name: 'Beta', hash: '', creator: 'A' });
  u.release('k');
  assert.equal(u.check({ symbol: 'BBB', name: 'Beta', hash: '', creator: 'B' }).ok, true);
});

test('the list survives a restart', () => {
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uq-')), 'originals.json');
  const a = createUnique({ file: f, logger: { error() {} } });
  a.reserve('m', { symbol: 'CCC', name: 'Gamma', hash: 'd:0000000000000001', creator: 'A' }); a.confirm('m');
  const b = createUnique({ file: f, logger: { error() {} } });
  assert.equal(b.check({ symbol: 'ccc', name: 'x', hash: '', creator: 'B' }).error, 'ticker_taken');
});

test('picture hashing: the same picture with a pixel changed or resized still matches; a different one does not', async () => {
  let sharp; try { sharp = require('sharp'); } catch (e) { return; }
  const mk = async (draw, size) => sharp({ create: { width: size, height: size, channels: 3, background: '#202020' } }).composite(draw).png().toBuffer();
  const circle = size => Buffer.from('<svg width="' + size + '" height="' + size + '"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + size / 3 + '" fill="#ff8f3d"/></svg>');
  const stripes = size => Buffer.from('<svg width="' + size + '" height="' + size + '"><rect x="0" y="0" width="' + size / 3 + '" height="' + size + '" fill="#ffffff"/></svg>');
  const a = await mk([{ input: circle(256) }], 256);
  const big = await mk([{ input: circle(512) }], 512);
  const tweaked = await sharp(a).composite([{ input: { create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }, left: 5, top: 5 }]).png().toBuffer();
  const other = await mk([{ input: stripes(256) }], 256);
  const [ha, hb, ht, ho] = await Promise.all([imageHash(a), imageHash(big), imageHash(tweaked), imageHash(other)]);
  assert.ok(distance(ha, hb) <= 6, 'resized: ' + distance(ha, hb));
  assert.ok(distance(ha, ht) <= 6, 'tweaked: ' + distance(ha, ht));
  assert.ok(distance(ha, ho) > 6, 'different: ' + distance(ha, ho));
});
