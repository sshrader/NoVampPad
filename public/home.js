/* Home page: the list of pads built here, and the fee split example from the server's real numbers. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  function card(p) {
    const a = document.createElement('a');
    a.className = 'padcard'; a.href = '/p/' + encodeURIComponent(p.slug);
    a.style.setProperty('--pc', /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : '#ff8f3d');
    const logo = document.createElement('div'); logo.className = 'mock-logo';
    const img = document.createElement('img'); img.alt = ''; img.src = p.logoUrl; img.width = 40; img.height = 40;
    img.addEventListener('error', () => { logo.textContent = (p.name || '?').charAt(0).toUpperCase(); img.remove(); });
    logo.appendChild(img);
    const b = document.createElement('b'); b.textContent = p.name;
    const s = document.createElement('span'); s.textContent = p.tagline || 'A launchpad on Solana';
    a.appendChild(logo); a.appendChild(b); a.appendChild(s);
    return a;
  }

  // ----- Hero: the sample pad changes look every few seconds, then stops if the visitor prefers less motion.
  const SAMPLES = [
    { n: 'Northwind', t: 'Fresh coins, fair fees.', c: '#5b8cff', f: '#ffffff', o: 20, u: 'northwind' },
    { n: 'Ember', t: 'Hot launches only.', c: '#ff8f3d', f: '#140a02', o: 15, u: 'ember' },
    { n: 'Verdant', t: 'Grow something new.', c: '#22c55e', f: '#04140a', o: 25, u: 'verdant' },
    { n: 'Orchid', t: 'Soft launch, loud results.', c: '#ec4899', f: '#ffffff', o: 10, u: 'orchid' }
  ];
  let si = 0;
  function showSample(s) {
    const m = $('mock'); if (!m) return;
    m.style.setProperty('--accent', s.c); m.style.setProperty('--on-accent', s.f);
    $('glow').style.setProperty('--glow', s.c);
    $('mock-name').textContent = s.n; $('mock-tag').textContent = s.t; $('mock-logo').textContent = s.n.charAt(0); $('mock-url').textContent = '/p/' + s.u;
    const platform = window.__platformPct || 10, launcher = 100 - platform - s.o;
    $('mk-l').style.width = launcher + '%'; $('mk-o').style.width = s.o + '%'; $('mk-lt').textContent = launcher + '%'; $('mk-ot').textContent = s.o + '%';
  }
  showSample(SAMPLES[0]);
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* default */ }
  if (!reduce) setInterval(() => { si = (si + 1) % SAMPLES.length; showSample(SAMPLES[si]); }, 3600);

  // ----- Leaderboard and live totals
  const fmt = n => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  function count(el, to) {
    if (!el) return;
    if (reduce || !to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    (function step(t) { const k = Math.min(1, (t - t0) / dur); el.textContent = fmt(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
  }
  function row(p, i) {
    const li = document.createElement('li'); li.className = 'brow'; if (i === 0) li.classList.add('first');
    li.style.setProperty('--pc', /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : '#ff8f3d');
    const rank = document.createElement('span'); rank.className = 'brank'; rank.textContent = String(i + 1);
    const a = document.createElement('a'); a.className = 'bpad'; a.href = '/p/' + encodeURIComponent(p.slug);
    const logo = document.createElement('div'); logo.className = 'mock-logo';
    const img = document.createElement('img'); img.alt = ''; img.src = p.logoUrl; img.width = 40; img.height = 40;
    img.addEventListener('error', () => { logo.textContent = (p.name || '?').charAt(0).toUpperCase(); img.remove(); });
    logo.appendChild(img);
    const nm = document.createElement('span'); nm.className = 'bname';
    const b = document.createElement('b'); b.textContent = p.name;
    const sm = document.createElement('small'); sm.textContent = '/p/' + p.slug;
    nm.appendChild(b); nm.appendChild(sm);
    { const pc = document.createElement('span'); pc.className = 'pairchip'; pc.textContent = p.pairSymbol ? p.pairSymbol + ' pair' + (p.pairKind === 'stock' ? ' · Stock' : p.pairKind === 'other' ? ' · Crypto / Memes' : '') : 'SOL pair'; nm.appendChild(pc); }
    if (p.holderRewards) { const fc = document.createElement('span'); fc.className = 'pairchip feechip'; fc.textContent = 'Holders get 100% · ' + (p.holderFeeSol || 0.05) + ' SOL launch fee'; fc.title = 'All creator fees go to the coin holders. Launching costs a flat fee paid to ' + window.PAD.platform; nm.appendChild(fc); }
    else if (p.launcherPct !== null && p.launcherPct !== undefined) { const fc = document.createElement('span'); fc.className = 'pairchip feechip'; fc.textContent = 'Launcher ' + p.launcherPct + '% · Owner ' + p.ownerPct + '% · ' + window.PAD.platform + ' ' + p.platformPct + '%'; fc.title = p.launcherPct + '% coin launcher · ' + p.ownerPct + '% pad owner · ' + p.platformPct + '% ' + window.PAD.platform + ' (of creator fees, set on-chain at launch)'; nm.appendChild(fc); }
    a.appendChild(logo); a.appendChild(nm);
    const nums = document.createElement('span'); nums.className = 'bnums';
    [[p.coins, p.coins === 1 ? 'coin' : 'coins'], (p.pairSymbol && Number.isFinite(p.raisedUsd) ? [AnimalNet.usd(p.raisedUsd), 'raised'] : [fmt(p.raisedSol), (p.pairSymbol || 'SOL') + ' raised']), [p.graduated, 'graduated']].forEach(x => {
      const d = document.createElement('span'); const v = document.createElement('b'); v.textContent = String(x[0]); d.appendChild(v); d.appendChild(document.createTextNode(' ' + x[1])); nums.appendChild(d);
    });
    const top = document.createElement('span'); top.className = 'btop';
    (p.top || []).forEach(c => {
      const t = document.createElement('a'); t.className = 'tchip'; t.href = '/coin/' + encodeURIComponent(c.pool); t.title = c.name;
      if (c.imageUrl) { const im = document.createElement('img'); im.alt = ''; im.src = c.imageUrl; im.width = 18; im.height = 18; t.appendChild(im); }
      t.appendChild(document.createTextNode(c.symbol)); top.appendChild(t);
    });
    li.appendChild(rank); li.appendChild(a); li.appendChild(nums); li.appendChild(top);
    return li;
  }
  // The official coin sits at the top of the leaderboard, with its own numbers, once the admin has launched it.
  fetch('/api/founder', { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(f => {
      const l = f && f.launched;
      if (!l) return;
      $('of-img').src = f.imageUrl; $('of-name').textContent = l.name; $('of-sym').textContent = '$' + l.symbol;
      $('of-ca').textContent = l.mint; $('of-open').setAttribute('href', '/coin/' + encodeURIComponent(l.pool));
      const pct = Number.isFinite(l.progress) ? Math.max(0, Math.min(100, Math.round(l.progress * 100))) : 0;
      $('of-bar').style.width = (l.migrated ? 100 : pct) + '%';
      $('of-pct').textContent = l.migrated ? 'Graduated' : pct + '% full';
      $('of-raised').textContent = Number.isFinite(l.raisedSol) ? fmt(l.raisedSol) + (Number.isFinite(l.thresholdSol) ? ' / ' + fmt(l.thresholdSol) : '') + ' SOL' : '–';
      $('of-status').textContent = l.migrated ? 'Graduated' : l.curveFull ? 'Curve full' : 'On the curve';
      $('of-fees').textContent = Number.isFinite(l.feesWaitingSol) ? Number(l.feesWaitingSol.toFixed(4)) + ' SOL' : '–';
      $('official').hidden = false;
    })
    .catch(() => { /* no official coin to show */ });

  // ----- Pads / Top coins tabs. Each coin names the pad it was launched on.
  let tab = 'pads', board = null;
  function coinRow(c, i) {
    const li = document.createElement('li'); li.className = 'brow crow';
    const rank = document.createElement('span'); rank.className = 'brank'; rank.textContent = String(i + 1);
    const a = document.createElement('a'); a.className = 'bpad'; a.href = '/coin/' + encodeURIComponent(c.pool);
    const logo = document.createElement('div'); logo.className = 'mock-logo';
    if (c.imageUrl) {
      const img = document.createElement('img'); img.alt = ''; img.src = c.imageUrl; img.width = 40; img.height = 40;
      img.addEventListener('error', () => { logo.textContent = (c.name || '?').charAt(0).toUpperCase(); img.remove(); });
      logo.appendChild(img);
    } else logo.textContent = (c.name || '?').charAt(0).toUpperCase();
    const nm = document.createElement('span'); nm.className = 'bname';
    const b = document.createElement('b'); b.textContent = c.name;
    const sm = document.createElement('small'); sm.textContent = '$' + c.symbol;
    nm.appendChild(b); nm.appendChild(sm);
    { const pc = document.createElement('span'); pc.className = 'pairchip'; pc.textContent = c.pairSymbol ? c.pairSymbol + ' pair' + (c.pairKind === 'stock' ? ' · Stock' : c.pairKind === 'other' ? ' · Crypto / Memes' : '') : 'SOL pair'; nm.appendChild(pc); }
    if (c.holderRewards) { const fc = document.createElement('span'); fc.className = 'pairchip feechip'; fc.textContent = 'Holders get 100% · ' + (c.holderFeeSol || 0.05) + ' SOL launch fee'; fc.title = 'All creator fees go to the coin holders. Launching costs a flat fee paid to ' + window.PAD.platform; nm.appendChild(fc); }
    else if (c.launcherPct !== null && c.launcherPct !== undefined) { const fc = document.createElement('span'); fc.className = 'pairchip feechip'; fc.textContent = 'Launcher ' + c.launcherPct + '% · Owner ' + c.ownerPct + '% · ' + window.PAD.platform + ' ' + c.platformPct + '%'; fc.title = c.launcherPct + '% coin launcher · ' + c.ownerPct + '% pad owner · ' + c.platformPct + '% ' + window.PAD.platform + ' (of creator fees, set on-chain at launch)'; nm.appendChild(fc); }
    a.appendChild(logo); a.appendChild(nm);
    const nums = document.createElement('span'); nums.className = 'bnums';
    const pct = Math.max(0, Math.min(100, Math.round((c.progress || 0) * 100)));
    [(c.pairSymbol && Number.isFinite(c.raisedUsd) ? [AnimalNet.usd(c.raisedUsd), 'raised'] : [fmt(c.raisedSol), (c.pairSymbol || 'SOL') + ' raised']), [c.migrated ? 'Graduated' : pct + '%', c.migrated ? '' : 'full']].forEach(x => {
      const d = document.createElement('span'); const v = document.createElement('b'); v.textContent = String(x[0]); d.appendChild(v); if (x[1]) d.appendChild(document.createTextNode(' ' + x[1])); nums.appendChild(d);
    });
    // The pad this coin was launched on (or the platform itself, for coins launched directly).
    const on = document.createElement('a'); on.className = 'onpad';
    on.style.setProperty('--pc', /^#[0-9a-f]{6}$/i.test(c.padAccent) ? c.padAccent : '#ff8f3d');
    on.href = c.pad ? '/p/' + encodeURIComponent(c.pad) : '/';
    on.appendChild(document.createTextNode('on '));
    const pn = document.createElement('b'); pn.textContent = c.padName || (window.PAD && window.PAD.platform) || 'BuildAPad'; on.appendChild(pn);
    li.appendChild(rank); li.appendChild(a); li.appendChild(nums); li.appendChild(on);
    return li;
  }
  function showTab(v) {
    tab = v;
    $('boardlist').hidden = v !== 'pads'; $('coinlist').hidden = v !== 'coins';
    document.querySelectorAll('#board-tabs button').forEach(b => { const on = b.dataset.v === v; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-selected', String(on)); });
    $('board-sub').textContent = v === 'pads' ? 'Pads ranked by coins launched on them, then by graduated coins.' : 'Coins ranked by how full their curves are, with the pad each one launched on.';
    const n = board ? (v === 'pads' ? (board.pads || []).length : (board.coins || []).length) : 0;
    $('board-note').textContent = !board ? 'Loading…' : n ? '' : v === 'pads' ? 'No coins launched yet. The first pad to launch a coin takes the top spot.' : 'No coins launched yet. The first coin on the board takes the top spot.';
  }
  $('board-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.v); });

  fetch('/api/leaderboard', { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j) throw new Error('no board');
      const box = $('boardlist'); box.textContent = '';
      (j.pads || []).forEach((p, i) => box.appendChild(row(p, i)));
      const cbox = $('coinlist'); cbox.textContent = '';
      (j.coins || []).forEach((c, i) => cbox.appendChild(coinRow(c, i)));
      board = j; showTab(tab);
      count($('st-pads'), j.stats.pads); count($('st-coins'), j.stats.coins); count($('st-sol'), j.stats.raisedSol);
    })
    .catch(() => { $('board-note').textContent = 'Could not load the leaderboard. Try again in a moment.'; });

  fetch('/api/pads', { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      const list = (j && j.pads) || [];
      const box = $('padcards');
      list.forEach(p => box.appendChild(card(p)));
      $('pads-note').textContent = list.length ? '' : 'No pads yet. Yours could be the first.';
    })
    .catch(() => { $('pads-note').textContent = 'Could not load the pads. Try again in a moment.'; });

  fetch('/api/builder/config', { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(c => {
      if (!c || !Number.isFinite(c.platformPct)) return;
      window.__platformPct = c.platformPct; showSample(SAMPLES[si]);
      const owner = Math.min(20, c.maxOwnerPct || 0), launcher = 100 - c.platformPct - owner;
      $('fb-l').style.width = launcher + '%'; $('fb-o').style.width = owner + '%'; $('fb-p').style.width = c.platformPct + '%';
      $('fk-l').textContent = launcher + '%'; $('fk-o').textContent = owner + '%'; $('fk-p').textContent = c.platformPct + '%';
      const f2 = n => String(Number((n / 100).toFixed(3)));
      if ($('fl-max')) { $('fl-max').textContent = c.maxOwnerPct; $('fl-plat').textContent = c.platformPct; $('fe-o').textContent = owner; $('fe-l').textContent = f2(launcher); $('fe-ow').textContent = f2(owner); $('fe-p').textContent = f2(c.platformPct); }
      $('fees-note').textContent = 'Shown with an example ' + owner + '% owner share. You can choose anything from 0% up to ' + c.maxOwnerPct + '%.';
    })
    .catch(() => { /* the example stays as written */ });
})();
