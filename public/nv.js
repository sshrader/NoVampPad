// The ticker check on the home page: asks the server whether a ticker is already taken here. It only reads the list and holds nothing.
(function () {
  'use strict';
  var q = document.getElementById('nv-q'), out = document.getElementById('nv-result'), count = document.getElementById('nv-count');
  if (!q || !out) return;
  var timer = 0, seq = 0;
  function show(kind, stamp, text) {
    out.className = 'nvresult ' + kind;
    out.textContent = '';
    if (stamp) { var s = document.createElement('span'); s.className = 'stamp'; s.textContent = stamp; out.appendChild(s); }
    var m = document.createElement('span'); m.className = 'msg'; m.textContent = text; out.appendChild(m);
  }
  function ask() {
    var raw = q.value.replace(/^\$/, '').trim();
    if (!raw) { show('idle', '', 'Type a ticker to check it against every coin launched here.'); return; }
    var mine = ++seq;
    fetch('/api/originals/check?symbol=' + encodeURIComponent(raw), { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (mine !== seq) return;
        if (!d) { show('idle', '', 'The check is not available right now.'); return; }
        if (typeof d.count === 'number') count.textContent = d.count === 1 ? '1 original launched here' : d.count + ' originals launched here';
        if (d.ok) show('free', 'FREE', '$' + raw.toUpperCase() + ' is not taken. Launch it before someone else does.');
        else if (d.error === 'bad_symbol') show('idle', '', 'Use letters or digits for a ticker.');
        else show('taken', 'TAKEN', '$' + raw.toUpperCase() + ' matches $' + String(d.by && d.by.symbol || '').slice(0, 10) + (d.by && d.by.name ? ' (' + String(d.by.name).slice(0, 32) + ')' : '') + '. Pick another.');
      })
      .catch(function () { if (mine === seq) show('idle', '', 'The check is not available right now.'); });
  }
  q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(ask, 220); });
  fetch('/api/originals/check?symbol=', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && typeof d.count === 'number') count.textContent = d.count === 1 ? '1 original launched here' : d.count + ' originals launched here'; }).catch(function () {});
})();
