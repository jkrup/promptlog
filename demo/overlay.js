// Injected into every recorded page (scene pages, the live viewer, the concept page).
// Draws captions, a fake cursor, highlight boxes and a badge, and returns a signature of what is on
// screen so the renderer can skip identical frames. Class names are prefixed so page CSS can't restyle them.
(() => {
  if (window.__ovApply) return;
  const css = `
  #__ov { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; text-transform: none; letter-spacing: normal; }
  #__ov .ov-cap { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); max-width: 1060px; width: max-content;
    background: rgba(12,13,17,.86); color: #fff; font-size: 21px; line-height: 1.38; font-weight: 500; letter-spacing: .1px;
    padding: 9px 18px 10px; border-radius: 10px; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  #__ov .ov-cap:empty { display: none; }
  #__ov .ov-cur { position: absolute; width: 26px; height: 26px; margin: -3px 0 0 -4px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
  #__ov .ov-ring { position: absolute; border: 3px solid #f26b2a; border-radius: 50%; }
  #__ov .ov-hl { position: absolute; border: 3px solid #f26b2a; border-radius: 10px; }
  #__ov .ov-hl.ov-dim { box-shadow: 0 0 0 4000px rgba(14,15,20,.30); }
  #__ov .ov-lab { position: absolute; left: -3px; top: -34px; background: #f26b2a; color: #fff; font-size: 15px; font-weight: 650;
    padding: 4px 10px; border-radius: 7px; white-space: nowrap; text-transform: none; letter-spacing: normal; line-height: 1.3; }
  #__ov .ov-lab.ov-below { top: auto; bottom: -34px; }
  #__ov .ov-badge { position: absolute; right: 16px; top: 9px; background: rgba(12,13,17,.88); color: #fff; font-size: 15px; font-weight: 600;
    padding: 6px 12px; border-radius: 8px; letter-spacing: .2px; line-height: 1.3; }
  #__ov .ov-badge.ov-center { right: auto; left: 50%; transform: translateX(-50%); }
  #__ov .ov-badge b { color: #ff9a5c; font-weight: 700; }
  #__ov .ov-badge:empty { display: none; }
  html { scroll-behavior: auto !important; }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
  const root = document.createElement('div');
  root.id = '__ov';
  root.innerHTML = `<div class="ov-badge"></div><div class="ov-hls"></div><div class="ov-ring" style="display:none"></div>
    <svg class="ov-cur" style="display:none" viewBox="0 0 26 26"><path d="M4 2 L4 21 L9 16.5 L12.5 24 L16 22.5 L12.6 15.2 L19 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <div class="ov-cap"></div>`;
  document.body.appendChild(root);
  const cap = root.querySelector('.ov-cap');
  const badge = root.querySelector('.ov-badge');
  const hls = root.querySelector('.ov-hls');
  const cur = root.querySelector('.ov-cur');
  const ring = root.querySelector('.ov-ring');

  window.__ovApply = (s) => {
    let sig = '';
    if (typeof s.y === 'number') window.scrollTo(0, Math.round(s.y));
    sig += 'y' + Math.round(window.scrollY);
    if (window.setT) sig += '|t' + window.setT(s.t);
    if (cap.textContent !== (s.cap || '')) cap.textContent = s.cap || '';
    sig += '|c' + (s.cap || '');
    if (badge.innerHTML !== (s.badge || '')) badge.innerHTML = s.badge || '';
    badge.className = 'ov-badge' + (s.badgePos === 'center' ? ' ov-center' : '');
    sig += '|b' + (s.badge || '');
    const want = s.hls || [];
    while (hls.children.length < want.length) {
      const d = document.createElement('div');
      d.className = 'ov-hl';
      d.innerHTML = '<div class="ov-lab"></div>';
      hls.appendChild(d);
    }
    while (hls.children.length > want.length) hls.lastChild.remove();
    want.forEach((h, i) => {
      const d = hls.children[i];
      const els = typeof h.sel === 'string' ? [...document.querySelectorAll(h.sel)] : [];
      const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      if (!rs.length) {
        d.style.display = 'none';
        sig += '|h-';
        return;
      }
      const left = Math.min(...rs.map((x) => x.left));
      const top = Math.min(...rs.map((x) => x.top));
      const width = Math.max(...rs.map((x) => x.right)) - left;
      const height = Math.max(...rs.map((x) => x.bottom)) - top;
      const p = h.pad ?? 6;
      d.style.display = '';
      d.className = 'ov-hl' + (h.dim ? ' ov-dim' : '');
      d.style.left = Math.round(left - p) + 'px';
      d.style.top = Math.round(top - p) + 'px';
      d.style.width = Math.round(width + 2 * p) + 'px';
      d.style.height = Math.round(height + 2 * p) + 'px';
      d.style.opacity = h.o.toFixed(2);
      const lab = d.firstChild;
      lab.textContent = h.label || '';
      lab.style.display = h.label ? '' : 'none';
      lab.className = 'ov-lab' + (h.below ? ' ov-below' : '');
      sig += `|h${d.style.left},${d.style.top},${d.style.width},${d.style.height},${d.style.opacity},${h.label || ''}`;
    });
    if (s.cur) {
      cur.style.display = '';
      cur.style.left = s.cur.x.toFixed(1) + 'px';
      cur.style.top = s.cur.y.toFixed(1) + 'px';
      cur.style.transform = s.cur.down ? 'scale(.86)' : '';
      sig += `|k${s.cur.x.toFixed(1)},${s.cur.y.toFixed(1)},${s.cur.down ? 1 : 0}`;
      if (s.cur.ring > 0 && s.cur.ring < 1) {
        const rr = 10 + 26 * s.cur.ring;
        ring.style.display = '';
        ring.style.left = s.cur.x - rr + 'px';
        ring.style.top = s.cur.y - rr + 'px';
        ring.style.width = ring.style.height = 2 * rr + 'px';
        ring.style.opacity = (1 - s.cur.ring).toFixed(2);
        sig += '|r' + s.cur.ring.toFixed(2);
      } else ring.style.display = 'none';
    } else {
      cur.style.display = 'none';
      ring.style.display = 'none';
    }
    return sig;
  };
})();
