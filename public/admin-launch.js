/* Admin-only page: launches the site's own coin. The server holds the name, ticker, description and logo; this page shows
   them, checks that the connected wallet is the admin wallet, and hands the coin to launch.js (the wallet steps).
   The real lock is on the server (only the admin wallet can launch this picture) and in the wallet (it must sign). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let founder = null;

  function note(text) { const n = $('ol-note'); n.textContent = text; n.hidden = !text; }
  const short = a => a.slice(0, 4) + '…' + a.slice(-4);

  function showDone(l) {
    $('ol-launch').hidden = true;
    $('ol-done').hidden = false;
    const ca = $('ol-ca'); ca.textContent = '';
    const code = document.createElement('code'); code.className = 'cavalue'; code.textContent = l.mint; ca.appendChild(code);
    $('ol-open').setAttribute('href', '/coin/' + encodeURIComponent(l.pool));
  }

  // Only the admin wallet is allowed to stage the coin; anyone else just sees the page.
  function check(address) {
    if (!founder || founder.launched) return;
    if (!address) { $('ol-wrong').hidden = true; document.dispatchEvent(new CustomEvent('animalpad:reset')); return; }
    if (address !== founder.wallet) {
      $('ol-wrong').textContent = 'This wallet is not the admin wallet. Connect the wallet ending ' + founder.wallet.slice(-4) + '.';
      $('ol-wrong').hidden = false;
      document.dispatchEvent(new CustomEvent('animalpad:reset'));
      return;
    }
    $('ol-wrong').hidden = true;
    document.dispatchEvent(new CustomEvent('animalpad:staged', { detail: { name: founder.name, symbol: founder.ticker, art: founder.id } }));
  }

  document.addEventListener('animalpad:wallet', e => check(e.detail && e.detail.address));

  fetch('/api/founder', { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : null))
    .then(f => {
      if (!f) { note('The official coin is not set up. Set FOUNDER_WALLET (or PLATFORM_FEE_WALLET) in Railway, and keep the founder logo in pads/buildapad/assets/.'); return; }
      founder = f;
      $('ol-main').hidden = false;
      $('ol-name').textContent = f.name; $('ol-name2').textContent = f.name;
      $('ol-sym').textContent = '$' + f.ticker; $('ol-sym2').textContent = '$' + f.ticker;
      $('ol-desc').textContent = f.description;
      $('ol-wallet').textContent = short(f.wallet);
      $('ol-img').src = f.imageUrl;
      $('l-web').value = location.origin;
      if (f.launched) { showDone(f.launched); return; }
      $('ol-launch').hidden = false;
      if (window.AnimalWallet && window.AnimalWallet.address) check(window.AnimalWallet.address);
    })
    .catch(() => note('Could not load the official coin. Try again in a moment.'));
})();
