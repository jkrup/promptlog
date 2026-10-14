// "Who's working on what": the agent sessions holding code right now, from the lease table (src/capture/leases.ts
// locally, the LeaseRoom Durable Object on Cloudflare), and Clef's recent verdicts on agents working side by side.
// Pure, so the Worker renders it too.
import { describeBlock } from '../capture/blocks.ts';
import { describeDecision, type Decision, type Lease } from '../capture/lease-table.ts';
import { html, plural, type Safe } from './html.ts';
import { renderPage, time } from './render.ts';

export interface LeasesPageModel {
  repo: string;
  /** Live leases, freshest first. */
  leases: Lease[];
  /** Clef's recent verdicts, newest first. */
  decisions?: Decision[];
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

/** One line per file: the whole file, or the blocks held in it. */
function fileLines(ls: Lease[]): Safe[] {
  const byPath = new Map<string, Lease[]>();
  for (const l of ls) byPath.set(l.path, [...(byPath.get(l.path) ?? []), l]);
  return [...byPath].map(([path, held]) => {
    const since = held.map((l) => l.since).sort()[0];
    const blocks = held.filter((l) => l.block).sort((a, b) => a.block!.start - b.block!.start);
    const what = blocks.length === held.length ? html`: ${blocks.map((l, i) => html`${i ? ', ' : ''}<code>${describeBlock(l.block!)}</code>`)}` : html` <span class="small">(whole file)</span>`;
    return html`<li><code>${path}</code>${what} <span class="small">since ${time(since)}</span></li>`;
  });
}

export function renderLeasesPage(m: LeasesPageModel): string {
  const bySession = new Map<string, Lease[]>();
  for (const l of m.leases) bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);
  const files = new Set(m.leases.map((l) => l.path)).size;

  const cards: Safe[] = [...bySession].map(([sid, ls]) => {
    const l = ls[0]!;
    return html`<li class="branch-card lease-card">
<div class="branch-top">
  <a class="branch-name" href="/session/${encodeURIComponent(sid)}">Session <code>${sid.slice(0, 8)}</code></a>
  ${l.branch ? html`<span class="muted small">on <code>${l.branch}</code></span>` : ''}
  <span class="muted small right">active ${ago(l.renewedAt, m.now)}</span>
</div>
${l.ask ? html`<p class="lease-ask">Asked: “${l.ask}”</p>` : ''}
<ul class="branch-sessions lease-files">${fileLines(ls)}</ul>
</li>`;
  });

  const list = cards.length
    ? html`<ul class="branch-list">${cards}</ul>`
    : html`<div class="empty-note">No agent is holding a file right now.</div>`;

  const decisions = m.decisions?.length
    ? html`<section class="index-sec"><h2>Decisions</h2>
<p class="muted small">When two agents want to work right next to each other in a file (or one wants a block another left quiet), Clef is asked whether the two changes are independent. Only a clear yes lets the second agent go ahead.</p>
<ul class="lease-decisions">${m.decisions.map(
        (d) => html`<li class="${d.outcome}"><div>${describeDecision(d)}</div>
<div class="muted small"><code>${d.path}</code> · ${ago(d.at, m.now)} · session <code>${d.holder.sessionId.slice(0, 8)}</code>${d.holder.ask ? ` (“${d.holder.ask}”)` : ''} was working there; session <code>${d.asker.sessionId.slice(0, 8)}</code>${d.asker.ask ? ` (“${d.asker.ask}”)` : ''} asked.</div></li>`,
      )}</ul></section>`
    : '';

  const join = m.join
    ? html`<section class="index-sec"><h2>Add agents on another machine</h2>
<p class="muted small">Run this in that machine's clone of the repo. Its agents then share this table: an edit to code another agent holds is refused, with who holds it and why.</p>
<pre class="lease-join"><code>${m.join.command}</code></pre></section>`
    : '';

  const body = html`<style>
.lease-ask { margin: 8px 0 0; font-size: 14.5px; }
.lease-files { margin-bottom: 0; }
.lease-files li { margin: 2px 0; overflow-wrap: anywhere; }
.lease-decisions { list-style: none; padding: 0; margin: 0; }
.lease-decisions li { border-left: 3px solid var(--border); padding: 6px 0 6px 12px; margin: 8px 0; overflow-wrap: anywhere; }
.lease-decisions li.allowed { border-left-color: var(--ok); }
.lease-decisions li.refused { border-left-color: var(--warn); }
.lease-join { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
</style>
<section class="hero">
<div class="eyebrow">Who's working on what</div>
<h1>${m.repo}</h1>
<p class="lede">${bySession.size ? `${plural(bySession.size, 'agent session')} working in ${plural(files, 'file')}.` : 'All files are free.'} ${m.note ?? ''}</p>
</section>
<section class="index-sec"><h2>Agents at work</h2>${list}
<p class="muted small">Agents can work on different functions of the same file at once. Another agent that tries to edit a function (or a whole file) someone holds is refused and told who holds it. A lease ends when its session ends, or after ${m.ttlMin} minutes without activity.</p>
</section>
${decisions}
${join}`;
  return renderPage({ title: `Who's working on what · ${m.repo}`, crumbs: html`<a href="/">${m.repo}</a><span class="sep">/</span><span>leases</span>`, body });
}
