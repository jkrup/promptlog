// Deterministic animation for the demo's scene pages. The renderer sets window.CUES (start time of
// each narrated sentence, seconds) and calls window.setT(t) once per frame; setT returns a signature
// so identical frames are not re-captured.
//   data-s="2" data-d=".4"   fade/slide in at sentence 2 start + 0.4 s
//   data-out="4"             fade out at sentence 4 start (+ data-od delay)
//   data-type="40"           type the text at 40 chars/s from its cue (caret while typing)
//   data-draw                SVG path/line: draw its stroke from its cue over data-dur seconds
(() => {
  const at = (el, k = 's', dk = 'd') => {
    const s = el.dataset[k];
    if (s === undefined) return null;
    const cues = window.CUES || [0];
    const base = s === 'end' ? (window.END || 0) : (cues[+s] ?? 0);
    return base + parseFloat(el.dataset[dk] || '0');
  };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (p) => 1 - Math.pow(1 - p, 3);
  const els = () => Array.from(document.querySelectorAll('[data-s],[data-out]'));
  window.setT = (t) => {
    let sig = '';
    for (const el of els()) {
      const a = at(el);
      if (el.dataset.type !== undefined) {
        if (el.dataset.full === undefined) el.dataset.full = el.textContent;
        const full = el.dataset.full;
        const n = a === null ? full.length : Math.max(0, Math.min(full.length, Math.floor((t - a) * parseFloat(el.dataset.type || '30'))));
        const typing = a !== null && t >= a && n < full.length;
        el.innerHTML = '';
        el.appendChild(document.createTextNode(full.slice(0, n)));
        if (typing || (el.dataset.caret !== undefined && t >= a)) {
          const c = document.createElement('span');
          c.className = 'caret';
          el.appendChild(c);
        }
        el.style.visibility = a === null || t >= a ? 'visible' : 'hidden';
        sig += n + (typing ? 'c' : '') + ',';
        continue;
      }
      if (el.dataset.draw !== undefined) {
        const len = el.getTotalLength ? el.getTotalLength() : 1000;
        const p = a === null ? 1 : clamp((t - a) / parseFloat(el.dataset.dur || '0.6'));
        el.style.strokeDasharray = `${len}`;
        el.style.strokeDashoffset = `${len * (1 - ease(p))}`;
        el.style.opacity = p > 0 ? '1' : '0';
        sig += Math.round(p * 100) + ',';
        continue;
      }
      let o = a === null ? 1 : ease(clamp((t - a) / 0.5));
      let dy = a === null ? 0 : (1 - o) * 16;
      const ao = at(el, 'out', 'od');
      if (ao !== null) {
        const q = ease(clamp((t - ao) / 0.45));
        const floor = parseFloat(el.dataset.dimto || '0');
        o = o * (1 - q) + Math.min(o, floor) * q;
      }
      el.style.opacity = o.toFixed(3);
      el.style.transform = dy ? `translateY(${dy.toFixed(1)}px)` : '';
      sig += Math.round(o * 100) + ',';
    }
    return sig;
  };
})();
