/* The builder: collects the choices, keeps the preview in step, and has the owner's wallet sign the pad into being. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const W = window.AnimalWallet;
  const PRESETS = ['#ff8f3d', '#5b8cff', '#8b5cf6', '#22c55e', '#ec4899', '#06b6d4', '#ef4444', '#e5e7eb'];

  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const state = { banner: null, removeBanner: false, payout: '', name: '', slug: '', slugEdited: false, tagline: '', accent: PRESETS[1], corners: 'round', ownerPct: 15, logo: null };
  let cfg = { enabled: false, platformPct: 10, maxOwnerPct: 40, aiAvailable: false };
  let editing = null;      // the pad being edited (its public record), or null when building a new one
  const edit = new URLSearchParams(location.search).get('edit') || '';
  let wallet = null;
  let busy = false;

  const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  const onAccent = hex => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255 > 0.58 ? '#0a0b0e' : '#ffffff';
  };


  // Wallet lists: pasted text, split on spaces, commas and new lines.
  function parseWallets(text) {
    const parts = String(text || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const list = [], bad = [];
    parts.forEach(a => { if (!B58.test(a)) bad.push(a); else if (!list.includes(a)) list.push(a); });
    return { list: list, bad: bad };
  }
  // Pool pair picker, filled from pump.fun's list. SOL by default; two checkboxes reveal the stock list and the crypto/memes/others list.
  // Hidden when the list is not available on this server.
  let pairsAll = [], pairsLoaded = false, pendingPair = '', pairsLaunchReady = true;
  const KINDS = { sol: 'f-pair-sol', stock: 'f-pair-stock', other: 'f-pair-other' };
  // Only one box can be ticked at a time. Unticking the ticked one puts it back on SOL.
  function pickKind(k) { Object.keys(KINDS).forEach(x => { $(KINDS[x]).checked = x === k; }); if (k === 'sol') pendingPair = ''; paintPairs(); }
  // The pair picker is one box: type to filter, or open the list and choose. Arrow keys and Enter work too.
  let comboOpen = false, comboIndex = -1, comboShown = [];
  const labelOf = p => p.symbol + ' · ' + p.name;
  function closeCombo() { comboOpen = false; comboIndex = -1; $('f-pair-list').hidden = true; $('f-pair-q').setAttribute('aria-expanded', 'false'); $('f-pair-q').removeAttribute('aria-activedescendant'); }
  function choosePair(mint) { pendingPair = mint; closeCombo(); paintPairs(); }
  function paintList() {
    const list = $('f-pair-list'), box = $('f-pair-q');
    const on = { stock: isOn(KINDS.stock), other: isOn(KINDS.other) };
    const chosen = pairsAll.find(p => p.mint === pendingPair);
    // While the box still shows the chosen coin's own name, the whole list is shown, not just that one.
    const q = chosen && box.value === labelOf(chosen) ? '' : box.value.trim().toLowerCase();
    comboShown = pairsAll.filter(p => on[p.kind] && (!q || (p.symbol + ' ' + p.name).toLowerCase().indexOf(q) >= 0)).slice(0, 100);
    list.textContent = '';
    if (!comboShown.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No match'; list.appendChild(li); }
    comboShown.forEach((p, i) => {
      const li = document.createElement('li');
      li.id = 'f-pair-o' + i; li.setAttribute('role', 'option'); li.textContent = labelOf(p);
      li.setAttribute('aria-selected', p.mint === pendingPair ? 'true' : 'false');
      if (i === comboIndex) li.className = 'act';
      // mousedown, not click, so the box does not lose focus (and close the list) first.
      li.addEventListener('mousedown', e => { e.preventDefault(); choosePair(p.mint); });
      list.appendChild(li);
    });
    list.hidden = false; comboOpen = true; box.setAttribute('aria-expanded', 'true');
    if (comboIndex >= 0 && comboShown[comboIndex]) box.setAttribute('aria-activedescendant', 'f-pair-o' + comboIndex); else box.removeAttribute('aria-activedescendant');
  }
  function paintPairs() {
    const box = $('f-pair-q');
    const on = { stock: isOn(KINDS.stock), other: isOn(KINDS.other) };
    $('f-pair-pick').hidden = !(on.stock || on.other);
    if (!(on.stock || on.other)) closeCombo();
    // A pair that is not in the open category (or not on the list) is dropped.
    if (pendingPair && !pairsAll.some(p => p.mint === pendingPair && on[p.kind])) pendingPair = '';
    const chosen = pairsAll.find(p => p.mint === pendingPair);
    if (document.activeElement !== box || !comboOpen) box.value = chosen ? labelOf(chosen) : '';
    box.placeholder = on.stock ? 'Search stocks by name or ticker' : 'Search by name or ticker';
    $('f-pair-now').textContent = chosen ? 'Pair: ' + chosen.symbol + ' · ' + chosen.name : ''; $('f-pair-now').hidden = !chosen;
    $('f-pair-note').textContent = pairsLaunchReady ? 'Coins on this pad trade against this token, not SOL. Buyers need to hold it to buy, and creator fees are paid out in it.' : 'Preview only: this site runs on a test network, where this token does not exist, so coins cannot be launched on this pad here. Launching with a pair works on a mainnet site.';
    $('f-pair-note').hidden = !chosen;
    $('f-pair-chose').hidden = !(on.stock || on.other) || Boolean(chosen);
  }
  function syncPairBoxes() {
    // Opening an existing pad: tick the box that holds its pair.
    const hit = pairsAll.find(p => p.mint === pendingPair);
    pickKind(hit ? hit.kind : 'sol');
  }
  fetch('/api/pairs', { headers: { Accept: 'application/json' } }).then(r => r.json()).then(b => {
    pairsAll = (b && b.pairs) || []; pairsLaunchReady = !b || b.launchReady !== false;
    if (!pairsAll.length) return;
    pairsLoaded = true; $('g-pair-box').hidden = false; syncPairBoxes();
    const box = $('f-pair-q');
    box.addEventListener('focus', () => { box.select(); comboIndex = -1; paintList(); });
    box.addEventListener('click', () => { if (!comboOpen) { comboIndex = -1; paintList(); } });
    box.addEventListener('input', () => { if (!box.value.trim()) pendingPair = ''; comboIndex = comboShown.length ? 0 : -1; paintList(); });
    box.addEventListener('blur', () => { closeCombo(); paintPairs(); });
    box.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!comboOpen) { paintList(); return; }
        const n = comboShown.length; if (!n) return;
        comboIndex = e.key === 'ArrowDown' ? (comboIndex + 1) % n : (comboIndex - 1 + n) % n;
        paintList();
        const act = document.getElementById('f-pair-o' + comboIndex); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (comboOpen && comboShown[comboIndex]) { e.preventDefault(); choosePair(comboShown[comboIndex].mint); }
      } else if (e.key === 'Escape') { if (comboOpen) { e.preventDefault(); closeCombo(); paintPairs(); } }
    });
    Object.keys(KINDS).forEach(k => $(KINDS[k]).addEventListener('change', () => pickKind($(KINDS[k]).checked ? k : 'sol')));
  }).catch(() => { /* picker stays hidden */ });

  const isOn = id => $(id).checked;
  function readSettings() {
    return {
      ai: { coinMaker: isOn('f-ai-maker'), style: $('f-ai-style').value.trim(), chat: isOn('f-ai-chat'), mascotName: $('f-ai-mname').value.trim(), mascotPersona: $('f-ai-mpersona').value.trim() },
      rules: { requireFirstBuy: isOn('f-rule-buy'), minFirstBuySol: Number($('f-rule-min').value) },
      access: { allow: parseWallets($('f-allow').value).list, deny: parseWallets($('f-deny').value).list },
      page: { about: $('f-about').value.trim() },
      pair: { mint: pendingPair },
      holderRewards: isOn('f-holder')
    };
  }

  function say(text, bad) { const el = $('f-status'); el.textContent = text; el.className = 'status' + (bad ? ' bad' : ''); }

  function paint() {
    const pv = $('pv');
    pv.style.setProperty('--accent', state.accent);
    pv.style.setProperty('--on-accent', onAccent(state.accent));
    pv.style.setProperty('--r', state.corners === 'sharp' ? '3px' : '14px');
    pv.style.setProperty('--r-sm', state.corners === 'sharp' ? '2px' : '10px');
    $('pv-name').textContent = state.name || 'Your pad';
    $('pv-tag').textContent = state.tagline || 'Launch a coin.';
    $('pv-url').textContent = '/p/' + (state.slug || 'your-pad');
    $('pv-letter').textContent = (state.name || 'P').charAt(0).toUpperCase();
    $('pv-letter').hidden = Boolean(state.logo);
    $('pv-img').hidden = !state.logo;
    if (state.logo) $('pv-img').src = state.logo.dataUrl;
    const owner = state.ownerPct, launcher = 100 - cfg.platformPct - owner;
    ['pv', 'b'].forEach(p => {
      $(p + '-l').style.width = launcher + '%'; $(p + '-o').style.width = owner + '%'; $(p + '-p').style.width = cfg.platformPct + '%';
    });
    $('k-l').textContent = launcher + '%'; $('k-o').textContent = owner + '%'; $('k-p').textContent = cfg.platformPct + '%';
    $('f-pct-out').textContent = owner + '%';
    const hold = isOn('f-holder');
    $('g-fees-box').hidden = hold;
    $('g-holder-box').hidden = false;
    $('f-holder-soon').hidden = Boolean(cfg.holderRewards);
    $('f-holder').disabled = !cfg.holderRewards || Boolean(editing) || Boolean(pendingPair);
    $('f-holder-fee').textContent = String(cfg.holderLaunchFeeSol === undefined ? 0.05 : cfg.holderLaunchFeeSol);
    if ($('g-pair-box')) $('g-pair-box').classList.toggle('off', hold);
    document.querySelectorAll('#f-swatches .swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === state.accent)));
    document.querySelectorAll('#f-corners button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === state.corners)));
    const ai = cfg.aiAvailable;
    $('f-ai-off').hidden = ai;
    $('f-ai-maker').disabled = !ai; $('f-ai-chat').disabled = !ai;
    $('f-ai-style-wrap').classList.toggle('off', !ai || !isOn('f-ai-maker'));
    $('f-ai-mascot-wrap').classList.toggle('off', !ai || !isOn('f-ai-chat'));
    $('f-rule-buy-wrap').classList.toggle('off', !isOn('f-rule-buy'));
    $('f-bremove').hidden = !(state.banner || (editing && editing.bannerUrl && !state.removeBanner));
    $('f-connect').hidden = Boolean(wallet);
    $('f-go').hidden = !wallet;
    $('f-go').disabled = busy || !cfg.enabled;
    $('f-connect').disabled = busy;
  }

  // ----- Inputs
  $('f-host').textContent = location.host + '/p/';
  $('f-name').addEventListener('input', e => {
    state.name = e.target.value.trim();
    if (!state.slugEdited) { state.slug = slugify(state.name); $('f-slug').value = state.slug; }
    paint();
  });
  $('f-slug').addEventListener('input', e => {
    state.slugEdited = true;
    state.slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    if (e.target.value !== state.slug) e.target.value = state.slug;
    paint();
  });
  $('f-payout').addEventListener('input', e => { state.payout = e.target.value.trim(); });
  ['f-ai-maker', 'f-ai-chat', 'f-rule-buy', 'f-holder'].forEach(id => $(id).addEventListener('change', paint));
  $('f-holder').addEventListener('change', () => { if ($('f-holder').checked && pairsLoaded) pickKind('sol'); });
  window.BapImage.dropzone($('f-bdrop'), $('f-bfile'), pic => {
    state.banner = pic; state.removeBanner = false;
    $('f-bdrop-img').src = pic.dataUrl; $('f-bdrop-img').hidden = false; $('f-bdrop-empty').hidden = true;
    $('f-banner-status').textContent = ''; $('f-banner-status').className = 'status';
    paint();
  }, msg => { $('f-banner-status').textContent = msg; $('f-banner-status').className = 'status bad'; }, 'wide');
  $('f-bremove').addEventListener('click', () => {
    state.banner = null; state.removeBanner = true;
    $('f-bdrop-img').hidden = true; $('f-bdrop-empty').hidden = false; paint();
  });
  $('f-tag').addEventListener('input', e => { state.tagline = e.target.value.trim(); paint(); });
  $('f-pct').addEventListener('input', e => { state.ownerPct = Number(e.target.value); paint(); });
  $('f-corners').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.corners = b.dataset.v; paint(); } });

  const sw = $('f-swatches');
  PRESETS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.c = c; b.style.setProperty('--sw', c); b.setAttribute('aria-label', 'Accent ' + c); b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { state.accent = c; $('f-color').value = c; paint(); });
    sw.appendChild(b);
  });
  const custom = document.createElement('input');
  custom.type = 'color'; custom.id = 'f-color'; custom.value = state.accent; custom.setAttribute('aria-label', 'Custom accent color');
  custom.addEventListener('input', () => { state.accent = custom.value.toLowerCase(); paint(); });
  sw.appendChild(custom);

  window.BapImage.dropzone($('f-drop'), $('f-file'), pic => {
    state.logo = pic;
    $('f-drop-img').src = pic.dataUrl; $('f-drop-img').hidden = false; $('f-drop-empty').hidden = true;
    $('f-logo-status').textContent = ''; $('f-logo-status').className = 'status';
    paint();
  }, msg => { $('f-logo-status').textContent = msg; $('f-logo-status').className = 'status bad'; });

  // "Use my launchpad's link": fills the website with the page address this pad will get, and follows the address as it changes.
  const useSelf = $('f-use-pad'), web = $('f-web');
  function syncSelf() {
    if (!useSelf.checked) return;
    web.value = state.slug ? location.origin + '/p/' + state.slug : '';
  }
  useSelf.addEventListener('change', () => { web.readOnly = useSelf.checked; if (!useSelf.checked) web.value = ''; syncSelf(); });
  ['f-name', 'f-slug'].forEach(id => $(id).addEventListener('input', syncSelf));

  // ----- Wallet
  document.addEventListener('animalpad:wallet', e => { wallet = (e.detail && e.detail.address) || null; paint(); });
  if (W && W.address) wallet = W.address;
  $('f-connect').addEventListener('click', async () => {
    busy = true; paint();
    try { wallet = await W.connect(); say(''); } catch (err) { say(err && err.code === 'no_wallet' ? W.NO_WALLET : 'The wallet connection was not approved.', true); }
    busy = false; paint();
  });

  // ----- Publish
  const WHY = {
    bad_slug: 'The page address needs 3 to 30 letters, numbers or dashes, and cannot start or end with a dash.',
    slug_reserved: 'That address is reserved. Pick another.',
    slug_taken: 'That address is taken. Pick another.',
    bad_name: 'Give your pad a name of at least 2 characters.',
    blocked_name: 'That name is not allowed. Names that copy a real person, brand or project are blocked.',
    bad_color: 'Pick an accent color.',
    bad_fee_share: 'Your fee share is outside the allowed range.',
    bad_logo: 'Add a logo first.',
    bad_payout: 'That payout address is not a valid Solana address. Check it, or leave it empty to use your own wallet.',
    bad_wallet: 'The wallet address was not valid. Reconnect and try again.',
    bad_links: 'Check your links. A website needs https://, and X and Telegram take a handle like @yourpad.',
    stale_signature: 'The signature was too old. Try again.',
    bad_signature: 'The wallet signature did not match. Try again.',
    bad_list: 'One of the wallet addresses is not valid, or a list has more than 100 wallets.',
    bad_min_buy: 'The smallest first buy must be between 0.01 and 5 SOL.',
    bad_banner: 'That banner could not be used. Try a PNG or JPG.',
    not_owner: 'Only the wallet that built this pad can change it. Connect that wallet.',
    not_found: 'That pad could not be found.',
    rate_limited: 'Too many pads from this connection. Try again later.',
    too_many_pads: 'This wallet already owns the maximum number of pads.'
  };

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || !wallet) return;
    if (!state.name || state.name.length < 2) { say(WHY.bad_name, true); return; }
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(state.slug)) { say(WHY.bad_slug, true); return; }
    if (!state.logo && !editing) { say(WHY.bad_logo, true); return; }
    if (state.payout && !B58.test(state.payout)) { say(WHY.bad_payout, true); return; }
    const lists = [parseWallets($('f-allow').value), parseWallets($('f-deny').value)];
    const badAddr = lists[0].bad.concat(lists[1].bad)[0];
    if (badAddr) { say('This is not a valid wallet address: ' + badAddr.slice(0, 20) + (badAddr.length > 20 ? '…' : ''), true); return; }
    if (lists[0].list.length > cfg.maxListSize || lists[1].list.length > cfg.maxListSize) { say(WHY.bad_list, true); return; }
    if (editing && wallet !== editing.ownerWallet) { say(WHY.not_owner, true); return; }
    busy = true; paint();
    try {
      const ts = Date.now();
      const msg = editing
        ? 'BuildAPad: update the launchpad "' + editing.slug + '" owned by ' + wallet + '. Time: ' + ts
        : 'BuildAPad: create the launchpad "' + state.slug + '" owned by ' + wallet + ' with a ' + state.ownerPct + '% fee share paid to ' + (state.payout || wallet) + '. Time: ' + ts;
      say('Approve the signature in your wallet. It does not spend anything.');
      const signature = await W.signMessage(msg);
      say(editing ? 'Saving your changes…' : 'Building your pad…');
      const links = {};
      [['website', 'f-web'], ['twitter', 'f-x'], ['telegram', 'f-tg']].forEach(p => { const v = $(p[1]).value.trim(); if (v) links[p[0]] = v; });
      const payload = { name: state.name, tagline: state.tagline, accent: state.accent, corners: state.corners, links: links, settings: readSettings(), ownerWallet: wallet, ts: ts, signature: signature };
      if (state.logo) payload.logo = state.logo.base64;
      if (state.banner) payload.banner = state.banner.base64;
      if (editing) { payload.removeBanner = state.removeBanner && !state.banner; payload.slug = editing.slug; }
      else { payload.slug = state.slug; payload.ownerPct = isOn('f-holder') ? 0 : state.ownerPct; payload.payoutWallet = state.payout || undefined; }
      const res = await fetch(editing ? '/api/pads/' + editing.slug + '/update' : '/api/pads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.pad) { say((body && body.error === 'blocked_name' && body.word ? 'The word "' + body.word + '" is not allowed. Words that copy a real person, brand or project are blocked. Remove it from your name, tagline, about text, mascot or picture style.' : WHY[body && body.error]) || (editing ? 'Could not save the changes. Try again.' : 'Could not build the pad. Try again.'), true); busy = false; paint(); return; }
      const url = location.origin + '/p/' + body.pad.slug;
      $('done-title').textContent = editing ? 'Your changes are saved' : 'Your pad is live';
      $('done-url').textContent = url; $('done-url').href = '/p/' + body.pad.slug;
      $('done-open').href = '/p/' + body.pad.slug;
      $('done').hidden = false; $('done').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('done-copy').onclick = () => { try { navigator.clipboard.writeText(url).then(() => { $('done-copy').textContent = 'Copied'; }, () => {}); } catch (err) { /* not copied */ } };
      say('Done.');
    } catch (err) {
      const m = err && err.message ? String(err.message) : '';
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : /reject|denied|cancel/i.test(m) ? 'You declined the signature.' : 'The wallet could not sign. Check Phantom and try again.', true);
    }
    busy = false; paint();
  });

  // ----- Edit mode: /build?edit=<name> loads the pad into the same form. Name, address, fee share and payout wallet stay fixed.
  function startEdit(p) {
    editing = p;
    state.name = p.name; state.slug = p.slug; state.slugEdited = true; state.tagline = p.tagline || ''; state.accent = p.accent; state.corners = p.corners; state.ownerPct = p.ownerPct;
    $('f-name').value = p.name; $('f-slug').value = p.slug; $('f-tag').value = p.tagline || '';
    $('f-pct').value = String(p.ownerPct); $('f-payout').value = p.payoutWallet && p.payoutWallet !== p.ownerWallet ? p.payoutWallet : '';
    ['f-name', 'f-slug', 'f-pct', 'f-payout'].forEach(id => { $(id).disabled = true; });
    $('f-color').value = p.accent;
    const L = p.links || {};
    $('f-web').value = L.website || ''; $('f-x').value = L.twitter || ''; $('f-tg').value = L.telegram || '';
    if (L.website || L.twitter || L.telegram) $('f-links').open = true;
    const s = p.settings || {};
    const ai = s.ai || {}, rules = s.rules || {}, acc = s.access || {};
    $('f-ai-maker').checked = Boolean(ai.coinMaker); $('f-ai-style').value = ai.style || ''; $('f-ai-chat').checked = ai.chat !== false;
    $('f-ai-mname').value = ai.mascotName || ''; $('f-ai-mpersona').value = ai.mascotPersona || '';
    $('f-rule-buy').checked = Boolean(rules.requireFirstBuy); if (rules.minFirstBuySol) $('f-rule-min').value = String(rules.minFirstBuySol);
    $('f-allow').value = (acc.allow || []).join('\n'); $('f-deny').value = (acc.deny || []).join('\n');
    $('f-about').value = (s.page && s.page.about) || '';
    $('f-holder').checked = s.holderRewards === true;
    pendingPair = (s.pair && s.pair.mint) || ''; if (pairsLoaded) syncPairBoxes();
    $('f-drop-img').src = p.logoUrl; $('f-drop-img').hidden = false; $('f-drop-empty').hidden = true;
    $('pv-img').src = p.logoUrl; $('pv-img').hidden = false; $('pv-letter').hidden = true;
    if (p.bannerUrl) { $('f-bdrop-img').src = p.bannerUrl; $('f-bdrop-img').hidden = false; $('f-bdrop-empty').hidden = true; }
    $('page-title').textContent = 'Edit your pad';
    $('page-lede').textContent = 'Change the look, links, helpers and rules. The name, address, fee share and payout wallet are fixed once a pad is built.';
    $('f-go').textContent = 'Save changes';
    $('g-sign').textContent = 'Sign and save';
    $('sign-hint').textContent = 'Your wallet signs one line of text that says which pad you are changing. No money moves and nothing is sent to the chain. Only the wallet that built the pad can change it.';
    document.title = 'Edit ' + p.name;
    paint();
  }

  // ----- Start up
  fetch('/api/builder/config', { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(c => {
      if (!c) return;
      cfg = c;
      const range = $('f-pct');
      range.max = String(c.maxOwnerPct);
      if (state.ownerPct > c.maxOwnerPct) { state.ownerPct = c.maxOwnerPct; range.value = String(c.maxOwnerPct); }
      if (!c.enabled) say('Building pads is not switched on for this site yet.', true);
      paint();
    })
    .catch(() => paint())
    .then(() => {
      if (!edit) return;
      return fetch('/api/pads/' + encodeURIComponent(edit), { headers: { Accept: 'application/json' } })
        .then(r => (r.ok ? r.json() : null))
        .then(j => { if (j && j.pad) startEdit(j.pad); else say('That pad could not be found.', true); })
        .catch(() => say('Could not load that pad. Try again in a moment.', true));
    });
  paint();
})();
