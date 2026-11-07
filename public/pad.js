/* A built pad's page: its logo and fee split, and the coin form. A picture is uploaded with the coin's details, and the
   result is handed to launch.js (the wallet steps) as a "staged" coin. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAD = window.PAD, ex = PAD.extra || {};
  let pic = null;
  let busy = false;

  // Header logo and the preview's first letter
  if (ex.logoUrl) { const img = $('pad-logo'); img.src = ex.logoUrl; img.hidden = false; img.addEventListener('error', () => { img.hidden = true; }); }
  $('brand').setAttribute('href', '/');
  $('built-with').textContent = PAD.platform || 'BuildAPad';

  // The pad's own extras: banner, about text, badges, the owner's edit link, and the first-buy rule.
  if (ex.bannerUrl || ex.about) {
    $('padinfo').hidden = false;
    if (ex.bannerUrl) { const b = $('padbanner'); b.src = ex.bannerUrl; b.hidden = false; b.addEventListener('error', () => { b.hidden = true; }); }
    if (ex.about) { const a = $('padabout'); a.textContent = ex.about; a.hidden = false; }
  }
  if (ex.private) $('b-private').hidden = false;
  if (ex.pairMint) { $('b-pair').textContent = 'Pool pair: ' + (ex.pairSymbol || 'custom'); $('b-pair').title = ex.pairName || ''; $('b-pair').hidden = false; }
  if (ex.holderRewards) { $('b-pair').textContent = 'Holders earn the creator fees'; $('b-pair').title = 'All creator fees go to the coin\'s holders. Launching costs a flat fee.'; $('b-pair').hidden = false; }
  if (ex.requireFirstBuy) {
    $('b-buy').textContent = 'First buy of ' + ex.minFirstBuySol + ' SOL or more required'; $('b-buy').hidden = false;
    const buy = $('l-buy'); if (buy) { buy.min = String(ex.minFirstBuySol); buy.placeholder = String(ex.minFirstBuySol); }
  }

  // The fee split, from the server's real numbers
  fetch('/api/launch/config', { headers: { Accept: 'application/json' } }).then(r => r.json()).then(info => {
    const platform = info && Number.isFinite(info.platformPct) ? info.platformPct : 10;
    if (ex.holderRewards) {
      $('fb-l').style.width = '100%'; $('fb-o').style.width = '0%'; $('fb-p').style.width = '0%';
      $('fk-l').textContent = '100%'; $('fk-o').textContent = '0%'; $('fk-p').textContent = '0%';
      $('fk-pname').firstChild.textContent = (PAD.platform || 'Platform') + ' ';
      $('fk-l').previousSibling.textContent = 'Coin holders ';
      const fee = info && Number.isFinite(info.holderLaunchFeeSol) ? info.holderLaunchFeeSol : 0.05;
      const n = $('holder-note'); if (n) { n.textContent = 'Every coin here pays all of its creator fees to its holders, automatically. Launching costs a flat ' + fee + ' SOL, paid to ' + (PAD.platform || 'the platform') + '.'; n.hidden = false; }
      return;
    }
    const owner = ex.ownerPct > 0 ? Math.min(ex.ownerPct, 50 - platform) : 0;
    const launcher = 100 - platform - owner;
    $('fb-l').style.width = launcher + '%'; $('fb-o').style.width = owner + '%'; $('fb-p').style.width = platform + '%';
    $('fk-l').textContent = launcher + '%'; $('fk-o').textContent = owner + '%'; $('fk-p').textContent = platform + '%';
    $('fk-pname').firstChild.textContent = (PAD.platform || 'Platform') + ' ';
  }).catch(() => { /* the bar stays empty */ });

  function say(text, bad) { const el = $('c-status'); el.textContent = text; el.className = 'status' + (bad ? ' bad' : ''); }

  function paint() {
    const name = $('c-name').value.trim(), sym = $('c-sym').value.trim().toUpperCase();
    $('cp-name').textContent = name || 'Your coin';
    $('cp-sym').textContent = sym || 'TICKER';
    $('cp-letter').textContent = (name || '?').charAt(0).toUpperCase();
    $('cp-letter').hidden = Boolean(pic);
    $('cp-img').hidden = !pic;
    if (pic) $('cp-img').src = pic.dataUrl;
  }

  // Changing anything after a coin was staged means it must be saved again, so the launch panel steps back.
  function unstage() {
    $('launch').hidden = true;
    document.dispatchEvent(new CustomEvent('animalpad:reset'));
  }
  ['c-name', 'c-sym', 'c-desc'].forEach(id => $(id).addEventListener('input', () => {
    if (id === 'c-sym') $('c-sym').value = $('c-sym').value.replace(/[^A-Za-z0-9$]/g, '').replace(/^\$/, '').toUpperCase();
    paint(); unstage();
  }));

  window.BapImage.dropzone($('c-drop'), $('c-file'), p => {
    pic = p;
    $('c-drop-img').src = p.dataUrl; $('c-drop-img').hidden = false; $('c-drop-empty').hidden = true;
    say(''); paint(); unstage();
  }, msg => say(msg, true));

  const WHY = {
    bad_request: 'Check the name and ticker. The ticker is 1 to 10 letters or numbers.',
    blocked_name: 'That name or description is not allowed. Names that copy a real person, brand or project are blocked.',
    bad_image: 'That picture could not be used. Try a PNG or JPG.',
    rate_limited: 'Too many uploads. Wait a few minutes.'
  };

  $('coinform').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const name = $('c-name').value.trim(), ticker = $('c-sym').value.trim().toUpperCase();
    if (!name) { say('Give your coin a name.', true); return; }
    if (!/^[A-Z0-9]{1,10}$/.test(ticker)) { say(WHY.bad_request, true); return; }
    if (!pic) { say('Add a logo for your coin.', true); return; }
    busy = true; $('c-go').disabled = true; say('Saving…');
    try {
      const res = await fetch('/api/art/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: pic.base64, name: name, ticker: ticker, description: $('c-desc').value.trim() })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.id) { say(WHY[body && body.error] || 'Could not save the coin. Try again.', true); }
      else {
        say('Saved. Next: connect your wallet and launch.');
        $('launch').hidden = false;
        document.dispatchEvent(new CustomEvent('animalpad:staged', { detail: { name: body.name, symbol: body.ticker, art: body.id } }));
        $('launch').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) { say('Could not reach the server. Try again.', true); }
    busy = false; $('c-go').disabled = false;
  });

  // AI picture maker, when the owner switched it on. The result fills the form; the picture is then saved like an uploaded one.
  if (ex.aiCoinMaker) {
    fetch('/api/art/config', { headers: { Accept: 'application/json' } }).then(r => r.json()).then(c => { if (c && c.enabled) $('aipanel').hidden = false; }).catch(() => { /* stays hidden */ });
    const AIWHY = { ai_off: 'The AI picture maker is switched off on this launchpad.', not_allowed: 'This wallet cannot use this launchpad.', pad_daily_limit: 'This launchpad has used its AI pictures for today. Upload a picture instead, or try tomorrow.', daily_limit: 'The AI picture maker is resting for today. Upload a picture instead.', rate_limited: 'Too many tries. Wait a few minutes.', bad_prompt: 'Describe your coin in a few words.', blocked_prompt: 'That idea is not allowed. Ideas that copy a real person, brand or character are blocked.', generation_failed: 'The picture could not be drawn. Try again.', art_unavailable: 'The AI picture maker is not switched on for this site.' };
    const aiSay = (t, bad) => { const el = $('ai-status'); el.textContent = t; el.className = 'status' + (bad ? ' bad' : ''); };
    let aiBusy = false;
    const aiBtns = ['ai-go', 'ai-ideas', 'ai-surprise'];
    const aiLock = on => { aiBusy = on; aiBtns.forEach(i => { $(i).disabled = on; }); };
    const who = () => (window.AnimalWallet && window.AnimalWallet.address) || undefined;
    // Draws the picture for an idea and fills the form. `fill` (name, ticker, description) is used when the idea came from the helper.
    async function draw(idea, fill) {
      aiSay('Drawing… this takes about 10 seconds.');
      const res = await fetch('/api/art/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ animal: idea, pad: ex.slug, wallet: who() }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.imageUrl) { aiSay(AIWHY[body && body.error] || 'Could not draw that. Try again.', true); return false; }
      // Pull the drawn picture back through the same shrink-and-check step as an upload, so there is one path to launch.
      const blob = await (await fetch(body.imageUrl)).blob();
      pic = await window.BapImage.square(new File([blob], 'ai.' + (blob.type === 'image/jpeg' ? 'jpg' : 'png'), { type: blob.type || 'image/png' }));
      $('c-drop-img').src = pic.dataUrl; $('c-drop-img').hidden = false; $('c-drop-empty').hidden = true;
      const f = fill || body;
      $('c-name').value = f.name || body.name || ''; $('c-sym').value = String(f.ticker || body.ticker || '').toUpperCase(); $('c-desc').value = f.description || body.description || '';
      aiSay('Done. Change anything you like, then press Continue.'); paint(); unstage();
      return true;
    }
    async function ideas(count, hint) {
      const res = await fetch('/api/art/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: ex.slug, wallet: who(), count, hint }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !Array.isArray(body.ideas) || !body.ideas.length) { aiSay(AIWHY[body && body.error] || 'Could not think of ideas. Try again.', true); return null; }
      return body.ideas;
    }
    const mascot = ex.mascotName || 'The mascot';
    function showIdeas(list) {
      const box = $('ai-list'); box.textContent = '';
      list.forEach(i => {
        const card = document.createElement('div'); card.className = 'idea';
        const t = document.createElement('b'); t.textContent = i.name + ' $' + i.ticker;
        const d = document.createElement('span'); d.className = 'hint'; d.textContent = i.description;
        const row = document.createElement('div'); row.className = 'row';
        const use = document.createElement('button'); use.type = 'button'; use.className = 'btn'; use.textContent = 'Use this';
        use.addEventListener('click', () => { $('c-name').value = i.name; $('c-sym').value = i.ticker; $('c-desc').value = i.description; $('ai-idea').value = i.idea; aiSay('Filled in. Press Draw it for a picture, or add your own.'); paint(); unstage(); });
        const dr = document.createElement('button'); dr.type = 'button'; dr.className = 'btn go'; dr.textContent = 'Use and draw';
        dr.addEventListener('click', async () => { if (aiBusy) return; aiLock(true); try { await draw(i.idea, i); } catch (e) { aiSay('Could not draw that. Try again.', true); } aiLock(false); });
        row.appendChild(use); row.appendChild(dr); card.appendChild(t); card.appendChild(d); card.appendChild(row); box.appendChild(card);
      });
      box.hidden = false;
    }
    $('ai-ideas').addEventListener('click', async () => {
      if (aiBusy) return;
      aiLock(true); aiSay(mascot + ' is thinking…');
      try { const l = await ideas(3, $('ai-idea').value.trim()); if (l) { showIdeas(l); aiSay('Pick one, or ask again for more.'); } } catch (e) { aiSay('Could not think of ideas. Try again.', true); }
      aiLock(false);
    });
    $('ai-surprise').addEventListener('click', async () => {
      if (aiBusy) return;
      aiLock(true); aiSay(mascot + ' is picking something…');
      try { const l = await ideas(1, ''); if (l) await draw(l[0].idea, l[0]); } catch (e) { aiSay('Could not draw that. Try again.', true); }
      aiLock(false);
    });
    $('ai-go').addEventListener('click', async () => {
      if (aiBusy) return;
      const idea = $('ai-idea').value.trim();
      if (idea.length < 3) { aiSay(AIWHY.bad_prompt, true); return; }
      aiLock(true);
      try { await draw(idea); } catch (err) { aiSay('Could not draw that. Try again.', true); }
      aiLock(false);
    });
  }

  // The mascot's report on this pad's coins. Shows nothing until the pad has launched a coin, or if the owner turned the mascot off.
  if (ex.mascotChat !== false) {
    fetch('/api/pads/' + encodeURIComponent(ex.slug) + '/report', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        const f = b && b.facts;
        if (!f) return;
        $('padreport-h').textContent = (b.mascot || PAD.name || 'The mascot') + "'s report on " + (PAD.name || 'this launchpad');
        $('padreport-text').textContent = b.report || '';
        $('padreport-text').hidden = !b.report;
        $('padreport-note').hidden = !b.report;
        $('padreport-facts').textContent = [f.coinsLaunched + (f.coinsLaunched === 1 ? ' coin' : ' coins') + ' launched', f.totalRaisedSol + ' SOL raised in total', f.graduated + ' graduated', f.launchedLast24h + ' new in the last day'].join(' · ');
        $('padreport').hidden = false;
      })
      .catch(() => { /* no report */ });
  }

  paint();
})();
