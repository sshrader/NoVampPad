'use strict';
// The launchpads people build. A pad is a record (name, look, owner, fee share) plus a logo picture. Creating one
// needs the owner's wallet to sign a message, so nobody can make a pad "owned" by a wallet they do not control.
// With a data folder (a Railway volume) pads survive restarts; without one they live in memory.
const fs = require('fs');
const path = require('path');
const { verifySignature } = require('./sigverify');
const { blockedWord, CHAIN_TERMS, normalizeLinks, imageType } = require('./art');
const pads = require('./pads');

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const RESERVED = new Set(['build', 'api', 'p', 'coin', 'admin', 'art', 'meta', 'healthz', 'www', 'app', 'pad', 'pads', 'new', 'edit', 'login', 'about', 'help', 'support', 'buildapad', 'static', 'assets', 'pad-logo']);
const MAX_LOGO_BYTES = 400000;
const MAX_PER_WALLET = 3;
const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

const MAX_LIST = 100;
const MIN_BUY = 0.01, MAX_BUY = 5;
const MAX_BANNER_BYTES = 400000;

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The exact text the owner signs. It names the pad, the wallet and the fee share, so a signature cannot be reused for
// anything else.
function messageFor(f) {
  const payout = f.payoutWallet || f.ownerWallet;
  return 'BuildAPad: create the launchpad "' + f.slug + '" owned by ' + f.ownerWallet + ' with a ' + f.ownerPct + '% fee share paid to ' + payout + '. Time: ' + f.ts;
}

// Black or white text, whichever reads better on the accent colour.
function onAccent(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.58 ? '#0a0b0d' : '#ffffff';
}

// What the owner may switch on for a pad. Anything missing falls back to off. Returns { settings } or { error }.
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ai = r.ai && typeof r.ai === 'object' ? r.ai : {};
  const rules = r.rules && typeof r.rules === 'object' ? r.rules : {};
  const access = r.access && typeof r.access === 'object' ? r.access : {};
  const page = r.page && typeof r.page === 'object' ? r.page : {};
  const list = v => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX_LIST) return null;
    const out = [];
    for (const a of v) {
      if (typeof a !== 'string' || !B58.test(a.trim())) return null;
      if (!out.includes(a.trim())) out.push(a.trim());
    }
    return out;
  };
  const allow = list(access.allow), deny = list(access.deny);
  if (allow === null || deny === null) return { error: 'bad_list' };
  const settings = {
    ai: { coinMaker: ai.coinMaker === true, style: clean(ai.style, 80), chat: ai.chat !== false, mascotName: clean(ai.mascotName, 24), mascotPersona: clean(ai.mascotPersona, 120) },
    rules: { requireFirstBuy: rules.requireFirstBuy === true, minFirstBuySol: 0 },
    access: { allow, deny },
    page: { about: clean(page.about, 500) },
    pair: { mint: '', symbol: '', name: '' },
    holderRewards: r.holderRewards === true
  };
  const pr = r.pair && typeof r.pair === 'object' ? r.pair : {};
  if (pr.mint) {
    if (typeof pr.mint !== 'string' || !B58.test(pr.mint.trim())) return { error: 'bad_pair' };
    settings.pair = { mint: pr.mint.trim(), symbol: clean(pr.symbol, 12), name: clean(pr.name, 60) };
  }
  // A holder rewards pad cannot also pick a pool pair (the two have not been proven together).
  if (settings.holderRewards && settings.pair.mint) return { error: 'holder_pair' };
  if (settings.rules.requireFirstBuy) {
    const m = rules.minFirstBuySol === undefined ? 0.05 : Number(rules.minFirstBuySol);
    if (!Number.isFinite(m) || m < MIN_BUY || m > MAX_BUY) return { error: 'bad_min_buy' };
    settings.rules.minFirstBuySol = Math.round(m * 1000) / 1000;
  }
  const texts = [settings.ai.style, settings.ai.mascotName, settings.ai.mascotPersona, settings.page.about].join(' ');
  const bw = texts.trim() ? blockedWord(texts, CHAIN_TERMS) : null;
  if (bw) return { error: 'blocked_name', word: bw };
  return { settings };
}

