/* Platform fee claiming. Lists what each coin has earned for the fee claimer and claims it with the
   claimer's wallet. The server prepares each claim; the wallet signs it. Nothing secret lives here. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const W = window.AnimalWallet;
  const root = document.documentElement;
  const themeBtn = $('theme') || document.createElement('button'); // dark only: the page has no switch
  themeBtn.addEventListener('click', () => {
    const light = root.dataset.theme !== 'light';
    if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    try { localStorage.setItem('animalpad-theme', light ? 'light' : 'dark'); } catch (e) { /* still works */ }
  });

  let wallet = '';
  let data = null;      // the last fee list from the server
  let names = {};       // pool -> coin name, for the coins the public list knows
  let busy = false;

  const fmt = n => Number(n).toFixed(6);
  // The server pays nothing out below this (dust), so the page treats such a coin as having nothing waiting.
  const MIN_TOTAL = 0.00001;
  const claimable = p => !p.migrated && p.totalSol >= MIN_TOTAL && p.waitingSol > 0;
  const say = (t, bad) => { const s = $('status'); s.textContent = t; s.className = 'dl-status' + (bad ? ' bad' : ''); };
  const note = t => { const n = $('note'); n.textContent = t; n.hidden = !t; };
  const WHY = {
    split_not_set: 'That coin\'s fee split is not set, so it cannot be paid out here.',
    migrated: 'That coin has moved to its trading pool; its fees are paid out on pump.fun.',
    nothing_to_claim: 'Nothing to send out on that coin right now.',
    rate_limited: 'Too many requests. Wait a minute.',
    not_an_animalpad_pool: 'That pool is not an ' + window.PAD.platform + ' coin.',
    fees_read_failed: 'The server could not read the fees from the chain. Public RPCs often refuse this lookup. Set LAUNCH_RPC_URL on the server to a dedicated RPC address (Helius or QuickNode), and check the server log for "Partner fee read failed".',
    launch_unavailable: 'Launching is not switched on for this site, so there are no fees to read.'
  };

  function row(p) {
    const li = document.createElement('li');
    const who = document.createElement('div'); who.className = 'who';
    const b = document.createElement('b'); b.textContent = names[p.pool] || 'Coin';
    const a = document.createElement('span'); a.textContent = p.pool;
    who.appendChild(b); who.appendChild(a);
    const amt = document.createElement('div'); amt.className = 'amt';
    amt.textContent = p.migrated ? 'Graduated: fees are paid out on pump.fun' : fmt(p.waitingSol) + (p.paired ? ' of its pair token' : ' SOL') + ' your share · ' + fmt(p.totalSol) + ' waiting in total';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Send out';
    btn.disabled = busy || !claimable(p);
    btn.addEventListener('click', () => claim([p]));
    li.appendChild(who); li.appendChild(amt); li.appendChild(btn);
    return li;
  }

  function render() {
    const allowed = Boolean(wallet && data && data.feeClaimers.indexOf(wallet) !== -1);
    $('connect').hidden = Boolean(wallet);
    $('who').textContent = wallet ? 'Connected ' + wallet.slice(0, 4) + '…' + wallet.slice(-4) : '';
    if (wallet && data && !allowed) {
      note('This is not the platform fee wallet. The platform fee wallet is ' + data.feeClaimers.join(', ') + '. Connect that wallet in Phantom.');
    } else if (!data || allowed) note('');
    $('body').hidden = !allowed;
    if (!allowed) return;
    const waiting = data.pools.filter(claimable);
    $('total').textContent = fmt(data.totalWaitingSol) + (data.pools.some(p => p.paired && claimable(p)) ? ' (SOL coins only; pair-token coins are listed separately)' : '');
    $('count').textContent = String(data.pools.length);
    $('claim-all').disabled = busy || !waiting.length;
    $('reload').disabled = busy;
    const list = $('list');
    list.textContent = '';
    data.pools.forEach(p => list.appendChild(row(p)));
  }

  async function load(keepStatus) {
    if (!keepStatus) say('Loading…');
    try {
      const [res, pub] = await Promise.all([
        fetch('/api/admin/fees', { cache: 'no-store', headers: { Accept: 'application/json' } }),
        fetch('/api/launches', { cache: 'no-store' }).then(r => r.json()).catch(() => null)
      ]);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        say(WHY[body && body.error] || (body ? 'Could not load the fees (' + (body.error || res.status) + '). Try again.' : 'The server did not answer with fee data (HTTP ' + res.status + '). It may still be deploying. Wait a minute and refresh.'), true);
        return;
      }
      data = body;
      names = {};
      ((pub && pub.launches) || []).forEach(c => { names[c.pool] = c.name + ' $' + c.symbol; });
      if (!keepStatus) say('');
    } catch (e) { say('Could not load the fees. Try again.', true); }
    render();
  }

  async function claim(list) {
    if (busy || !wallet) return;
    busy = true; render();
    let claimed = 0, total = 0;
    try {
      for (const p of list) {
        if (!claimable(p)) continue;
        say('Preparing the payout for ' + (names[p.pool] || p.pool.slice(0, 6) + '…') + '…');
        const res = await fetch('/api/admin/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: p.pool, claimer: wallet }) });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.transaction !== 'string') {
          if (body && (body.error === 'nothing_to_claim' || body.error === 'migrated')) continue;
          say(WHY[body && body.error] || 'Could not prepare that claim. Try again.', true);
          break;
        }
        say('Approve the payout in your wallet…');
        const sig = await W.signAndSend(body.transaction);
        say('Sent. Waiting for the network to confirm…');
        const state = await W.confirm(sig);
        if (state !== 'confirmed') { say(state === 'failed' ? 'A claim failed on-chain. Refresh and try again.' : 'Not confirmed yet. Refresh in a minute.', true); break; }
        claimed++; total += body.waitingSol || 0;
      }
      if (!claimed && $('status').textContent.indexOf('Preparing') === 0) say('Nothing to send out right now: the waiting fees are too small to pay out.');
      if (claimed) say('Sent ✓ ' + claimed + ' coin' + (claimed === 1 ? '' : 's') + ', about ' + fmt(total) + ' SOL, paid out to the creator and platform wallets.');
    } catch (err) {
      const m = err && err.message ? String(err.message) : '';
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : /reject|denied|cancel/i.test(m) ? 'You declined the transaction.' : 'The claim did not go through. Check that your wallet is on ' + (AnimalNet.main ? 'Solana mainnet.' : 'Devnet.'), true);
    }
    busy = false;
    await load(true);
  }

  async function connect() {
    try {
      wallet = await W.connect();
      await load();
    } catch (err) {
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : 'Wallet connection was not approved.', true);
    }
  }

  document.addEventListener('animalpad:wallet', e => { wallet = (e.detail && e.detail.address) || ''; if (data) render(); else if (wallet) load(); });
  $('connect').addEventListener('click', connect);
  $('claim-all').addEventListener('click', () => claim((data && data.pools) || []));
  $('reload').addEventListener('click', load);
  load();
})();
