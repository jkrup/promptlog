// The viewer's only client-side code: a small vanilla-JS island, inlined into every page as
// `(${clientMain.toString()})()`. It must be self-contained (no imports, no closure over module scope).
// Written as a real function so it's typechecked; Node's type stripping leaves valid JS in toString().

export function clientMain(): void {
  const $$ = (sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>(sel));

  // --- Local times -----------------------------------------------------------------------------
  const localize = (root: ParentNode) => {
    for (const el of $$('time[datetime]', root)) {
      const d = new Date(el.getAttribute('datetime') ?? '');
      if (Number.isNaN(d.getTime())) continue;
      el.title = d.toString();
      el.textContent = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  };

  // --- Clamped replies: show "Show more" only when the text actually overflows -------------------
  const clamp = (root: ParentNode) => {
    for (const body of $$('[data-clamp]', root)) {
      const btn = body.nextElementSibling as HTMLButtonElement | null;
      if (!btn || !btn.classList.contains('more') || body.dataset.clampReady) continue;
      body.dataset.clampReady = '1';
      if (body.scrollHeight > body.clientHeight + 6) {
        body.classList.add('clamped');
        btn.hidden = false;
        btn.addEventListener('click', () => {
          const open = body.classList.toggle('expanded');
          btn.setAttribute('aria-expanded', String(open));
          btn.textContent = open ? 'Show less' : 'Show more';
        });
      }
    }
  };

  const errorBox = (msg: string) => {
    const div = document.createElement('div');
    div.className = 'panel-error';
    div.textContent = msg;
    return div;
  };

  // --- Lazy panels (turn diff, raw log, human edits) -------------------------------------------
  document.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-panel]');
    if (!btn) return;
    const panel = document.getElementById(btn.dataset.panel ?? '');
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open || panel.dataset.loaded) return;
    panel.dataset.loaded = '1';
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';
    try {
      const res = await fetch(btn.dataset.src ?? '');
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      panel.innerHTML = text;
      localize(panel);
    } catch (e) {
      panel.dataset.loaded = '';
      panel.replaceChildren(errorBox(`Couldn't load: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  // --- Tabs (conversation / code diff) ----------------------------------------------------------
  const tabs = $$('[data-tab]');
  const showTab = (name: string, focus = false) => {
    if (!tabs.length) return;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.dataset.tab ?? '');
      if (panel) panel.hidden = !on;
      if (on && focus) t.focus();
    }
  };
  for (const t of tabs) {
    t.addEventListener('click', (ev) => {
      ev.preventDefault();
      showTab(t.dataset.tab ?? 'conversation');
      history.replaceState(null, '', t.dataset.tab === 'diff' ? '#diff' : location.pathname + location.search);
    });
    t.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const i = tabs.indexOf(t);
      const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      if (next) showTab(next.dataset.tab ?? 'conversation', true);
    });
  }
  // The full record is collapsed under the glance: open whatever holds a linked turn before scrolling to it.
  const openTo = (el: Element | null) => {
    for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) (d as HTMLDetailsElement).open = true;
  };
  const syncHash = () => {
    const h = location.hash.slice(1);
    const el = h ? document.getElementById(h) : null;
    if (el) openTo(el);
    if (tabs.length) {
      if (h === 'diff') {
        openTo(document.getElementById('diff'));
        showTab('diff');
        return;
      }
      if (!el || el.closest('#conversation')) showTab('conversation');
    }
    el?.scrollIntoView();
  };
  window.addEventListener('hashchange', syncHash);
  document.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    const id = a?.getAttribute('href')?.slice(1);
    if (!id || a?.dataset.tab) return;
    const el = document.getElementById(id);
    if (!el) return;
    openTo(el);
    if (tabs.length && el.closest('#conversation')) showTab('conversation');
    // Same-hash clicks fire no hashchange; scroll explicitly once the details are open.
    if (location.hash === `#${id}`) {
      ev.preventDefault();
      el.scrollIntoView();
    }
  });

  // --- Glance (async): swap the rough outline for the Gemini version -----------------------------
  const loadGlance = async () => {
    const glance = document.getElementById('glance');
    if (!glance?.dataset.src) return;
    try {
      const res = await fetch(glance.dataset.src);
      const data = (await res.json()) as { ok?: boolean; glance?: string; files?: string; headline?: string; error?: string };
      if (!res.ok || !data.ok || !data.glance) throw new Error(data.error ?? `HTTP ${res.status}`);
      glance.outerHTML = data.glance;
      const h1 = document.querySelector<HTMLElement>('h1[data-headline]');
      if (h1 && data.headline) {
        h1.textContent = data.headline;
        document.title = `${data.headline} · promptlog`;
      }
      const files = document.getElementById('files');
      if (files && data.files) files.outerHTML = data.files;
      localize(document);
    } catch (e) {
      const prov = glance.querySelector<HTMLElement>('.glance-prov');
      if (prov) prov.textContent = `rough outline from the prompts · Gemini version failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
  };

  // --- PR overview (async): fill the room reserved for it, without moving what the reader is looking at -------
  // A reader who scrolled past the block keeps their place: browsers with scroll anchoring do that themselves;
  // elsewhere, measure the next section before and after the swap and scroll by the difference.
  const keepPlace = (box: HTMLElement, change: () => void) => {
    const next = box.nextElementSibling;
    const manual = !(window.CSS && CSS.supports('overflow-anchor', 'auto')) && box.getBoundingClientRect().bottom <= 0;
    const before = next?.getBoundingClientRect().top ?? 0;
    change();
    if (manual && next) window.scrollBy(0, next.getBoundingClientRect().top - before);
  };
  const loadOverview = async () => {
    const box = document.getElementById('overview');
    if (!box?.dataset.src) return;
    try {
      const res = await fetch(box.dataset.src);
      const data = (await res.json()) as { ok?: boolean; html?: string; error?: string };
      if (!res.ok || !data.ok || !data.html) throw new Error(data.error ?? `HTTP ${res.status}`);
      const tpl = document.createElement('template');
      tpl.innerHTML = data.html;
      const fresh = tpl.content.firstElementChild;
      if (!fresh) throw new Error('empty reply');
      fresh.classList.add('ov-in');
      keepPlace(box, () => box.replaceWith(fresh));
    } catch (e) {
      keepPlace(box, () => {
        box.removeAttribute('aria-busy');
        for (const el of $$('.ov-wait, .ov-legend', box)) el.remove();
        const status = box.querySelector<HTMLElement>('[data-ov-status]');
        if (status) status.textContent = `Couldn't write the overview: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      });
    }
  };

  // --- Summary (async) ----------------------------------------------------------------------------
  const summary = document.getElementById('summary');
  const applyAnnotations = (ann: Record<string, { badges: string; gist?: string }>) => {
    for (const [id, a] of Object.entries(ann)) {
      const slot = document.querySelector<HTMLElement>(`[data-annot="${CSS.escape(id)}"]`);
      if (slot) slot.innerHTML = a.badges;
      const gist = document.querySelector<HTMLElement>(`[data-gist="${CSS.escape(id)}"]`);
      if (gist && a.gist) {
        gist.textContent = a.gist;
        gist.hidden = false;
      }
    }
  };
  const loadSummary = async (refresh: boolean) => {
    if (!summary?.dataset.src) return;
    const started = Date.now();
    const elapsed = summary.querySelector<HTMLElement>('[data-elapsed]');
    const timer = window.setInterval(() => {
      const el = summary.querySelector<HTMLElement>('[data-elapsed]');
      if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)}s so far.`;
    }, 1000);
    if (elapsed) elapsed.textContent = '';
    try {
      const res = await fetch(summary.dataset.src + (refresh ? '&refresh=1' : ''));
      const data = (await res.json()) as { html?: string; annotations?: Record<string, { badges: string; gist?: string }>; error?: string };
      summary.innerHTML = data.html ?? `<div class="panel-error">${res.status}</div>`;
      if (data.annotations) applyAnnotations(data.annotations);
      localize(summary);
      clamp(summary);
    } catch (e) {
      summary.replaceChildren(errorBox(`Couldn't load the summary: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      window.clearInterval(timer);
    }
  };
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const refresh = target.closest('[data-summary-refresh]');
    const run = target.closest('[data-summary-run]');
    if ((!refresh && !run) || !summary) return;
    const what = refresh ? 'Regenerating…' : 'Claude Code is reading the whole conversation and diff…';
    summary.innerHTML = `<div class="sum-head"><h2>Deep review</h2><span class="sum-prov muted">running</span></div><div class="sum-loading" role="status"><div class="spinner" aria-hidden="true"></div><div><strong>${what}</strong><div class="muted small">Uses your Claude plan; about a minute. <span data-elapsed></span></div></div></div>`;
    void loadSummary(!!refresh);
  });

  // --- Ask at this turn -----------------------------------------------------------------------
  document.addEventListener('submit', async (ev) => {
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form[data-ask]');
    if (!form) return;
    ev.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name="question"]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form.querySelector<HTMLElement>('.ask-status');
    const question = input?.value.trim() ?? '';
    if (!question || !input || !button || !status) return;
    input.disabled = true;
    button.disabled = true;
    status.className = 'ask-status pending';
    const started = Date.now();
    const tick = () => (status.textContent = `Claude Code is reopening the repo as it was at this turn (your Claude plan)… ${Math.round((Date.now() - started) / 1000)}s`);
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: form.dataset.session, turn: Number(form.dataset.turn), question }),
      });
      const data = (await res.json()) as { ok?: boolean; html?: string; error?: string };
      if (!res.ok || !data.ok || !data.html) throw new Error(data.error ?? `HTTP ${res.status}`);
      const list = form.parentElement?.querySelector<HTMLElement>('[data-asks]');
      if (list) {
        list.insertAdjacentHTML('beforeend', data.html);
        localize(list);
      }
      input.value = '';
      status.textContent = '';
      status.className = 'ask-status';
    } catch (e) {
      status.className = 'ask-status err';
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      window.clearInterval(timer);
      input.disabled = false;
      button.disabled = false;
    }
  });

  // --- Quick ask (whole page; Jev + Gemini) ----------------------------------------------------
  document.addEventListener('submit', async (ev) => {
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form[data-qask]');
    if (!form) return;
    ev.preventDefault();
    const sec = form.closest('section') ?? form.parentElement;
    const input = form.querySelector<HTMLInputElement>('input[name="question"]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = sec?.querySelector<HTMLElement>('.ask-status');
    const question = input?.value.trim() ?? '';
    if (!question || !input || !button || !status) return;
    input.disabled = true;
    button.disabled = true;
    status.className = 'ask-status pending';
    const started = Date.now();
    const tick = () => (status.textContent = `Finding the relevant turns and answering… ${Math.round((Date.now() - started) / 1000)}s`);
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      const res = await fetch('/api/quick-ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: form.dataset.target, question }),
      });
      const data = (await res.json()) as { ok?: boolean; html?: string; error?: string };
      if (!res.ok || !data.ok || !data.html) throw new Error(data.error ?? `HTTP ${res.status}`);
      const list = sec?.querySelector<HTMLElement>('[data-qasks]');
      if (list) {
        list.insertAdjacentHTML('afterbegin', data.html);
        localize(list);
      }
      input.value = '';
      status.textContent = '';
      status.className = 'ask-status';
    } catch (e) {
      status.className = 'ask-status err';
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      window.clearInterval(timer);
      input.disabled = false;
      button.disabled = false;
    }
  });

  localize(document);
  clamp(document);
  syncHash();
  // The deep review uses the reader's Claude plan, so it only runs on load when a page asks for it explicitly.
  if (summary?.dataset.autoload === '1') void loadSummary(false);
  void loadGlance();
  void loadOverview();
}
