// Which Solana network this server is on. Pages read it from /api/launch/config, so links and wording
// follow the server's setting. Until it loads, it assumes devnet (the safe, play-money default).
(function () {
  const net = {
    cluster: 'devnet',
    main: false,
    name: 'devnet',
    suffix: '?cluster=devnet',
    // dial.to needs the cluster for devnet only.
    dialSuffix: '&cluster=devnet',
    apply: function (cluster) {
      net.cluster = cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
      net.main = net.cluster === 'mainnet-beta';
      net.name = net.main ? 'Solana' : 'devnet';
      net.suffix = net.main ? '' : '?cluster=devnet';
      net.dialSuffix = net.main ? '' : '&cluster=devnet';
      try {
        document.querySelectorAll('[data-net="name"]').forEach(function (el) { el.textContent = net.name; });
        document.querySelectorAll('[data-net-only]').forEach(function (el) { el.hidden = el.getAttribute('data-net-only') !== net.cluster; });
      } catch (e) { /* page without these */ }
    }
  };
  net.ready = fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (c) { net.apply(c && c.cluster); return net; })
    .catch(function () { net.apply('devnet'); return net; });
  // The server puts the pad's name and wording in window.PAD. This is only a fallback for a bare static page.
  if (!window.PAD) window.PAD = { id: 'hatchpad', name: 'HatchPad', subject: 'animal', aSubject: 'an animal', subjects: 'animals', ideas: { moods: null, things: null, extras: null } };
  if (!window.PAD.platform) window.PAD.platform = window.PAD.name;
  // "65% creator, 15% pad owner, 20% BuildAPad", read from a coin's real on-chain split when the server sends it.
  window.feeLine = function (info) {
    const p = window.PAD.platform;
    if (!info || !info.shares || !info.shares.length) return info ? info.creatorPct + '% creator, ' + info.platformPct + '% ' + p : '';
    let seenCreator = false;
    return info.shares.map(s => {
      if (s.address === info.platformWallet) return s.pct + '% ' + p;
      if (!seenCreator) { seenCreator = true; return s.pct + '% creator'; }
      return s.pct + '% pad owner';
    }).join(', ');
  };
  // Dollars, for amounts of any pool token: "$1,234", "$12.34", "$0.0028" or "under $0.0001". Empty when the price is unknown.
  net.usd = function (n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n === 0) return '$0';
    if (n < 0.0001) return 'under $0.0001';
    if (n < 1) return '$' + Number(n.toPrecision(2)).toString();
    if (n < 1000) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString();
  };
  window.AnimalNet = net;

  // SOL and BTC price chips in the header, refreshed every minute. A chip stays hidden if its price cannot be read.
  function startTicker() {
    const row = document.querySelector('.top .row');
    if (!row) return;
    function chip(label, color, title) {
      const el = document.createElement('span');
      el.className = 'chip-price'; el.hidden = true; el.title = title;
      const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); dot.style.background = color;
      const txt = document.createElement('span');
      el.appendChild(dot); el.appendChild(txt);
      return { el: el, set: function (v) { if (!Number.isFinite(v)) return; txt.textContent = label + ' $' + (v >= 10000 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); el.hidden = false; } };
    }
    const sol = chip('SOL', 'linear-gradient(135deg, #9945ff, #14f195)', 'Solana price in US dollars');
    const btc = chip('BTC', '#f7931a', 'Bitcoin price in US dollars');
    row.insertBefore(btc.el, row.firstChild); row.insertBefore(sol.el, row.firstChild);
    function pull() {
      fetch('/api/price', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) { if (!b) return; sol.set(b.usd); btc.set(b.btcUsd); })
        .catch(function () { /* keep the last prices, or stay hidden */ });
    }
    pull();
    setInterval(pull, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startTicker); else startTicker();
})();
