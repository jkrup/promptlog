// "Who's working on what": the agent sessions holding files right now, from the lease table (src/capture/leases.ts
// locally, the LeaseRoom Durable Object on Cloudflare). Pure, so the Worker renders it too.
import type { Lease } from '../capture/lease-table.ts';
import { html, plural, type Safe } from './html.ts';
import { renderPage, time } from './render.ts';

export interface LeasesPageModel {
  repo: string;
  /** Live leases, freshest first. */
  leases: Lease[];
  now: number;
  ttlMin: number;
  /** How another machine's agents join this table; only for people who hold the key. */
  join?: { command: string };
  /** Shown under the title, e.g. "Refreshes every 20 seconds." */
  note?: string;
}

export function ago(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(m)) return '';
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function renderLeasesPage(m: LeasesPageModel): string {
  const bySession = new Map<string, Lease[]>();
  for (const l of m.leases) bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);

  const cards: Safe[] = [...bySession].map(([sid, ls]) => {
    const l = ls[0]!;
    return html`<li class="branch-card lease-card">
<div class="branch-top">
  <a class="branch-name" href="/session/${encodeURIComponent(sid)}">Session <code>${sid.slice(0, 8)}</code></a>
  ${l.branch ? html`<span class="muted small">on <code>${l.branch}</code></span>` : ''}
  <span class="muted small right">active ${ago(l.renewedAt, m.now)}</span>
</div>
${l.ask ? html`<p class="lease-ask">Asked: “${l.ask}”</p>` : ''}
<ul class="branch-sessions lease-files">${ls.map((x) => html`<li><code>${x.path}</code> <span class="small">since ${time(x.since)}</span></li>`)}</ul>
</li>`;
  });

  const list = cards.length
    ? html`<ul class="branch-list">${cards}</ul>`
    : html`<div class="empty-note">No agent is holding a file right now.</div>`;

  const join = m.join
    ? html`<section class="index-sec"><h2>Add agents on another machine</h2>
<p class="muted small">Run this in that machine's clone of the repo. Its agents then share this table: an edit to a file another agent holds is refused, with who holds it and why.</p>
<pre class="lease-join"><code>${m.join.command}</code></pre></section>`
    : '';

  const body = html`<style>
.lease-ask { margin: 8px 0 0; font-size: 14.5px; }
.lease-files { margin-bottom: 0; }
.lease-files li { margin: 2px 0; overflow-wrap: anywhere; }
.lease-join { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
</style>
<section class="hero">
<div class="eyebrow">Who's working on what</div>
<h1>${m.repo}</h1>
<p class="lede">${bySession.size ? `${plural(bySession.size, 'agent session')} holding ${plural(m.leases.length, 'file')}.` : 'All files are free.'} ${m.note ?? ''}</p>
</section>
<section class="index-sec"><h2>Agents holding files</h2>${list}
<p class="muted small">Another agent that tries to edit one of these files is refused and told who holds it. A lease ends when its session ends, or after ${m.ttlMin} minutes without activity.</p>
</section>
${join}`;
  return renderPage({ title: `Who's working on what · ${m.repo}`, crumbs: html`<a href="/">${m.repo}</a><span class="sep">/</span><span>leases</span>`, body });
}
