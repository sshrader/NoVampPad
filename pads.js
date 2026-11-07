'use strict';
// A "pad" is one launchpad's look and wording, kept in a settings file: pads/<id>.json.
// The server reads it once at start (PAD=<id>, default "buildapad") and applies it to the pages it serves.
// Nothing in a pad file can add script or markup: text is escaped, colours must be hex, and fonts must come from
// Google Fonts. A mistake in a file stops the server at start with a message saying what to fix.
const fs = require('fs');
const path = require('path');

const PADS_DIR = path.join(__dirname, 'pads');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FONT_RE = /^[A-Za-z0-9 ]{1,40}$/;
const COLOR_KEYS = ['ground', 'paper', 'soft', 'text', 'muted', 'edge', 'line', 'accent', 'on-accent', 'pop', 'ok', 'bad'];

// Everything a pad may say, with the wording HatchPad has always used as the fallback.
const DEFAULTS = {
  name: 'HatchPad',
  subject: 'animal',               // the thing people describe: "animal", "robot"
  subjects: 'animals',
  tagline: 'Describe an animal. Hatch its coin.',
  description: 'Describe an animal. AI draws it and names it. Approve it, and launch it as a token on a Solana bonding curve.',
  heroTitle: 'Describe an animal. Hatch its coin.',
  heroLede: 'AI draws the mascot and names it. Keep it or toss it, then put it on a bonding curve with your wallet.',
  promptLabel: 'What animal?',
  promptPlaceholder: 'a tired heron in a crown',
  emptyText: 'Your animal shows up here',
  aboutDevnet: 'is a test launcher for animal-mascot coins. It runs on Solana devnet, so every coin and every SOL here is play money.',
  aboutMainnet: 'launches animal-mascot coins on Solana. You describe an animal, AI draws it, and your wallet launches it on a bonding curve. Coins are created by users and can lose all their value.',
  persona: 'cartoon animal mascot',
  imageStyle: 'A bold, simple, centered mascot logo of: ',
  founderName: 'HatchPad',
  founderSymbol: 'HATCH',
  founderDescription: 'The first coin hatched on HatchPad.'
};
const TEXT_LIMITS = { name: 30, subject: 20, subjects: 24, tagline: 90, description: 220, heroTitle: 90, heroLede: 300, promptLabel: 60, promptPlaceholder: 80, emptyText: 80, aboutDevnet: 400, aboutMainnet: 500, persona: 80, imageStyle: 160, founderName: 32, founderSymbol: 10, founderDescription: 200 };

function fail(file, msg) { throw new Error('Pad file ' + file + ': ' + msg); }

function text(file, key, v) {
  if (v === undefined || v === null) return DEFAULTS[key];
  if (typeof v !== 'string') fail(file, '"' + key + '" must be text.');
  const t = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return DEFAULTS[key];
  if (t.length > TEXT_LIMITS[key]) fail(file, '"' + key + '" is longer than ' + TEXT_LIMITS[key] + ' characters.');
  return t;
}

function colors(file, label, obj) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) fail(file, 'theme.' + label + ' must be an object of colours.');
  const out = {};
  Object.keys(obj).forEach(k => {
    if (COLOR_KEYS.indexOf(k) === -1) fail(file, 'theme.' + label + '.' + k + ' is not a colour name. Use: ' + COLOR_KEYS.join(', ') + '.');
    if (typeof obj[k] !== 'string' || !HEX_RE.test(obj[k])) fail(file, 'theme.' + label + '.' + k + ' must be a hex colour like #14103a.');
    out[k] = obj[k];
  });
  return out;
}

function list(file, key, v, max) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length < 2 || v.length > 60) fail(file, 'ideas.' + key + ' must be a list of 2 to 60 short words.');
  return v.map(x => {
    if (typeof x !== 'string' || !x.trim() || x.length > max) fail(file, 'ideas.' + key + ' has an entry that is empty or longer than ' + max + ' characters.');
    return x.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  });
}

