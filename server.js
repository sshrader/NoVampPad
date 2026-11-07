'use strict';

// Static server plus the picture studio and launch API for a pump.fun launchpad. Its look and wording come from pads/<PAD>.json.
// Railway sets PORT; locally it falls back to 3000.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUnique, imageHash } = require('./unique');
const { createLauncher, metadataFor, cleanText } = require('./launch');
const { createLaunches } = require('./launches');
const { createActions } = require('./actions');
const { createVerifier } = require('./verify');
const { createArt, ID_RE, normalizeLinks, blockedWord } = require('./art');
const pads = require('./pads');
const { createPadStore } = require('./padstore');

const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };
const TEXT_TYPE = { 'Content-Type': 'text/plain; charset=utf-8' };

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(body);
}

// Reads a small JSON body. Resolves null when it is too large or not JSON.
function readJson(req, maxBytes) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', c => {
      size += c.length;
      if (over) return; // keep draining so the client gets an answer, but stop storing
      if (size > maxBytes) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// The public address of this site, used inside token metadata links.
function baseUrlFor(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return proto + '://' + host;
}

const sortKeys = o => Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {});

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createApp(opts) {
  const art = opts.art || createArt({});
  const launches = opts.launches || null;
  const launcher = opts.launcher || null;
  const founder = opts.founder || null; // { id, wallet, name, ticker, description }
  const pad = opts.pad || pads.load('novamppad');
  const padStore = opts.padStore || null;
  // NoVampPad: every coin must be an original (ticker, name and picture), when a list of originals is given.
  const unique = opts.unique || null;
  // NoVampPad is one site with one launchpad: its slug. The pad builder is off when this is set.
  const homePad = opts.homePad || '';
  // Picture uploads are limited per visitor, like pad creation.
  const uploadHits = new Map();
  // Does the wallet sit on the deny list of the pad the coin was launched on? Used by every way of buying through this site.
  const isDenied = (pool, wallet) => { const slug = launches ? launches.padOf(pool) : ''; return Boolean(slug && padStore && padStore.buyBlocked(slug, wallet)); };
  // Each pad's AI picture maker and mascot chat have their own daily limit, so one pad cannot use up the whole budget.
  const padAiCaps = { image: Number(opts.padAiDailyCap) || 30, chat: Number(opts.padChatDailyCap) || 200 };
  const padAi = new Map();
  const padAiTake = (slug, kind) => {
    const day = Math.floor(Date.now() / 86400000), key = kind + ':' + slug;
    const cur = padAi.get(key);
    if (!cur || cur.day !== day) { padAi.set(key, { day, n: 1 }); if (padAi.size > 5000) for (const [k, v] of padAi) if (v.day !== day) padAi.delete(k); return true; }
    if (cur.n >= padAiCaps[kind]) return false;
    cur.n++; return true;
  };
  // The official coin: once it exists on-chain that is remembered, and its numbers (curve, fees waiting) are refreshed at most
  // every 20 seconds, so the home page never causes a flood of chain reads.
  let founderDone = null, founderAsked = 0, founderStats = null;
  // SOL and BTC prices in USD, cached for a minute. Tries Coinbase first, then CoinGecko. Returns the last good prices if both fail.
  const priceFetch = opts.priceFetch || (typeof fetch === 'function' ? fetch : null);
  let prices = null, pricesTried = 0;
  async function getJson(u) {
    const r = await priceFetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('bad status');
    return r.json();
  }
  const okPrice = v => (Number.isFinite(v) && v > 0 && v < 1e9 ? v : null);
  async function getPrices() {
    if (!priceFetch) return null;
    if (prices && Date.now() - prices.at < 60000) return prices;
    if (Date.now() - pricesTried < 15000) return prices;
    pricesTried = Date.now();
    let sol = null, btc = null;
    try {
      const r = await Promise.all([getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot').catch(() => null), getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot').catch(() => null)]);
      sol = okPrice(Number(r[0] && r[0].data && r[0].data.amount)); btc = okPrice(Number(r[1] && r[1].data && r[1].data.amount));
    } catch (e) { /* fall through */ }
    if (sol === null || btc === null) {
      try {
        const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin&vs_currencies=usd');
        if (sol === null) sol = okPrice(Number(j && j.solana && j.solana.usd));
        if (btc === null) btc = okPrice(Number(j && j.bitcoin && j.bitcoin.usd));
      } catch (e) { /* keep what we have */ }
    }
    if (sol !== null || btc !== null) prices = { sol: sol !== null ? sol : (prices && prices.sol) || null, btc: btc !== null ? btc : (prices && prices.btc) || null, at: Date.now() };
    return prices;
  }

  // USD value of one unit of a coin's pool token: SOL when there is no pair, otherwise the pair token. null when no price is known.
  async function unitUsd(pairMint) {
    try {
      if (!pairMint) { const p = await getPrices(); return p && Number.isFinite(p.sol) ? p.sol : null; }
      if (!launcher || !launcher.pairPrices) return null;
      const m = await launcher.pairPrices([pairMint]);
      return Number.isFinite(m[pairMint]) ? m[pairMint] : null;
    } catch (e) { return null; }
  }
  // "stock" or "other" (crypto, memes) for a pair token, from pump.fun's list. Empty when the list is not available.
  async function pairKindOf(mint) {
    if (!mint || !launcher || !launcher.pairs) return '';
    try { const r = await launcher.pairs(); const hit = r.status === 200 ? r.body.pairs.find(x => x.mint === mint) : null; return hit ? hit.kind : ''; } catch (e) { return ''; }
  }
  const padPairMint = slug => { try { const st = slug && padStore ? padStore.settings(slug) : null; return (st && st.pair && st.pair.mint) || ''; } catch (e) { return ''; } };

  // A pad's chosen pool pair must be one pump.fun allows. The name and symbol are filled in from the real list, never trusted from the page.
  async function checkPair(body) {
    const st = body && body.settings && typeof body.settings === 'object' ? body.settings : null;
    const pr = st && st.pair && typeof st.pair === 'object' ? st.pair : null;
    if (!pr || !pr.mint) { if (st) delete st.pair; return null; }
    const r = launcher && launcher.pairs ? await launcher.pairs() : null;
    const hit = r && r.status === 200 ? r.body.pairs.find(x => x.mint === pr.mint) : null;
    if (!hit) return 'bad_pair';
    st.pair = { mint: hit.mint, symbol: hit.symbol, name: hit.name };
    return null;
  }

  const reportCache = new Map();
  async function founderLaunched() {
    if (!founder || !launches) return null;
    if (!founderDone) {
      if (Date.now() - founderAsked < 20000) return null;
      founderAsked = Date.now();
      // The newest launch of the picture that really exists on-chain is the official coin.
      for (const e of launches.findAllByArt(founder.id).concat(launches.findAllBySymbol(founder.ticker)).slice(0, 8)) {
        const d = await launches.detail(e.pool);
        if (d.status === 200) {
          founderDone = { pool: e.pool, mint: e.mint, name: e.name, symbol: e.symbol };
          founderStats = { at: Date.now(), d: d.body, fees: null };
          break;
        }
      }
      if (!founderDone) return null;
    }
    if (!founderStats || Date.now() - founderStats.at > 20000) {
      const at = Date.now();
      const d = await launches.detail(founderDone.pool).catch(() => null);
      let fees = founderStats ? founderStats.fees : null;
      if (launcher) { const f = await launcher.fees(founderDone.mint, { ip: 'home' }).catch(() => null); if (f && f.status === 200) fees = f.body; }
      founderStats = { at, d: d && d.status === 200 ? d.body : (founderStats && founderStats.d), fees };
    }
    const d = founderStats.d || {}, f = founderStats.fees || {};
    return Object.assign({}, founderDone, {
      raisedSol: d.raisedSol, thresholdSol: d.thresholdSol, progress: d.progress, migrated: Boolean(d.migrated), curveFull: Boolean(d.curveFull),
      createdAt: d.createdAt, feesWaitingSol: Number.isFinite(f.pendingSol) ? f.pendingSol : null, splitOk: f.splitOk === undefined ? null : Boolean(f.splitOk)
    });
  }
  const uploadAllowed = ip => {
    const t = Date.now();
    const recent = (uploadHits.get(ip) || []).filter(x => t - x < 3600000);
    if (recent.length >= 30) { uploadHits.set(ip, recent); return false; }
    recent.push(t); uploadHits.set(ip, recent);
    if (uploadHits.size > 2000) for (const [k, v] of uploadHits) if (!v.some(x => t - x < 3600000)) uploadHits.delete(k);
    return true;
  };
  const actions = createActions({ launches, launcher, cluster: launcher && launcher.info ? launcher.info().cluster : 'devnet' });
  const verifier = opts.verifier || createVerifier({});
  // Website checks fetch other people's sites, so they are limited per visitor and per coin.
  const verifyHits = new Map();
  const verifyAllowed = (key, max, windowMs) => {
    const t = Date.now();
    const recent = (verifyHits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { verifyHits.set(key, recent); return false; }
    recent.push(t); verifyHits.set(key, recent);
    if (verifyHits.size > 5000) for (const [k, v] of verifyHits) if (!v.some(x => t - x < 3600000)) verifyHits.delete(k);
    return true;
  };

  return http.createServer((req, res) => {
    let url;
    let pathname;
    let servePad = pad;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch (err) {
      return send(res, 400, 'Bad request', TEXT_TYPE);
    }
    if (pathname.indexOf('\0') !== -1) {
      return send(res, 400, 'Bad request', TEXT_TYPE);
    }

    // A coin's picture, uploaded by the person launching it. The page shrinks it to a square first; here it is checked
    // by its first bytes and kept like any other picture.
    if (req.method === 'POST' && pathname === '/api/art/upload') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      readJson(req, 700000).then(body => {
        if (!body || typeof body.image !== 'string') return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        if (!uploadAllowed(clientIp(req))) return send(res, 429, JSON.stringify({ error: 'rate_limited' }), noStore);
        const name = cleanText(body.name, 32), ticker = String(body.ticker || '').replace(/^\$/, '').trim().toUpperCase();
        if (!name || !/^[A-Z0-9]{1,10}$/.test(ticker)) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        if (blockedWord(name + ' ' + ticker)) return send(res, 400, JSON.stringify({ error: 'blocked_name' }), noStore);
        const description = cleanText(body.description || '', 200);
        if (description && blockedWord(description)) return send(res, 400, JSON.stringify({ error: 'blocked_name' }), noStore);
        const id = art.seed(Buffer.from(body.image, 'base64'), { name, ticker, description });
        if (!id) return send(res, 400, JSON.stringify({ error: 'bad_image' }), noStore);
        const rec = art.record(id);
        send(res, 200, JSON.stringify({ id, imageUrl: '/art/' + id + '.' + (rec && rec.ext === 'jpg' ? 'jpg' : 'png'), name, ticker, description }), noStore);
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // One site, one launchpad: nobody builds more.
    if (homePad && (pathname === '/build' || pathname === '/api/builder/config' || (req.method === 'POST' && /^\/api\/pads(\/|$)/.test(pathname)))) return send(res, 404, 'Not found', TEXT_TYPE);

    // Building a launchpad: the owner's wallet signed the details, the server checks and stores them.
    if (req.method === 'POST' && pathname === '/api/pads') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!padStore) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      readJson(req, 1500000).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        return checkPair(body).then(bad => {
          if (bad) return send(res, 400, JSON.stringify({ error: bad }), noStore);
          const r = padStore.create(body, { ip: clientIp(req) });
          send(res, r.status, JSON.stringify(r.body), noStore);
        });
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // Changing a pad later: the same signed-wallet idea, with a short message naming the pad.
    const upm = /^\/api\/pads\/([a-z0-9-]{2,30})\/update$/.exec(pathname);
    if (req.method === 'POST' && upm) {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!padStore) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      readJson(req, 1500000).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        return checkPair(body).then(bad => {
          if (bad) return send(res, 400, JSON.stringify({ error: bad }), noStore);
          const r = padStore.update(Object.assign({}, body, { slug: upm[1] }), { ip: clientIp(req) });
          send(res, r.status, JSON.stringify(r.body), noStore);
        });
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // The AI picture maker. It only runs for a pad whose owner switched it on, within that pad's own daily limit, in the
    // owner's picture style. It costs money, so there is no pad-less version.
    if (req.method === 'POST' && pathname === '/api/art/generate') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      readJson(req, 1200).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        const slug = typeof body.pad === 'string' ? body.pad : '';
        const set = padStore && slug ? padStore.settings(slug) : null;
        if (!set) return send(res, 400, JSON.stringify({ error: 'bad_pad' }), noStore);
        if (!set.ai.coinMaker) return send(res, 403, JSON.stringify({ error: 'ai_off' }), noStore);
        if (typeof body.wallet === 'string' && padStore.accessFor(slug, body.wallet)) return send(res, 403, JSON.stringify({ error: 'not_allowed' }), noStore);
        if (!padAiTake(slug, 'image')) return send(res, 429, JSON.stringify({ error: 'pad_daily_limit' }), noStore);
        return art.generate({ animal: body.animal }, { ip: clientIp(req), style: set.ai.style, subject: 'coin idea' }).then(r => send(res, r.status, JSON.stringify(r.body), noStore));
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // The launch helper: text-only coin ideas in the pad's theme, in the mascot's voice. Same switch as the picture maker.
    if (req.method === 'POST' && pathname === '/api/art/suggest') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      readJson(req, 1200).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        const slug = typeof body.pad === 'string' ? body.pad : '';
        const set = padStore && slug ? padStore.settings(slug) : null;
        const pad = set ? padStore.get(slug) : null;
        if (!set || !pad) return send(res, 400, JSON.stringify({ error: 'bad_pad' }), noStore);
        if (!set.ai.coinMaker) return send(res, 403, JSON.stringify({ error: 'ai_off' }), noStore);
        if (typeof body.wallet === 'string' && padStore.accessFor(slug, body.wallet)) return send(res, 403, JSON.stringify({ error: 'not_allowed' }), noStore);
        if (!padAiTake(slug, 'chat')) return send(res, 429, JSON.stringify({ error: 'pad_daily_limit' }), noStore);
        const theme = [pad.name, pad.tagline, set.ai.style, set.page && set.page.about].filter(Boolean).join('. ');
        return art.suggest({ theme, hint: body.hint, count: body.count }, { ip: clientIp(req), mascot: { name: set.ai.mascotName, persona: set.ai.mascotPersona } }).then(r => send(res, r.status, JSON.stringify(r.body), noStore));
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // Solana Actions (Blinks): wallets and viewers read /actions.json, then GET the coin's action and POST to buy.
    if (pathname === '/actions.json' || pathname.startsWith('/api/actions/')) {
      const H = actions.HEADERS;
      if (req.method === 'OPTIONS') return send(res, 204, '', H);
      if (pathname === '/actions.json') return send(res, 200, JSON.stringify(actions.rules()), H);
      const am = /^\/api\/actions\/trade\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pathname);
      const fail = (st, message) => send(res, st, JSON.stringify({ message }), H);
      if (!am) return fail(404, 'Not found.');
      const base = baseUrlFor(req);
      if (req.method === 'GET') {
        actions.describe(am[1], base).then(r => send(res, r.status, JSON.stringify(r.body), H)).catch(() => fail(500, 'Something went wrong.'));
        return;
      }
      if (req.method === 'POST') {
        readJson(req, 2048).then(body => {
          if (!body) return fail(400, 'Bad request.');
          return actions.transact(am[1], url.searchParams.get('amount'), body, { ip: clientIp(req), baseUrl: base, hasArt: () => false, isDenied: isDenied })
            .then(r => send(res, r.status, JSON.stringify(r.body), H));
        }).catch(() => fail(500, 'Something went wrong.'));
        return;
      }
      return fail(405, 'Method not allowed.');
    }

    // Check that the coin's website carries the coin's code, and remember it if so.
    if (req.method === 'POST' && pathname === '/api/coin/verify') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!launches) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      readJson(req, 1024).then(async body => {
        if (!body || typeof body.pool !== 'string') return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        const d = await launches.detail(body.pool);
        if (d.status !== 200) return send(res, d.status === 400 ? 400 : 404, JSON.stringify({ error: d.status === 400 ? 'bad_request' : 'not_found' }), noStore);
        if (!verifyAllowed('ip:' + clientIp(req), 10, 3600000) || !verifyAllowed('pool:' + body.pool, 1, 20000)) {
          return send(res, 429, JSON.stringify({ error: 'rate_limited' }), noStore);
        }
        const r = await verifier.check(d.body);
        if (r.status === 200 && r.body.verified) launches.setSiteVerified(body.pool, d.body.links.website);
        return send(res, r.status, JSON.stringify(r.body), noStore);
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // Platform fees: a read-only list for the admin page, and an unsigned claim that only the fee claimer can sign.
    if (pathname === '/api/admin/fees' && (req.method === 'GET' || req.method === 'HEAD')) {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      (launches ? launches.list().then(items => items.map(i => i.pool)) : Promise.resolve([])).then(mints => launcher.partnerFees({ ip: clientIp(req), mints })).then(r => send(res, r.status, req.method === 'HEAD' ? '' : JSON.stringify(r.body), noStore))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }
    if (pathname === '/api/admin/claim' && req.method === 'POST') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      readJson(req, 1024).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        return launcher.distribute({ pool: body.pool, payer: body.claimer }, { ip: clientIp(req) }).then(r => send(res, r.status, JSON.stringify(r.body), noStore));
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }
    // Referral link to the Lute trading terminal. The page links to /go/lute, so the address bar and hover text stay tidy.
    if (pathname === '/go/lute') {
      res.writeHead(302, { Location: process.env.LUTE_REF_URL || 'https://lute.gg/@sol_synxer', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (pathname === '/admin') pathname = '/admin.html';
    if (pathname === '/admin/launch') pathname = '/admin-launch.html';

    // The mascot's report on a coin: numbers the server read from the chain, phrased by the AI. Cached per coin, so a busy
    // page costs one short AI call every few minutes. If the AI is off or fails, the numbers are still returned.
    if (req.method === 'GET' && pathname === '/api/coin/report') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      const pool = url.searchParams.get('pool') || '';
      if (!launches || !launcher) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      (async () => {
        const hit = reportCache.get(pool);
        if (hit && Date.now() - hit.at < 300000) return send(res, 200, JSON.stringify(hit.value), noStore);
        const d = await launches.detail(pool);
        if (d.status !== 200) return send(res, d.status === 400 ? 400 : 404, JSON.stringify({ error: d.status === 400 ? 'bad_request' : 'not_found' }), noStore);
        const set = padStore && d.body.pad ? padStore.settings(d.body.pad) : null;
        if (set && !set.ai.chat) return send(res, 403, JSON.stringify({ error: 'ai_off' }), noStore);
        const act = await launcher.activity(d.body.mint || pool, { ip: clientIp(req) });
        const a = act.status === 200 ? act.body : {};
        // A coin on a pair other than SOL is reported in dollars, since its raised amount is in another token.
        const pairedCoin = Boolean(padPairMint(d.body.pad));
        const uPrice = await unitUsd(padPairMint(d.body.pad));
        const usdOf = n => (Number.isFinite(n) && Number.isFinite(uPrice) ? Number((n * uPrice).toFixed(2)) : null);
        const facts = {
          raisedSol: !pairedCoin && Number.isFinite(d.body.raisedSol) ? Number(d.body.raisedSol.toFixed(3)) : null,
          targetSol: !pairedCoin && Number.isFinite(d.body.thresholdSol) ? Number(d.body.thresholdSol.toFixed(2)) : null,
          raisedUsd: usdOf(d.body.raisedSol),
          targetUsd: usdOf(d.body.thresholdSol),
          percentFull: Number.isFinite(d.body.progress) ? Math.round(d.body.progress * 100) : null,
          graduated: d.body.migrated ? 'yes' : 'no',
          holders: a.holders === null || a.holders === undefined ? null : a.holders + (a.holdersCapped ? ' or more' : ''),
          biggestHolderPercentOfSupply: a.topHolderPct,
          percentStillOnCurve: a.onCurvePct,
          tradesLastHour: a.tradesLastHour,
          recentTrades: a.trades
        };
        const value = { report: '', mascot: set && set.ai.mascotName ? set.ai.mascotName : '', facts: facts, at: Date.now() };
        let r = null;
        if (art.info().enabled && (!d.body.pad || padAiTake(d.body.pad, 'chat'))) {
          r = await art.report(facts, { name: d.body.name, mascot: { name: value.mascot, persona: set ? set.ai.mascotPersona : '' } }).catch(() => null);
        }
        if (r && r.status === 200) value.report = r.body.report;
        reportCache.set(pool, { at: Date.now(), value });
        if (reportCache.size > 500) reportCache.delete(reportCache.keys().next().value);
        return send(res, 200, JSON.stringify(value), noStore);
      })().catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // Chat with a coin's mascot. The character is looked up from the coin itself, never taken from the request.
    if (req.method === 'POST' && pathname === '/api/coin/chat') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!launches) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      readJson(req, 4096).then(async body => {
        if (!body || typeof body.pool !== 'string') return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        const d = await launches.detail(body.pool);
        if (d.status !== 200) return send(res, d.status === 400 ? 400 : 404, JSON.stringify({ error: d.status === 400 ? 'bad_request' : 'not_found' }), noStore);
        // The coin's pad can switch chat off or give the mascot its own name and personality. Both come from the server's records.
        const set = padStore && d.body.pad ? padStore.settings(d.body.pad) : null;
        if (set && !set.ai.chat) return send(res, 403, JSON.stringify({ error: 'chat_off' }), noStore);
        if (set && !padAiTake(d.body.pad, 'chat')) return send(res, 429, JSON.stringify({ error: 'pad_daily_limit' }), noStore);
        const padRec = set ? padStore.get(d.body.pad) : null;
        const mascot = set && (set.ai.mascotName || set.ai.mascotPersona) ? { name: set.ai.mascotName, persona: set.ai.mascotPersona, pad: padRec ? padRec.name : '' } : null;
        const r = await art.chat({ name: d.body.name, description: d.body.description, mood: d.body.mood.label, message: body.message, history: body.history }, { ip: clientIp(req), mascot });
        return send(res, r.status, JSON.stringify(r.body), noStore);
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    const POSTS = { '/api/launch/prepare': 'prepare', '/api/launch/step': 'step', '/api/launch/buy': 'buy', '/api/launch/claim': 'distribute' };
    if (req.method === 'POST' && Object.prototype.hasOwnProperty.call(POSTS, pathname)) {
      const action = POSTS[pathname];
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      readJson(req, 4096).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        // The creator's links are checked first, so nothing half-valid is stored or published.
        let links = {};
        if (action === 'prepare' && body.links !== undefined) {
          links = normalizeLinks(body.links);
          if (links === null || (Object.keys(links).length && !(typeof body.art === 'string' && art.record(body.art)))) {
            return send(res, 400, JSON.stringify({ error: 'bad_links' }), noStore);
          }
          // Once a launch has been prepared for this picture its links are frozen. The same links again
          // (a retry after declining in the wallet) are fine; different ones are refused, not ignored.
          const rec = typeof body.art === 'string' ? art.record(body.art) : null;
          // The founder picture is exempt: only the founder wallet can launch it, so its links stay editable.
          const isFounderArt = Boolean(founder && body.art === founder.id);
          if (rec && rec.pinned && !isFounderArt && JSON.stringify(sortKeys(links)) !== JSON.stringify(sortKeys(rec.links || {}))) {
            return send(res, 409, JSON.stringify({ error: 'links_locked' }), noStore);
          }
        }
        // Names and tickers go on a public list, so they get the same character-and-brand check as prompts.
        if (action === 'prepare' && blockedWord(String(body.name || '') + ' ' + String(body.symbol || ''))) {
          return send(res, 400, JSON.stringify({ error: 'blocked_name' }), noStore);
        }
        // The payout can be sent by any wallet, so the page's "creator" field is just the wallet that will pay the network fee.
        if (action === 'distribute' && body.payer === undefined) body.payer = body.creator;
        // The pad decides the fee split, and it comes from the server's own records: the pad named when the coin was
        // prepared, then the one stored with the coin. Nothing about fees is taken from the browser.
        let padCtx = null, padSlug = '';
        if (padStore && (action === 'prepare' || action === 'step')) {
          padSlug = action === 'prepare' ? String(body.pad || '') : (launches ? launches.padOf(String(body.mint || '')) : '');
          const rec = padSlug ? padStore.get(padSlug) : null;
          if (action === 'prepare' && padSlug && !rec) return send(res, 400, JSON.stringify({ error: 'bad_pad' }), noStore);
          if (rec) padCtx = { owner: rec.payoutWallet || rec.ownerWallet, ownerPct: rec.ownerPct, pair: process.env.PAIRS_LAUNCH === 'yes' && rec.settings.pair ? rec.settings.pair.mint : '', holderRewards: rec.settings.holderRewards === true };
          if (rec && action === 'prepare') {
            // The pad's rules, checked here from the server's own records.
            const why = typeof body.creator === 'string' ? padStore.accessFor(padSlug, body.creator) : '';
            if (why) return send(res, 403, JSON.stringify({ error: 'not_allowed', reason: why }), noStore);
            // Launching with a pool pair other than SOL is not switched on yet: the launch steps still assume SOL.
            if (rec.settings.pair && rec.settings.pair.mint && process.env.PAIRS_LAUNCH !== 'yes') return send(res, 409, JSON.stringify({ error: 'pair_not_ready', pair: rec.settings.pair.symbol }), noStore);
            // Holder-rewards pads need pump.fun's holder-rewards coins, which are switched on per site.
            if (rec.settings.holderRewards && process.env.HOLDER_REWARDS !== 'yes') return send(res, 409, JSON.stringify({ error: 'holder_not_ready' }), noStore);
            const rules = rec.settings.rules;
            if (rules.requireFirstBuy && !(Number(body.firstBuySol) >= rules.minFirstBuySol)) return send(res, 400, JSON.stringify({ error: 'first_buy_required', min: rules.minFirstBuySol }), noStore);
          }
        }
        // The originals rule: a new coin may not copy one already launched here. Checked and held before anything is built.
        const gate = action === 'prepare' && unique ? (async () => {
          const buf = typeof body.art === 'string' ? art.get(body.art) : null;
          if (!buf) return { status: 400, body: { error: 'picture_required' } };
          const c = { symbol: String(body.symbol || '').replace(/^\$/, '').trim(), name: String(body.name || '').trim(), hash: await imageHash(buf), creator: String(body.creator || '') };
          const v = unique.check(c);
          if (!v.ok) return { status: v.error === 'bad_symbol' ? 400 : 409, body: { error: v.error, by: v.by } };
          const key = 'hold:' + crypto.randomBytes(8).toString('hex');
          unique.reserve(key, c);
          return { key };
        })() : Promise.resolve(null);
        return gate.then(g => {
          if (g && g.status) return send(res, g.status, JSON.stringify(g.body), noStore);
          return launcher[action](body, { ip: clientIp(req), baseUrl: baseUrlFor(req), founder: founder, pad: padCtx, hasArt: id => Boolean(art.get(id)), isDenied: isDenied })
          .then(r => {
            if (g && g.key) { if (r.status === 200 && r.body && r.body.mint) unique.rename(g.key, r.body.mint); else unique.release(g.key); }
            // Once the next step is asked for and the coin is on-chain, the coin counts as launched for good.
            if (action === 'step' && unique && r.status === 200 && r.body && r.body.step !== 'waiting' && typeof body.mint === 'string') unique.confirm(body.mint);
            if (action === 'prepare' && r.status === 200 && launches) {
              launches.record({ pool: r.body.pool, mint: r.body.mint, name: cleanText(body.name, 32), symbol: String(body.symbol || '').replace(/^\$/, '').trim().toUpperCase(), creator: body.creator, art: body.art, pad: padSlug, preset: '', devBuySol: r.body.firstBuySol });
            }
            if (action === 'prepare' && r.status === 200 && typeof body.art === 'string') {
              // Links are saved, then the picture is kept for good and its links are frozen.
              if (Object.keys(links).length) art.setLinks(body.art, links, Boolean(founder && body.art === founder.id));
              art.pin(body.art);
            }
            send(res, r.status, JSON.stringify(r.body), noStore);
          }, () => { if (g && g.key) unique.release(g.key); send(res, 500, JSON.stringify({ error: 'server_error' }), noStore); });
        });
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', Object.assign({ Allow: 'GET, HEAD' }, TEXT_TYPE));
    }

    // Launchpads: the list, one pad, and the numbers the builder needs (what the platform keeps, the most an owner can take).
    if (pathname === '/api/builder/config') {
      const info = launcher ? launcher.info() : { enabled: false, cluster: 'devnet', platformPct: 10 };
      const body = { enabled: Boolean(padStore && info.enabled), cluster: info.cluster, platformPct: padStore ? padStore.platformPct : info.platformPct, maxOwnerPct: padStore ? padStore.maxOwnerPct : 0, aiAvailable: Boolean(art.info().enabled), maxListSize: 100, holderRewards: process.env.HOLDER_REWARDS === 'yes', holderLaunchFeeSol: info.holderLaunchFeeSol };
      return send(res, 200, JSON.stringify(body), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }
    if (pathname === '/api/pads') {
      return send(res, 200, JSON.stringify({ pads: padStore ? padStore.list(12) : [] }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=15' }));
    }
    if (pathname === '/api/leaderboard') {
      const hdr = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=15' });
      const out = async () => {
        const b = launches ? launches.board(50) : { rows: [], totalCoins: 0, totalRaisedSol: 0 };
        // What one unit of each pool token is worth in dollars, so coins on different pairs can be shown and ranked on one scale.
        const coinsAll = launches ? launches.topCoins(200) : [];
        const mints = new Set(['']);
        b.rows.forEach(r => mints.add(padPairMint(r.slug)));
        coinsAll.forEach(c => mints.add(padPairMint(c.pad)));
        const usd = {};
        await Promise.all(Array.from(mints).map(async m => { usd[m] = await unitUsd(m); }));
        const dollars = (amount, mint) => (Number.isFinite(usd[mint]) && Number.isFinite(amount) ? Math.round(amount * usd[mint] * 100) / 100 : null);
        const kinds = {};
        await Promise.all(Array.from(mints).map(async m => { kinds[m] = await pairKindOf(m); }));
        const rows = b.rows.map(r => { const p = padStore ? padStore.get(r.slug) : null; const pm = padPairMint(r.slug); return p ? Object.assign({ pairKind: kinds[pm] || '', name: p.name, accent: p.accent, logoUrl: p.logoUrl, tagline: p.tagline, pairSymbol: (padStore.settings(r.slug).pair || {}).symbol || '', ownerPct: p.ownerPct || 0, holderRewards: padStore.settings(r.slug).holderRewards === true, holderFeeSol: launcher.info().holderLaunchFeeSol, launcherPct: 100 - padStore.platformPct - (p.ownerPct || 0), platformPct: padStore.platformPct, raisedUsd: dollars(r.raisedSol, pm) }, r) : null; }).filter(Boolean);
        // Pads rank by coins launched, then graduated coins, then dollars raised (a pad with no known price ranks last on that step).
        rows.sort((x, y) => (y.coins - x.coins) || (y.graduated - x.graduated) || ((y.raisedUsd || 0) - (x.raisedUsd || 0)));
        const pairedRaised = rows.filter(r => r.pairSymbol).reduce((n, r) => n + (r.raisedSol || 0), 0);
        rows.length = Math.min(rows.length, 10);
        // The official coin (and any older attempt at it) stays off the list: it has its own card above.
        const old = new Set(founder && launches ? launches.findAllByArt(founder.id).concat(launches.findAllBySymbol(founder.ticker)).map(e => e.pool) : []);
        const coins = coinsAll.filter(c => !old.has(c.pool)).map(c => Object.assign({}, c, { raisedUsd: dollars(c.raisedSol, padPairMint(c.pad)) }))
          .sort((x, y) => (Number(y.migrated) - Number(x.migrated)) || ((y.progress || 0) - (x.progress || 0)) || ((y.raisedUsd !== null ? y.raisedUsd : (y.raisedSol || 0)) - (x.raisedUsd !== null ? x.raisedUsd : (x.raisedSol || 0)))).slice(0, 20).map(c => {
          const p = c.pad && padStore ? padStore.get(c.pad) : null;
          return Object.assign({}, c, { pairKind: kinds[padPairMint(c.pad)] || '', holderRewards: p ? padStore.settings(c.pad).holderRewards === true : false, holderFeeSol: launcher.info().holderLaunchFeeSol, ownerPct: p ? (p.ownerPct || 0) : 0, launcherPct: p ? 100 - padStore.platformPct - (p.ownerPct || 0) : null, platformPct: padStore.platformPct, padName: p ? p.name : '', padAccent: p ? p.accent : '', pairSymbol: p ? ((padStore.settings(c.pad) || {}).pair || {}).symbol || '' : '' });
        });
        return JSON.stringify({ pads: rows, coins: coins, stats: { pads: padStore ? padStore.size() : 0, coins: b.totalCoins, raisedSol: Math.max(0, b.totalRaisedSol - pairedRaised) } });
      };
      // Looking at the recent launches first keeps the raised amounts fresh (this is cached, so it is cheap).
      (launches ? launches.list('').catch(() => []) : Promise.resolve([])).then(() => out()).then(body => send(res, 200, req.method === 'HEAD' ? '' : body, hdr))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' })));
      return;
    }
    // The mascot's report on a pad's coins, built from the launch list the server already keeps. Cached like a coin's report.
    const prm = /^\/api\/pads\/([a-z0-9-]{2,30})\/report$/.exec(pathname);
    if (req.method === 'GET' && prm) {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      const slug = prm[1];
      const set = padStore ? padStore.settings(slug) : null;
      const pad = set ? padStore.get(slug) : null;
      if (!set || !pad || !launches) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      if (!set.ai.chat) return send(res, 403, JSON.stringify({ error: 'ai_off' }), noStore);
      (async () => {
        const hit = reportCache.get('pad:' + slug);
        if (hit && Date.now() - hit.at < 300000) return send(res, 200, JSON.stringify(hit.value), noStore);
        const items = await launches.list(slug);
        if (!items.length) return send(res, 200, JSON.stringify({ report: '', mascot: set.ai.mascotName || '', facts: null }), noStore);
        const by = items.slice().sort((a, b) => (b.raisedSol || 0) - (a.raisedSol || 0));
        const newest = items.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
        const facts = {
          coinsLaunched: items.length,
          totalRaisedSol: Number(items.reduce((n, i) => n + (i.raisedSol || 0), 0).toFixed(3)),
          graduated: items.filter(i => i.migrated).length,
          launchedLast24h: items.filter(i => Date.now() - i.createdAt < 86400000).length,
          biggestCoin: by[0].name + ' ($' + by[0].symbol + ') with ' + Number((by[0].raisedSol || 0).toFixed(3)) + ' SOL',
          newestCoin: newest.name + ' ($' + newest.symbol + ')'
        };
        const value = { report: '', mascot: set.ai.mascotName || '', facts: facts, at: Date.now() };
        if (art.info().enabled && padAiTake(slug, 'chat')) {
          const r = await art.report(facts, { kind: 'pad', name: pad.name, mascot: { name: value.mascot, persona: set.ai.mascotPersona } }).catch(() => null);
          if (r && r.status === 200) value.report = r.body.report;
        }
        reportCache.set('pad:' + slug, { at: Date.now(), value });
        if (reportCache.size > 500) reportCache.delete(reportCache.keys().next().value);
        return send(res, 200, JSON.stringify(value), noStore);
      })().catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    const pm = /^\/api\/pads\/([a-z0-9-]{2,30})$/.exec(pathname);
    if (pm) {
      const rec = padStore ? padStore.get(pm[1]) : null;
      if (!rec) return send(res, 404, JSON.stringify({ error: 'not_found' }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
      return send(res, 200, JSON.stringify({ pad: rec }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }
    const lm = /^\/pad-logo\/([a-z0-9-]{2,30})\.(png|jpg)$/.exec(pathname);
    if (lm) {
      const l = padStore ? padStore.logo(lm[1]) : null;
      if (!l || l.ext !== lm[2]) return send(res, 404, 'Not found', TEXT_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : l.buf, { 'Content-Type': l.ext === 'jpg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=3600' });
    }

    const bm = /^\/pad-banner\/([a-z0-9-]{2,30})\.(png|jpg)$/.exec(pathname);
    if (bm) {
      const l = padStore ? padStore.banner(bm[1]) : null;
      if (!l || l.ext !== bm[2]) return send(res, 404, 'Not found', TEXT_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : l.buf, { 'Content-Type': l.ext === 'jpg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=300' });
    }

    // Whether launching is switched on, so the page knows whether to offer it.
    if (pathname === '/api/launch/config') {
      const info = launcher ? launcher.info() : { enabled: false, cluster: 'devnet' };
      return send(res, 200, JSON.stringify(info), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }

    // Read-only chain lookups for the page: did a transaction land, and where does a curve stand.
    if (pathname === '/api/launch/status' || pathname === '/api/launch/pool' || pathname === '/api/launch/fees') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      const ctx = { ip: clientIp(req) };
      const run = pathname === '/api/launch/status' ? launcher.status(url.searchParams.get('sig'), ctx)
        : pathname === '/api/launch/fees' ? launcher.fees(url.searchParams.get('address'), ctx)
        : launcher.pool(url.searchParams.get('address'), ctx);
      run.then(async r => {
        // A coin paired with a token: add that token's symbol (from the coin's pad) so the page can name the unit.
        if (r.status === 200 && r.body && r.body.paired && launches && padStore) {
          try {
            const d = await launches.detail(r.body.mint);
            if (d.status === 200 && d.body.pairSymbol === undefined && d.body.pad) { const set = padStore.settings(d.body.pad); if (set && set.pair && set.pair.symbol) r.body.pairSymbol = set.pair.symbol; }
            else if (d.status === 200 && d.body.pairSymbol) r.body.pairSymbol = d.body.pairSymbol;
          } catch (e) { /* the page falls back to "pair token" */ }
        }
        if (r.status === 200 && r.body && typeof r.body.pairMint === 'string') r.body.usdPerUnit = await unitUsd(r.body.pairMint);
        return r;
      }).then(r => send(res, r.status, req.method === 'HEAD' ? '' : JSON.stringify(r.body), noStore))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // The public list of launches that exist on-chain, newest first.
    if (pathname === '/api/launches') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=15' });
      if (!launches) return send(res, 200, JSON.stringify({ launches: [] }), noStore);
      const padQ = url.searchParams.get('pad') || '';
      launches.list(padQ).then(async items => ({ items, usd: padQ ? await unitUsd(padPairMint(padQ)) : undefined })).then(r => send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ launches: r.items, usdPerUnit: r.usd }), noStore))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' })));
      return;
    }

    // One launch, for its own page.
    const dm = /^\/api\/launches\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pathname);
    if (dm) {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      if (!launches) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      launches.detail(dm[1]).then(async r => {
        if (r.status === 200) r.body.usdPerUnit = await unitUsd(padPairMint(r.body.pad));
        return r;
      }).then(r => {
        // A website the creator has not yet proven gets the code to put on it.
        // Whether the coin's pad has the mascot chat on, and the mascot's name, so the page can show the right thing.
        if (r.status === 200 && padStore && r.body.pad) {
          const set = padStore.settings(r.body.pad);
          if (set) { r.body.chat = set.ai.chat; r.body.mascotName = set.ai.mascotName; r.body.holderRewards = set.holderRewards === true; if (set.pair && set.pair.symbol) r.body.pairSymbol = set.pair.symbol; }
        }
        if (r.status === 200 && r.body.links && r.body.links.website && !r.body.siteVerified && verifier.places(r.body.links.website).length) {
          r.body.verifyCode = verifier.code(r.body.pool, r.body.creator);
        }
        send(res, r.status, req.method === 'HEAD' ? '' : JSON.stringify(r.body), noStore);
      })
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // The pages: the home page, the builder, and each built launchpad at /p/<name>.
    let isHome = false;
    if (pathname === '/' && homePad && padStore && padStore.toPad(homePad)) { servePad = padStore.toPad(homePad); pathname = '/pad.html'; isHome = true; }
    else if (pathname === '/') pathname = '/home.html';
    else if (pathname === '/build') pathname = '/build.html';
    else if (pathname === '/rules') pathname = '/rules.html';
    const pp = /^\/p\/([a-z0-9-]{2,30})\/?$/.exec(pathname);
    if (pp) {
      const built = padStore ? padStore.toPad(pp[1]) : null;
      if (!built) return send(res, 404, 'No launchpad here. Build one at /build.', TEXT_TYPE);
      servePad = built;
      pathname = '/pad.html';
    } else if (pathname === '/pad.html' && !isHome) {
      return send(res, 404, 'Not found', TEXT_TYPE); // only reachable as /p/<name>
    }

    // A coin's own page. The page itself is the same for every coin; it reads the address from the link.
    if (/^\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pathname)) pathname = '/coin.html';

    // Whether the animal studio is switched on, so the page knows whether to offer it.
    if (pathname === '/api/founder' && (req.method === 'GET' || req.method === 'HEAD')) {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      if (!founder) return send(res, 404, JSON.stringify({ error: 'not_found' }), noStore);
      if (founder.buf && !art.record(founder.id)) art.seed(founder.buf, founder); // unlaunched pictures are pruned after a day
      founderLaunched().then(launched => send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({
        id: founder.id, imageUrl: '/art/' + founder.id + '.' + (founder.ext || 'png'), name: founder.name, ticker: founder.ticker, description: founder.description,
        wallet: founder.wallet, launched: launched
      }), noStore)).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }
    if (pathname === '/api/art/config') {
      return send(res, 200, JSON.stringify(art.info()), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }

    // A generated animal picture, kept in memory by its id.
    const m = /^\/art\/([0-9a-f]{16})\.(png|jpg)$/.exec(pathname);
    if (m) {
      const rec = art.record(m[1]);
      if (!rec || rec.ext !== m[2]) return send(res, 404, 'Not found', TEXT_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : rec.png, { 'Content-Type': m[2] === 'jpg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    // Token metadata read by wallets and explorers. Built from the link and the stored animal.
    if (pathname === '/meta.json') {
      const id = url.searchParams.get('i');
      const rec = id && ID_RE.test(id) ? art.record(id) : null;
      const meta = metadataFor(url.searchParams.get('n'), url.searchParams.get('s'), rec, baseUrlFor(req), launcher && launcher.info ? launcher.info().cluster : 'devnet');
      if (!meta) return send(res, 400, JSON.stringify({ error: 'bad_metadata' }), JSON_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify(meta), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=3600' }));
    }

    // The pairing tokens a pad can choose as its pool pair, straight from pump.fun's on-chain list.
    if (pathname === '/api/pairs') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=300' });
      if (!launcher || !launcher.pairs) return send(res, 200, JSON.stringify({ pairs: [], launchReady: false }), noStore);
      launcher.pairs().then(r => send(res, r.status === 200 ? 200 : 200, req.method === 'HEAD' ? '' : JSON.stringify(r.status === 200 ? r.body : { pairs: [], launchReady: false }), noStore))
        .catch(() => send(res, 200, JSON.stringify({ pairs: [], launchReady: false }), noStore));
      return;
    }

    // The SOL and BTC prices for the header ticker. One lookup a minute is shared by every visitor, so the page never talks to the price site.
    if (pathname === '/api/price') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=30' });
      getPrices().then(p => send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ usd: p ? p.sol : null, btcUsd: p ? p.btc : null, at: p ? p.at : null }), noStore))
        .catch(() => send(res, 200, JSON.stringify({ usd: null, btcUsd: null, at: null }), noStore));
      return;
    }

    // Health check for the host platform.
    if (pathname === '/healthz') {
      const body = { ok: true, art: art.info().enabled };
      if (art.reason) body.artReason = art.reason;
      return send(res, 200, JSON.stringify(body), JSON_TYPE);
    }

    if (pathname.endsWith('/')) pathname += 'home.html';
    const file = path.join(PUBLIC_DIR, pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      return send(res, 403, 'Forbidden', TEXT_TYPE);
    }

    // A pad may replace a stock file (icon.svg, mascot.svg, banner.png...) by putting one of the same name in
    // pads/<id>/assets/. Only plain file names in that folder are looked up.
    let source = file;
    const plain = pathname.slice(1);
    if (pad.assetsDir && /^[A-Za-z0-9._-]+$/.test(plain)) {
      const mine = path.join(pad.assetsDir, plain);
      try { if (fs.statSync(mine).isFile()) source = mine; } catch (e) { /* no override, use the stock file */ }
    }
    fs.readFile(source, (err, data) => {
      if (err) {
        return send(res, 404, 'Not found', TEXT_TYPE);
      }
      const ext = path.extname(file).toLowerCase();
      const type = TYPES[ext] || 'application/octet-stream';
      if (ext === '.html') data = Buffer.from(pads.applyToHtml(data.toString('utf8'), servePad, { origin: baseUrlFor(req), platform: pad.name }), 'utf8');
      send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    });
  });
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const env = name => String(process.env[name] || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  // Railway volumes mount at a path you choose; /data is the usual one.
  // DATA_DIR (the volume's mount path) is the simplest setting; ART_DIR overrides just the pictures.
  const dataDir = env('DATA_DIR') || (fs.existsSync('/data') ? '/data' : '');
  const artDir = env('ART_DIR') || (dataDir ? path.join(dataDir, 'art') : '');
  // IMAGE_PROVIDER=cloudflare uses Workers AI (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN).
  // Anything else uses OpenAI (needs OPENAI_API_KEY). IMAGE_MODEL and TEXT_MODEL override the defaults.
  // Settings pasted into a host's form often carry stray spaces, line breaks or quotes; strip them.
  const cloudflare = env('IMAGE_PROVIDER').toLowerCase() === 'cloudflare';
  const pad = pads.load(env('PAD') || 'novamppad');
  const art = createArt({
    subject: pad.subject, persona: pad.persona, imageStyle: pad.imageStyle,
    dir: artDir,
    provider: cloudflare ? 'cloudflare' : 'openai',
    apiKey: cloudflare ? env('CLOUDFLARE_API_TOKEN') : env('OPENAI_API_KEY'),
    accountId: env('CLOUDFLARE_ACCOUNT_ID'),
    imageModel: env('IMAGE_MODEL') || env('OPENAI_IMAGE_MODEL') || undefined,
    textModel: env('TEXT_MODEL') || env('OPENAI_TEXT_MODEL') || undefined,
    perIpPerHour: Number(process.env.ART_PER_IP_PER_HOUR) || undefined,
    dailyCap: Number(process.env.ART_DAILY_CAP) || undefined
  });
  const cluster = env('LAUNCH_CLUSTER') || 'devnet';
  const launcher = createLauncher({
    cluster,
    allowMainnet: env('MAINNET_ENABLED') === 'yes',
    platformWallet: env('PLATFORM_FEE_WALLET') || pad.fees.wallet,
    platformSharePct: env('PLATFORM_SHARE_PCT') || pad.fees.platformSharePct || undefined,
    lookupTable: env('LAUNCH_LOOKUP_TABLE') || undefined,
    priorityMicroLamports: env('PRIORITY_FEE_MICROLAMPORTS') === '' ? undefined : Number(env('PRIORITY_FEE_MICROLAMPORTS')),
    rpcUrl: process.env.LAUNCH_RPC_URL || undefined,
    pairsRpcUrl: process.env.PAIRS_RPC_URL || undefined,
    pairTrade: process.env.PAIRS_TRADE === 'yes',
    holderLaunchFeeSol: process.env.HOLDER_LAUNCH_FEE_SOL ? Number(process.env.HOLDER_LAUNCH_FEE_SOL) : undefined,
    showStocks: process.env.PAIRS_STOCKS === 'yes'
  });
  const launchesFile = env('LAUNCHES_FILE') || (dataDir ? path.join(dataDir, cluster === 'devnet' ? 'launches.json' : 'launches.' + cluster + '.json') : '');
  const unique = createUnique({ file: dataDir ? path.join(dataDir, cluster === 'devnet' ? 'originals.json' : 'originals.' + cluster + '.json') : '' });
  const padStore = createPadStore({
    file: dataDir ? path.join(dataDir, cluster === 'devnet' ? 'padstore.json' : 'padstore.' + cluster + '.json') : '',
    logoDir: dataDir ? path.join(dataDir, 'pad-logos') : '',
    platformPct: launcher.info().platformPct
  });
  // The site's one launchpad, made once from the server's own settings (no signed form, no builder).
  const HOME_SLUG = 'novamppad';
  try {
    const owner = env('FOUNDER_WALLET') || env('PLATFORM_FEE_WALLET') || '11111111111111111111111111111111';
    padStore.seed({ slug: HOME_SLUG, name: pad.name, tagline: pad.tagline, accent: '#ff6b57', ownerWallet: owner }, fs.readFileSync(path.join(pad.assetsDir, 'logo.png')));
  } catch (err) { console.error('Could not make the home launchpad: ' + (err && err.message)); }
  setInterval(() => unique.prune(), 3600000).unref();
  const launches = createLaunches({
    file: launchesFile,
    inspect: address => launcher.inspect(address),
    artRecord: id => art.record(id),
    hidden: env('HIDE_POOLS').split(',').map(x => x.trim()).filter(Boolean)
  });
  // The website-check code is derived from a secret. A volume keeps it the same across restarts.
  let verifySecret = env('VERIFY_SECRET');
  if (!verifySecret && dataDir) {
    const f = path.join(dataDir, 'verify-secret');
    try { verifySecret = fs.readFileSync(f, 'utf8').trim(); } catch (err) { /* first run */ }
    if (!verifySecret) {
      verifySecret = require('crypto').randomBytes(32).toString('hex');
      try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, verifySecret, { mode: 0o600 }); } catch (err) { console.error('Could not save the verify secret: ' + (err && err.message)); }
    }
  }
  // The founder coin: a ready-made picture (founder/logo.png) that only FOUNDER_WALLET can launch.
  let founder = null;
  // The admin wallet that may launch the official coin: FOUNDER_WALLET, or the platform fee wallet if that is not set.
  const founderWallet = env('FOUNDER_WALLET') || env('PLATFORM_FEE_WALLET');
  const padLogo = path.join(pad.assetsDir, 'founder-logo.png'); // a pad can bring its own founder picture
  // The stock founder/logo.png is HatchPad's own logo, so only the hatchpad pad may use it.
  const founderFile = fs.existsSync(padLogo) ? padLogo : (pad.id === 'hatchpad' ? path.join(__dirname, 'founder', 'logo.png') : '');
  if (founderWallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(founderWallet) && founderFile && fs.existsSync(founderFile)) {
    const text = { name: env('FOUNDER_NAME') || pad.founderName, ticker: (env('FOUNDER_SYMBOL') || pad.founderSymbol).toUpperCase(), description: env('FOUNDER_DESCRIPTION') || pad.founderDescription };
    const buf = fs.readFileSync(founderFile);
    const id = art.seed(buf, text);
    if (id) founder = Object.assign({ id, ext: 'png', wallet: founderWallet, buf: buf }, text);
  }
  const server = createApp({ art, launcher, launches, founder, pad, padStore, unique, homePad: HOME_SLUG, padAiDailyCap: Number(env("PAD_AI_DAILY_CAP")) || undefined, padChatDailyCap: Number(env("PAD_CHAT_DAILY_CAP")) || undefined, verifier: createVerifier({ secret: verifySecret || undefined }) });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(pad.name + ' listening on port ' + PORT + (art.info().enabled ? ' (picture studio on, ' + art.provider + ')' : ' (picture studio OFF: ' + art.reason + '; provider ' + art.provider + ')') + (artDir ? ' (pictures saved in ' + artDir + ')' : ' (pictures in memory only: no volume)') +
      (launcher.info().enabled ? ' (' + cluster + ' launch on)' : ' (' + cluster + ' launch off: set PLATFORM_FEE_WALLET)') + (launchesFile ? ' (launch list saved in ' + launchesFile + ')' : ' (launch list in memory only)'));
  });
  // Railway stops containers with SIGTERM; close cleanly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