const DEFAULT_SETTINGS = normalizeSettings({}).settings;

// What the owner signs to change a pad later. The name, address, fee share and payout wallet cannot change.
function updateMessageFor(f) {
  return 'BuildAPad: update the launchpad "' + f.slug + '" owned by ' + f.ownerWallet + '. Time: ' + f.ts;
}

// A base64 picture checked by size and by its first bytes: { buf, ext } or null.
function readImage(b64, maxBytes) {
  if (typeof b64 !== 'string' || b64.length > Math.ceil(maxBytes * 4 / 3) + 8) return null;
  const buf = Buffer.from(b64, 'base64');
  const ext = buf.length >= 100 && buf.length <= maxBytes ? imageType(buf) : null;
  return ext ? { buf, ext } : null;
}

function createPadStore(opts) {
  const o = opts || {};
  const file = o.file || '';
  const logoDir = o.logoDir || '';
  const now = o.now || Date.now;
  const logger = o.logger || console;
  const platformPct = Number.isFinite(o.platformPct) ? o.platformPct : 10;
  const maxOwnerPct = Math.max(0, 50 - platformPct); // the launcher always keeps at least half
  const perIpPerHour = o.perIpPerHour || 5;
  const hits = new Map();
  const logos = new Map(); // slug -> Buffer, for pads made while there is no data folder, and as a read cache

  let entries = [];
  if (file) {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j)) entries = j.filter(valid); } catch (err) { /* first run */ }
  }

  function valid(e) {
    return e && typeof e === 'object' && SLUG_RE.test(e.slug || '') && typeof e.name === 'string' && B58.test(e.ownerWallet || '') && Number.isFinite(e.createdAt) && (e.logoExt === 'png' || e.logoExt === 'jpg');
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(entries));
      fs.renameSync(file + '.tmp', file);
    } catch (err) { logger.error('Pad list save failed: ' + (err && err.message)); }
  }
  function allowed(ip) {
    const t = now();
    const recent = (hits.get(ip) || []).filter(x => t - x < 3600000);
    if (recent.length >= perIpPerHour) { hits.set(ip, recent); return false; }
    recent.push(t); hits.set(ip, recent);
    if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(x => t - x < 3600000)) hits.delete(k);
    return true;
  }

  const settingsOf = e => (e.settings && normalizeSettings(e.settings).settings) || DEFAULT_SETTINGS;
  const bannerUrl = e => (e.bannerExt ? '/pad-banner/' + e.slug + '.' + e.bannerExt : '');
  // The short version used in lists. No settings and no wallet lists.
  const cardView = e => ({
    slug: e.slug, name: e.name, tagline: e.tagline, accent: e.accent, corners: e.corners,
    ownerWallet: e.ownerWallet, payoutWallet: e.payoutWallet || e.ownerWallet, ownerPct: e.ownerPct, links: e.links || {}, createdAt: e.createdAt,
    logoUrl: '/pad-logo/' + e.slug + '.' + e.logoExt
  });
  // The full version for one pad: also its settings (they are needed to fill the edit form) and banner.
  const publicView = e => Object.assign(cardView(e), { settings: settingsOf(e), bannerUrl: bannerUrl(e) });

  // Validates the form, checks the wallet's signature, and stores the pad. Never throws.
  function create(input, ctx) {
    const b = input && typeof input === 'object' ? input : {};
    const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
    if (!SLUG_RE.test(slug)) return { status: 400, body: { error: 'bad_slug' } };
    if (RESERVED.has(slug)) return { status: 400, body: { error: 'slug_reserved' } };
    const name = clean(b.name, 30);
    if (name.length < 2) return { status: 400, body: { error: 'bad_name' } };
    { const w = blockedWord(name + ' ' + slug); if (w) return { status: 400, body: { error: 'blocked_name', word: w } }; }
    const tagline = clean(b.tagline, 90);
    { const w = tagline ? blockedWord(tagline, CHAIN_TERMS) : null; if (w) return { status: 400, body: { error: 'blocked_name', word: w } }; }
    const accent = typeof b.accent === 'string' && HEX6.test(b.accent) ? b.accent.toLowerCase() : '';
    if (!accent) return { status: 400, body: { error: 'bad_color' } };
    const corners = b.corners === 'sharp' ? 'sharp' : b.corners === 'round' || b.corners === undefined ? 'round' : '';
    if (!corners) return { status: 400, body: { error: 'bad_options' } };
    const ownerPct = b.ownerPct;
    if (!Number.isInteger(ownerPct) || ownerPct < 0 || ownerPct > maxOwnerPct) return { status: 400, body: { error: 'bad_fee_share', max: maxOwnerPct } };
    if (typeof b.ownerWallet !== 'string' || !B58.test(b.ownerWallet)) return { status: 400, body: { error: 'bad_wallet' } };
    const payoutWallet = b.payoutWallet === undefined || b.payoutWallet === '' ? b.ownerWallet : b.payoutWallet;
    if (typeof payoutWallet !== 'string' || !B58.test(payoutWallet)) return { status: 400, body: { error: 'bad_payout' } };
    const links = normalizeLinks(b.links === undefined ? {} : b.links);
    if (links === null) return { status: 400, body: { error: 'bad_links' } };
    const ns = normalizeSettings(b.settings);
    if (ns.error) return { status: 400, body: { error: ns.error, word: ns.word } };
    // Holder rewards pads pay the whole creator fee to holders, so there is no owner share to set.
    if (ns.settings.holderRewards && ownerPct !== 0) return { status: 400, body: { error: 'bad_fee_share', max: 0 } };
    let banner = null;
    if (b.banner !== undefined && b.banner !== null && b.banner !== '') {
      banner = readImage(b.banner, MAX_BANNER_BYTES);
      if (!banner) return { status: 400, body: { error: 'bad_banner' } };
    }

    const logo = readImage(b.logo, MAX_LOGO_BYTES);
    if (!logo) return { status: 400, body: { error: 'bad_logo' } };

    // The signature proves the wallet's owner asked for exactly this pad, recently.
    const ts = b.ts;
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > SIGNATURE_WINDOW_MS) return { status: 400, body: { error: 'stale_signature' } };
    if (!verifySignature(b.ownerWallet, messageFor({ slug, ownerWallet: b.ownerWallet, payoutWallet, ownerPct, ts }), b.signature)) return { status: 401, body: { error: 'bad_signature' } };

    if (!allowed((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (entries.some(e => e.slug === slug)) return { status: 409, body: { error: 'slug_taken' } };
    if (entries.filter(e => e.ownerWallet === b.ownerWallet).length >= MAX_PER_WALLET) return { status: 409, body: { error: 'too_many_pads' } };

    const entry = { slug, name, tagline, accent, corners, ownerWallet: b.ownerWallet, payoutWallet, ownerPct, links, settings: ns.settings, logoExt: logo.ext === 'jpg' ? 'jpg' : 'png', createdAt: now() };
    if (banner) entry.bannerExt = banner.ext === 'jpg' ? 'jpg' : 'png';
    if (!saveImage(slug, entry.logoExt, logo.buf, '')) return { status: 500, body: { error: 'server_error' } };
    if (banner && !saveImage(slug, entry.bannerExt, banner.buf, 'banner-')) return { status: 500, body: { error: 'server_error' } };
    entries.push(entry);
    save();
    return { status: 201, body: { pad: publicView(entry) } };
  }

  // Pictures live in the logo folder: <slug>.<ext> for the logo and banner-<slug>.<ext> for the banner. Also cached in memory.
  function saveImage(slug, ext, buf, prefix) {
    logos.set(prefix + slug, buf);
    if (!logoDir) return true;
    try { fs.mkdirSync(logoDir, { recursive: true }); fs.writeFileSync(path.join(logoDir, prefix + slug + '.' + ext), buf); return true; }
    catch (err) { logger.error('Pad picture save failed: ' + (err && err.message)); return false; }
  }

  // The owner changes the look, links, settings, logo or banner. The wallet signs a short message naming the pad, and the
  // server checks it is the stored owner. The name, address, fee share and payout wallet stay fixed.
  function update(input, ctx) {
    const b = input && typeof input === 'object' ? input : {};
    const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
    const e = entries.find(x => x.slug === slug);
    if (!e) return { status: 404, body: { error: 'not_found' } };
    if (b.ownerWallet !== e.ownerWallet) return { status: 403, body: { error: 'not_owner' } };
    const ts = b.ts;
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > SIGNATURE_WINDOW_MS) return { status: 400, body: { error: 'stale_signature' } };
    if (!verifySignature(e.ownerWallet, updateMessageFor({ slug, ownerWallet: e.ownerWallet, ts }), b.signature)) return { status: 401, body: { error: 'bad_signature' } };

    const tagline = clean(b.tagline === undefined ? e.tagline : b.tagline, 90);
    { const w = tagline ? blockedWord(tagline, CHAIN_TERMS) : null; if (w) return { status: 400, body: { error: 'blocked_name', word: w } }; }
    const accent = b.accent === undefined ? e.accent : (typeof b.accent === 'string' && HEX6.test(b.accent) ? b.accent.toLowerCase() : '');
    if (!accent) return { status: 400, body: { error: 'bad_color' } };
    const corners = b.corners === undefined ? e.corners : b.corners === 'sharp' || b.corners === 'round' ? b.corners : '';
    if (!corners) return { status: 400, body: { error: 'bad_options' } };
    const links = b.links === undefined ? (e.links || {}) : normalizeLinks(b.links);
    if (links === null) return { status: 400, body: { error: 'bad_links' } };
    const ns = b.settings === undefined ? { settings: settingsOf(e) } : normalizeSettings(b.settings);
    if (ns.error) return { status: 400, body: { error: ns.error, word: ns.word } };
    let logo = null, banner = null;
    if (b.logo !== undefined && b.logo !== null && b.logo !== '') { logo = readImage(b.logo, MAX_LOGO_BYTES); if (!logo) return { status: 400, body: { error: 'bad_logo' } }; }
    if (b.banner !== undefined && b.banner !== null && b.banner !== '') { banner = readImage(b.banner, MAX_BANNER_BYTES); if (!banner) return { status: 400, body: { error: 'bad_banner' } }; }
    if (!allowed((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };

    // How a pad pays creator fees is fixed when it is built: switching it later would leave its coins on a different model.
    ns.settings.holderRewards = settingsOf(e).holderRewards === true;
    const next = Object.assign({}, e, { tagline, accent, corners, links, settings: ns.settings });
    if (logo) {
      next.logoExt = logo.ext === 'jpg' ? 'jpg' : 'png';
      if (!saveImage(slug, next.logoExt, logo.buf, '')) return { status: 500, body: { error: 'server_error' } };
    }
    if (banner) {
      next.bannerExt = banner.ext === 'jpg' ? 'jpg' : 'png';
      if (!saveImage(slug, next.bannerExt, banner.buf, 'banner-')) return { status: 500, body: { error: 'server_error' } };
    } else if (b.removeBanner === true) {
      delete next.bannerExt; logos.delete('banner-' + slug);
    }
    entries = entries.map(x => (x.slug === slug ? next : x));
    save();
    return { status: 200, body: { pad: publicView(next) } };
  }

  // Who may launch on, or buy through, this pad. The owner is never blocked and is always allowed.
  // Returns '' when fine, or 'denied' / 'not_listed'.
  function accessFor(slug, wallet) {
    const e = entries.find(x => x.slug === slug);
    if (!e || wallet === e.ownerWallet) return '';
    const a = settingsOf(e).access;
    if (a.deny.includes(wallet)) return 'denied';
    if (a.allow.length && !a.allow.includes(wallet)) return 'not_listed';
    return '';
  }
  // Buying through this site: only the deny list applies (a private pad limits who can launch, not who can trade).
  const buyBlocked = (slug, wallet) => { const e = entries.find(x => x.slug === slug); return Boolean(e && wallet !== e.ownerWallet && settingsOf(e).access.deny.includes(wallet)); };
  // The site's one built-in launchpad: made once at start from the server's own settings, not from a signed form.
  function seed(spec, logoBuf) {
    if (entries.some(e => e.slug === spec.slug)) return false;
    const entry = { slug: spec.slug, name: spec.name, tagline: spec.tagline, accent: spec.accent, corners: spec.corners || 'round', ownerWallet: spec.ownerWallet, payoutWallet: spec.ownerWallet, ownerPct: 0, links: {}, settings: normalizeSettings({}).settings, logoExt: 'png', home: true, createdAt: now() };
    if (!saveImage(spec.slug, 'png', logoBuf, '')) return false;
    entries.push(entry); save();
    return true;
  }
  const settings = slug => { const e = entries.find(x => x.slug === slug); return e ? settingsOf(e) : null; };

  const get = slug => { const e = entries.find(x => x.slug === slug); return e ? publicView(e) : null; };
  const list = (limit) => entries.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit || 12).map(cardView);

  // The logo picture: { buf, ext } or null.
  function logo(slug) {
    const e = entries.find(x => x.slug === slug);
    if (!e) return null;
    let buf = logos.get(slug);
    if (!buf && logoDir) { try { buf = fs.readFileSync(path.join(logoDir, slug + '.' + e.logoExt)); logos.set(slug, buf); } catch (err) { buf = null; } }
    return buf ? { buf, ext: e.logoExt } : null;
  }

  function banner(slug) {
    const e = entries.find(x => x.slug === slug);
    if (!e || !e.bannerExt) return null;
    let buf = logos.get('banner-' + slug);
    if (!buf && logoDir) { try { buf = fs.readFileSync(path.join(logoDir, 'banner-' + slug + '.' + e.bannerExt)); logos.set('banner-' + slug, buf); } catch (err) { buf = null; } }
    return buf ? { buf, ext: e.bannerExt } : null;
  }

  // The pad as the page templates want it (see pads.js): wording, colours and corner radius.
  function toPad(slug) {
    const e = entries.find(x => x.slug === slug);
    if (!e) return null;
    const pad = pads.normalize({
      id: e.slug, name: e.name, tagline: e.tagline || 'Launch a coin.', description: e.home ? (e.tagline + ' A pump.fun launchpad that refuses copies.') : (e.tagline || 'Launch a coin') + ' on ' + e.name + ', a Solana launchpad built with BuildAPad.',
      theme: e.home ? {} : { dark: { accent: e.accent, 'on-accent': onAccent(e.accent), edge: e.accent }, radius: e.corners === 'sharp' ? 2 : 14 }
    }, 'pad ' + e.slug);
    const s = settingsOf(e);
    // The page gets what it needs to show the right things. The wallet lists stay on the server.
    pad.extra = {
      slug: e.slug, ownerWallet: e.ownerWallet, payoutWallet: e.payoutWallet || e.ownerWallet, ownerPct: e.ownerPct, logoUrl: '/pad-logo/' + e.slug + '.' + e.logoExt, links: e.links || {},
      about: s.page.about, bannerUrl: bannerUrl(e), aiCoinMaker: s.ai.coinMaker, mascotChat: s.ai.chat, mascotName: s.ai.mascotName,
      requireFirstBuy: s.rules.requireFirstBuy, minFirstBuySol: s.rules.minFirstBuySol, private: s.access.allow.length > 0,
      pairMint: s.pair.mint, pairSymbol: s.pair.symbol, pairName: s.pair.name, holderRewards: s.holderRewards === true
    };
    return pad;
  }

  return { create, update, seed, get, list, logo, banner, toPad, settings, accessFor, buyBlocked, maxOwnerPct, platformPct, messageFor, updateMessageFor, size: () => entries.length };
}

module.exports = { createPadStore, normalizeSettings, updateMessageFor, messageFor, onAccent, SLUG_RE, RESERVED };
