'use strict';
// NoVampPad's one rule: every coin must be an original. This keeps the list of coins already launched here and says whether a new
// coin copies one: the same ticker, the same name, or a picture that looks the same. Matching is done on a "skeleton" of each, so
// "PEPE", "pepe", "P3P3" and "Pépé" are the same ticker, and a picture with one pixel changed is still the same picture.
//
// A coin is held ("reserved") while its launch is being signed, so two people cannot both pass the check for the same ticker, and
// it becomes permanent ("confirmed") once the coin exists on-chain.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOOKALIKE = { 0: 'o', 1: 'l', i: 'l', 3: 'e', 5: 's', 7: 't', '@': 'a', $: 's',
  // Cyrillic and Greek letters that look like Latin ones
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'l', ѕ: 's', ј: 'j', ԁ: 'd', ɡ: 'g', ο: 'o', ρ: 'p', α: 'a', ν: 'v', τ: 't', ε: 'e' };
const FILLER = new Set(['the', 'coin', 'token', 'official', 'new', 'inu']);

function skeleton(text) {
  const base = String(text === undefined || text === null ? '' : text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of base) {
    const m = Object.prototype.hasOwnProperty.call(LOOKALIKE, ch) ? LOOKALIKE[ch] : ch;
    if (/[a-z0-9]/.test(m)) out += m;
  }
  return out;
}
const symbolKey = s => skeleton(String(s || '').replace(/^\$/, ''));
// Names also ignore filler words ("The", "Coin", "Official") so "Pepe" and "The Pepe Coin" match.
const nameKey = n => skeleton(String(n || '').toLowerCase().split(/[^a-z0-9]+/i).filter(w => w && !FILLER.has(w)).join(' '));

// A 64-bit "difference hash": the picture shrunk to 9x8 grey squares, each bit says whether a square is brighter than its right-hand
// neighbour. Similar pictures differ in only a few bits. Without the image library, falls back to an exact fingerprint.
let sharpLib;
function sharp() {
  if (sharpLib === undefined) { try { sharpLib = require('sharp'); } catch (e) { sharpLib = null; } }
  return sharpLib;
}
async function imageHash(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  const s = sharp();
  if (s) {
    try {
      const raw = await s(buf, { failOn: 'none' }).flatten({ background: '#ffffff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
      let bits = 0n;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (raw[y * 9 + x] > raw[y * 9 + x + 1] ? 1n : 0n);
      return 'd:' + bits.toString(16).padStart(16, '0');
    } catch (e) { /* not an image the library can read: fall through to the exact fingerprint */ }
  }
  return 'x:' + crypto.createHash('sha256').update(buf).digest('hex');
}
function distance(a, b) {
  if (!a || !b || a[0] !== 'd' || b[0] !== 'd') return a && b && a === b ? 0 : 64;
  let x = BigInt('0x' + a.slice(2)) ^ BigInt('0x' + b.slice(2)), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

function createUnique(opts) {
  const o = opts || {};
  const file = o.file || '';
  const now = o.now || Date.now;
  const ttlMs = o.ttlMs || 10 * 60 * 1000;
  const maxDistance = o.maxDistance === undefined ? 6 : o.maxDistance;
  const logger = o.logger || console;
  let items = [];
  if (file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d)) items = d.filter(x => x && typeof x.key === 'string'); } catch (e) { /* first run */ } }

  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(items)); fs.renameSync(file + '.tmp', file); }
    catch (e) { logger.error('Originals list save failed: ' + (e && e.message)); }
  }
  const active = x => x.confirmed || now() < x.expiresAt;

  // Does this coin copy one already launched or being launched? Returns { ok: true } or { ok: false, error, by }.
  function check(c) {
    const sk = symbolKey(c.symbol), nk = nameKey(c.name), h = c.hash || '';
    if (!sk) return { ok: false, error: 'bad_symbol' };
    for (const x of items) {
      if (!active(x) || x.creator === c.creator && !x.confirmed) continue; // your own unfinished launch does not block you
      const by = { symbol: x.symbol, name: x.name, mint: x.confirmed ? x.mint : '' };
      if (x.sk === sk) return { ok: false, error: 'ticker_taken', by };
      if (nk && x.nk === nk) return { ok: false, error: 'name_taken', by };
      if (h && x.hash && distance(h, x.hash) <= maxDistance) return { ok: false, error: 'picture_taken', by };
    }
    return { ok: true };
  }

  // Hold the ticker, name and picture for this launch. `key` is anything unique until the coin's address is known.
  function reserve(key, c) {
    // Starting again replaces your own earlier unfinished launch.
    items = items.filter(x => x.confirmed || x.creator !== c.creator || !active(x));
    items.push({ key, mint: '', symbol: String(c.symbol || ''), name: String(c.name || ''), sk: symbolKey(c.symbol), nk: nameKey(c.name), hash: c.hash || '', creator: c.creator || '', confirmed: false, at: now(), expiresAt: now() + ttlMs });
    save();
  }
  function rename(key, mint) { const x = items.find(i => i.key === key); if (x) { x.key = mint; x.mint = mint; save(); } }
  function release(key) { const n = items.length; items = items.filter(x => x.key !== key || x.confirmed); if (items.length !== n) save(); }
  // The coin exists on-chain. This holds even after the hold expired: what is on-chain cannot be undone.
  function confirm(mint) { const x = items.find(i => i.key === mint); if (x && !x.confirmed) { x.confirmed = true; x.expiresAt = 0; save(); return true; } return false; }
  function prune() { const n = items.length; items = items.filter(x => x.confirmed || now() < x.expiresAt + 24 * 3600 * 1000); if (items.length !== n) save(); }
  const size = () => items.filter(x => x.confirmed).length;
  const originals = limit => items.filter(x => x.confirmed).slice(-limit).reverse().map(x => ({ mint: x.mint, symbol: x.symbol, name: x.name }));
  return { check, reserve, rename, release, confirm, prune, size, originals };
}

module.exports = { createUnique, symbolKey, nameKey, skeleton, imageHash, distance };