// Checks a parsed pad file and fills in anything it leaves out.
function normalize(raw, file) {
  file = file || 'pad';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'must be a JSON object.');
  const pad = { id: raw.id };
  if (typeof pad.id !== 'string' || !ID_RE.test(pad.id)) fail(file, '"id" must be lowercase letters, digits and dashes, for example "my-pad".');
  Object.keys(DEFAULTS).forEach(k => { pad[k] = text(file, k, raw[k]); });
  pad.aSubject = (/^[aeiou]/i.test(pad.subject) ? 'an ' : 'a ') + pad.subject; // "an animal", "a robot"

  const t = raw.theme && typeof raw.theme === 'object' && !Array.isArray(raw.theme) ? raw.theme : {};
  if (raw.theme !== undefined && t !== raw.theme) fail(file, '"theme" must be an object.');
  pad.theme = { dark: colors(file, 'dark', t.dark), light: colors(file, 'light', t.light), fontDisplay: '', fontBody: '', fontsUrl: '', radius: null };
  if (t.radius !== undefined) {
    if (!Number.isFinite(t.radius) || t.radius < 0 || t.radius > 32) fail(file, 'theme.radius must be a number of pixels from 0 to 32.');
    pad.theme.radius = Math.round(t.radius);
  }
  ['fontDisplay', 'fontBody'].forEach(k => {
    if (t[k] === undefined) return;
    if (typeof t[k] !== 'string' || !FONT_RE.test(t[k])) fail(file, 'theme.' + k + ' must be a font name such as "Sora" (letters, digits and spaces).');
    pad.theme[k] = t[k];
  });
  if (t.fontsUrl !== undefined) {
    if (typeof t.fontsUrl !== 'string' || !/^https:\/\/fonts\.googleapis\.com\/css2\?[A-Za-z0-9:;@=&.,+_-]{1,300}$/.test(t.fontsUrl)) fail(file, 'theme.fontsUrl must be a Google Fonts link (https://fonts.googleapis.com/css2?...).');
    pad.theme.fontsUrl = t.fontsUrl;
  }

  const ideas = raw.ideas && typeof raw.ideas === 'object' && !Array.isArray(raw.ideas) ? raw.ideas : null;
  if (raw.ideas !== undefined && !ideas) fail(file, '"ideas" must be an object with moods, things and extras lists.');
  pad.ideas = ideas ? { moods: list(file, 'moods', ideas.moods, 24), things: list(file, 'things', ideas.things, 30), extras: list(file, 'extras', ideas.extras, 48) } : { moods: null, things: null, extras: null };

  const fees = raw.fees && typeof raw.fees === 'object' && !Array.isArray(raw.fees) ? raw.fees : {};
  if (raw.fees !== undefined && fees !== raw.fees) fail(file, '"fees" must be an object.');
  pad.fees = { wallet: '', platformSharePct: null };
  if (fees.wallet !== undefined) {
    if (typeof fees.wallet !== 'string' || (fees.wallet && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(fees.wallet))) fail(file, 'fees.wallet must be a Solana address.');
    pad.fees.wallet = fees.wallet;
  }
  if (fees.platformSharePct !== undefined) {
    if (!Number.isFinite(fees.platformSharePct) || fees.platformSharePct < 1 || fees.platformSharePct > 50) fail(file, 'fees.platformSharePct must be a number from 1 to 50.');
    pad.fees.platformSharePct = fees.platformSharePct;
  }
  return pad;
}

function load(id, dir) {
  const name = id || 'buildapad';
  if (!ID_RE.test(name)) throw new Error('PAD must be a pad name such as "buildapad" (letters, digits, dashes).');
  const base = dir || PADS_DIR;
  const file = path.join(base, name + '.json');
  let rawText;
  try { rawText = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('No pad file at pads/' + name + '.json. Check the PAD setting.'); }
  let raw;
  try { raw = JSON.parse(rawText); } catch (e) { throw new Error('Pad file pads/' + name + '.json is not valid JSON: ' + e.message); }
  const pad = normalize(raw, 'pads/' + name + '.json');
  if (pad.id !== name) throw new Error('Pad file pads/' + name + '.json has id "' + pad.id + '"; the id must match the file name.');
  pad.assetsDir = path.join(base, name, 'assets');
  return pad;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The colours and fonts as a <style> block that sits after the stock stylesheet.
function themeCss(pad) {
  const lines = [];
  const vars = o => Object.keys(o).map(k => '--' + k + ':' + o[k] + ';').join('');
  const t = pad.theme;
  const dark = vars(t.dark) + (t.radius !== null && t.radius !== undefined ? '--r:' + t.radius + 'px;' : '') + (t.fontBody ? '--font:"' + t.fontBody + '",system-ui,sans-serif;' : '') + (t.fontDisplay ? '--display:"' + t.fontDisplay + '",system-ui,sans-serif;' : '');
  if (dark) lines.push(':root{' + dark + '}');
  const light = vars(t.light);
  if (light) lines.push(':root[data-theme="light"]{' + light + '}');
  return lines.join('\n');
}

// What the page scripts may know about the pad.
function publicPad(pad) {
  return { id: pad.id, name: pad.name, tagline: pad.tagline, subject: pad.subject, aSubject: pad.aSubject, subjects: pad.subjects, ideas: pad.ideas, extra: pad.extra || null };
}

const TOKENS = ['name', 'subject', 'aSubject', 'tagline', 'description', 'heroTitle', 'heroLede', 'promptLabel', 'promptPlaceholder', 'emptyText', 'aboutDevnet', 'aboutMainnet'];

// Fills {{tokens}} in a page and adds the theme, the font link and window.PAD. Pages without a <head> are left alone.
function applyToHtml(html, pad, ctx) {
  const platform = (ctx && ctx.platform) || pad.name; // the site's own brand, which a built pad's page still carries
  let out = html.replace(/\{\{([A-Za-z]+)\}\}/g, (m, k) => {
    if (k === 'ogImage') return esc((ctx && ctx.origin ? ctx.origin : '') + '/banner.png');
    return TOKENS.indexOf(k) !== -1 ? esc(pad[k]) : m;
  });
  if (pad.theme.fontsUrl) out = out.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/[^"]*">/, '<link rel="stylesheet" href="' + esc(pad.theme.fontsUrl) + '">');
  const css = themeCss(pad);
  const data = JSON.stringify(Object.assign(publicPad(pad), { platform: platform })).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));
  const inject = '<script>window.PAD=' + data + ';</script>' + (css ? '<style id="pad-theme">' + css + '</style>' : '');
  if (out.indexOf('</head>') !== -1) out = out.replace('</head>', inject + '</head>');
  return out;
}

module.exports = { load, normalize, applyToHtml, themeCss, publicPad, DEFAULTS, COLOR_KEYS, PADS_DIR };
