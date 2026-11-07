/* Shrinks a chosen picture to a square before it is uploaded: cropped to the middle, 512 px, as PNG when that is small
   enough and as JPEG when it is not. The server checks the result again, so this only keeps uploads quick. */
(function () {
  'use strict';

  const MAX_BYTES = 340000;

  function load(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not_image')); };
      img.src = url;
    });
  }

  // Crops the middle of the picture to a w by h rectangle (a square when h is left out).
  function draw(img, w, background, h) {
    h = h || w;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (background) { g.fillStyle = background; g.fillRect(0, 0, w, h); }
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const sw = w / scale, sh = h / scale;
    g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, w, h);
    return c;
  }

  const toBlob = (canvas, type, q) => new Promise(resolve => canvas.toBlob(resolve, type, q));

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('read_failed'));
      r.readAsDataURL(blob);
    });
  }

  // Resolves { base64, dataUrl, type } or rejects with Error('not_image') / Error('too_big').
  async function square(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('not_image'); // SVG is not accepted
    if (file.size > 12000000) throw new Error('too_big');
    const img = await load(file);
    const tries = [['image/png', 512, undefined, 0], ['image/jpeg', 512, 0.9, '#0a0b0e'], ['image/jpeg', 384, 0.78, '#0a0b0e']];
    for (const t of tries) {
      const blob = await toBlob(draw(img, t[1], t[3] || null), t[0], t[2]);
      if (blob && blob.size <= MAX_BYTES) {
        const base64 = await toBase64(blob);
        return { base64, dataUrl: 'data:' + t[0] + ';base64,' + base64, type: t[0] };
      }
    }
    throw new Error('too_big');
  }

  // A wide banner, 1200 by 400, as JPEG so it stays small.
  async function wide(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('not_image');
    if (file.size > 12000000) throw new Error('too_big');
    const img = await load(file);
    for (const t of [[1200, 400, 0.85], [900, 300, 0.75]]) {
      const blob = await toBlob(draw(img, t[0], '#0a0b0e', t[1]), 'image/jpeg', t[2]);
      if (blob && blob.size <= MAX_BYTES) { const base64 = await toBase64(blob); return { base64, dataUrl: 'data:image/jpeg;base64,' + base64, type: 'image/jpeg' }; }
    }
    throw new Error('too_big');
  }

  // Wires a drop zone: click or drop a file, and call onPick with the shrunk picture. Returns nothing.
  function dropzone(zone, input, onPick, onError, shape) {
    const take = async file => {
      try { onPick(await (shape === 'wide' ? wide : square)(file)); } catch (err) { onError(err && err.message === 'too_big' ? 'That picture is too large. Try a smaller one.' : 'Use a PNG, JPG, WebP or GIF picture.'); }
    };
    input.addEventListener('change', () => { if (input.files && input.files[0]) take(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) take(f); });
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  }

  window.BapImage = { square, wide, dropzone };
})();
