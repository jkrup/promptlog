// The PR page: what changed and why (the overview), then the conversation that built a commit range, turn by turn,
// with the code each turn wrote under it. Pure (model -> HTML). Expanders are <details>; the only thing that loads
// later is the written overview, into room reserved for it.
import type { Overview, OverviewChange, OverviewQuote } from '../core/types.ts';
import { counts, statusBadge } from './diff.ts';
import { html, join, plural, type Safe } from './html.ts';
import { initials, renderPage, renderPrompt, time } from './render.ts';

export interface PrLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  /** New-side line number (old side for removed lines). */
  no?: number;
}

/** A run of changed lines one turn wrote in one place, with a little context around it. */
export interface PrBlock {
  lines: PrLine[];
}

export interface PrTurnFile {
  path: string;
  additions: number;
  deletions: number;
  blocks: PrBlock[];
}

export interface PrTurn {
  sessionId: string;
  turn: number;
  at?: string;
  /** Who asked: the person's name, or the name of the Claude session that sent the message. */
  who: string;
  fromAgent: boolean;
  ask: string;
  /** A terminal or slash command, not a request. */
  command: boolean;
  /** One line about what Claude did: a cached summary, or the start of its reply (verbatim). */
  did?: { text: string; source: 'summary' | 'reply' };
  files: PrTurnFile[];
  additions: number;
  deletions: number;
  toolCalls: number;
  rawHref: string;
  /** Messages that arrived while Claude was working on this turn (from the person, or from another agent). */
  midTurn?: PrMidTurn[];
}

export interface PrMidTurn {
  text: string;
  who: string;
  fromAgent: boolean;
  at?: string;
}

export interface PrSession {
  sessionId: string;
  title: string;
  author?: string;
  color: number;
  turns: PrTurn[];
}

export interface PrFileLine extends PrLine {
  /** Which turn wrote this changed line; null when no turn did. Absent on context lines. */
  by?: { sessionId: string; turn: number; who: string } | null;
}

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: PrFileLine[][];
}

/** Who asked for the turns that wrote the PR's lines, with how many lines. */
export interface PrDriver {
  who: string;
  kind: 'person' | 'agent';
  lines: number;
}

/** "What changed, and why" at the top of the page. */
export interface PrOverview {
  /** Model-free: credited lines by who asked, most first. */
  drivers: PrDriver[];
  credited: number;
  /** How many changes to reserve room for while the overview is written. */
  expect: number;
  /** The written overview (src/quick/overview.ts), when it exists. */
  data?: Overview;
  /** Where the page fetches the overview from when it isn't written yet. */
  src?: string;
  /** Why there won't be a written overview (e.g. no text-model key). */
  off?: string;
}

export interface PrPageModel {
  title: string;
  base: string;
  head: string;
  commits: { sha: string; subject: string }[];
  coverage: { lines: number; credited: number };
  sessions: PrSession[];
  files: PrFile[];
  repoName: string;
  oldHref: string;
  /** Absent when no turn wrote any of the PR's lines. */
  overview?: PrOverview;
}

const anchor = (sessionId: string, turn: number) => `t-${sessionId.slice(0, 8)}-${turn}`;
const fileAnchor = (i: number) => `file-${i}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function lineRow(l: PrLine): Safe {
  const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  return html`<div class="pl pl-${l.kind}"><span class="pl-no">${l.no ?? ''}</span><span class="pl-sign">${sign}</span><span class="pl-tx">${l.text || ' '}</span></div>`;
}

function turnFile(f: PrTurnFile, open: boolean): Safe {
  return html`<details class="pr-file"${open ? html` open` : ''}>
<summary><span class="pr-path">${f.path}</span>${counts(f.additions, f.deletions)}</summary>
<div class="pr-code">${f.blocks.map((b, i) => html`${i ? html`<div class="pl-gap">⋯</div>` : ''}${b.lines.map(lineRow)}`)}</div>
</details>`;
}

function whoBadge(t: PrTurn): Safe {
  return t.fromAgent
    ? html`<span class="pr-who agent" title="A message from another Claude session">${t.who}</span><span class="pr-tag">agent</span>`
    : html`<span class="pr-who">${t.who}</span>`;
}

function askBlock(t: PrTurn): Safe {
  const text = t.ask.trim();
  const long = text.length > 600 || text.split('\n').length > 10;
  if (!long) return html`<div class="pr-ask">${renderPrompt(text)}</div>`;
  return html`<details class="pr-ask long"><summary><span class="pr-ask-head">${renderPrompt(text.slice(0, 420).trimEnd())}…</span><span class="pr-more">show all</span></summary><div class="pr-ask-full">${renderPrompt(text)}</div></details>`;
}

function didLine(t: PrTurn): Safe {
  if (!t.did) return html``;
  return t.did.source === 'summary'
    ? html`<div class="pr-did"><span class="pr-did-label">Claude</span>${t.did.text} <span class="pr-src" title="Written by a model from this turn">summary</span></div>`
    : html`<div class="pr-did"><span class="pr-did-label">Claude</span><q>${t.did.text}</q></div>`;
}

/** Messages that reached Claude while it worked on this turn, each with who sent it. */
function midTurnBlock(t: PrTurn): Safe {
  return html`${(t.midTurn ?? []).map((m) => {
    const text = m.text.trim();
    const long = text.length > 600 || text.split('\n').length > 10;
    return html`<div class="pr-mid${m.fromAgent ? ' from-agent' : ''}">
<div class="pr-mid-head"><span class="pr-mid-label">Arrived while Claude was working</span>${m.fromAgent ? html`<span class="pr-who agent" title="A message from another Claude session">${m.who}</span><span class="pr-tag">agent</span>` : html`<span class="pr-who">${m.who}</span>`}${time(m.at, 'pr-at')}</div>
${long ? html`<details class="pr-mid-text long"><summary><span class="pr-ask-head">${renderPrompt(text.slice(0, 420).trimEnd())}…</span><span class="pr-more">show all</span></summary><div class="pr-ask-full">${renderPrompt(text)}</div></details>` : html`<div class="pr-mid-text">${renderPrompt(text)}</div>`}
</div>`;
  })}`;
}

/** A turn that wrote code, or a message from another agent: the full card. */
function workTurn(t: PrTurn): Safe {
  const nFiles = t.files.length;
  return html`<article class="pr-turn${t.fromAgent ? ' from-agent' : ''}" id="${anchor(t.sessionId, t.turn)}">
<header class="pr-turn-head">
  <span class="avatar" aria-hidden="true">${initials(t.who)}</span>${whoBadge(t)}
  <a class="pr-n" href="#${anchor(t.sessionId, t.turn)}">turn ${t.turn}</a>${time(t.at, 'pr-at')}
  <span class="grow"></span>
  ${nFiles ? html`<span class="pr-turn-stat">${plural(nFiles, 'file')} ${counts(t.additions, t.deletions)}</span>` : html`<span class="pr-turn-stat muted">no code</span>`}
</header>
${askBlock(t)}
${midTurnBlock(t)}
${didLine(t)}
${nFiles ? html`<div class="pr-files">${t.files.map((f, i) => turnFile(f, nFiles <= 2 && i === 0))}</div>` : ''}
<a class="pr-raw" href="${t.rawHref}">Full turn${t.toolCalls ? ` · ${plural(t.toolCalls, 'tool call')}` : ''}</a>
</article>`;
}

/** A turn with no code in this PR: one line, expandable. */
function quietTurn(t: PrTurn): Safe {
  const first = t.ask.trim().split('\n')[0]!.slice(0, 160);
  return html`<details class="pr-quiet" id="${anchor(t.sessionId, t.turn)}">
<summary><span class="pr-n">turn ${t.turn}</span><span class="pr-q-who">${t.who}</span><span class="pr-q-ask${t.command ? ' cmd' : ''}">${first || '(empty)'}</span>${t.midTurn?.length ? html`<span class="pr-q-mid">+${plural(t.midTurn.length, 'message')} while working</span>` : ''}</summary>
<div class="pr-quiet-body">${askBlock(t)}${midTurnBlock(t)}${didLine(t)}<a class="pr-raw" href="${t.rawHref}">Full turn</a></div>
</details>`;
}

function sessionBlock(s: PrSession, multi: boolean): Safe {
  return html`<section class="pr-session c${s.color}">
${multi ? html`<h3 class="pr-session-title"><span class="dot" aria-hidden="true"></span>${s.title}${s.author ? html` <span class="muted">· ${s.author}</span>` : ''}</h3>` : ''}
${s.turns.map((t) => (t.files.length || t.fromAgent || t.midTurn?.some((m) => m.fromAgent) ? workTurn(t) : quietTurn(t)))}
</section>`;
}

function fileView(f: PrFile, i: number): Safe {
  let last = '';
  const rows = (lines: PrFileLine[]) =>
    lines.map((l) => {
      const key = l.by ? `${l.by.sessionId}#${l.by.turn}` : l.by === null ? 'none' : '';
      const label =
        l.kind !== 'ctx' && key !== last
          ? l.by
            ? html`<a class="pr-by" href="#${anchor(l.by.sessionId, l.by.turn)}">turn ${l.by.turn} · ${l.by.who}</a>`
            : html`<span class="pr-by none">not traced to a turn</span>`
          : '';
      if (l.kind !== 'ctx') last = key;
      return html`${label}${lineRow(l)}`;
    });
  return html`<details class="pr-file" id="${fileAnchor(i)}"><summary>${statusBadge(f.status)}<span class="pr-path">${f.path}</span>${counts(f.additions, f.deletions)}</summary>
<div class="pr-code">${f.hunks.map((h, i) => {
    last = '';
    return html`${i ? html`<div class="pl-gap">⋯</div>` : ''}${rows(h)}`;
  })}</div></details>`;
}

// ---------------------------------------------------------------------------
// What changed, and why
// ---------------------------------------------------------------------------

/** Who drove the code, in numbers: the share of traced lines written in answer to each person or agent. */
function drivers(o: PrOverview): Safe {
  const total = sum(o.drivers.map((d) => d.lines)) || 1;
  const shown = o.drivers.filter((d) => d.lines / total >= 0.01);
  const rest = o.drivers.length - shown.length;
  const one = (d: PrDriver) =>
    html`<b>${Math.round((100 * d.lines) / total)}%</b> answering <span class="ov-name k-${d.kind}"${d.kind === 'agent' ? html` title="Another Claude session"` : ''}>${d.who}</span>`;
  return html`<p class="ov-drove">Who drove the code: ${join(shown.map(one), ', ')}${rest ? ` and ${plural(rest, 'other')}` : ''}<span class="muted"> · of ${o.credited.toLocaleString('en-US')} lines traced to a turn</span></p>`;
}

/** Words from the conversation, verbatim, with who said them. Markdown marks are dropped for reading. */
function quoteView(q: OverviewQuote, lead?: Safe): Safe {
  return html`<blockquote class="ov-q k-${q.kind}">${lead ?? ''}<span class="ov-who">${q.who}</span>${q.kind === 'agent' ? html`<span class="ov-role"> (another Claude session)</span>` : ''} <q>${q.quote.replace(/\*\*|`/g, '')}</q> <a class="ov-turn" href="#${anchor(q.sessionId, q.turn)}">turn ${q.turn}</a></blockquote>`;
}

function changeView(m: PrPageModel, c: OverviewChange): Safe {
  const turns = m.sessions.flatMap((s) => s.turns);
  const turnOf = (sessionId: string, n: number) => turns.find((t) => t.sessionId === sessionId && t.turn === n);
  const color = (sessionId: string) => m.sessions.find((s) => s.sessionId === sessionId)?.color ?? 0;
  const chips = c.turns.map((t) => html`<a class="ov-chip t c${color(t.sessionId)}" href="#${anchor(t.sessionId, t.turn)}" title="${turnOf(t.sessionId, t.turn)?.who ?? ''}">turn ${t.turn}</a>`);
  // Files by how much of this change is in them; a name shared by two files gets its folder.
  const base = (p: string) => p.split('/').pop()!;
  const name = (p: string) => (c.files.filter((q) => base(q) === base(p)).length > 1 ? p.split('/').slice(-2).join('/') : base(p));
  const files = c.files
    .map((path) => {
      // Lines this change's turns wrote in the file.
      const mine = c.turns.flatMap((t) => turnOf(t.sessionId, t.turn)?.files.filter((f) => f.path === path) ?? []);
      return { path, add: sum(mine.map((f) => f.additions)), del: sum(mine.map((f) => f.deletions)) };
    })
    .sort((x, y) => y.add + y.del - (x.add + x.del))
    .map(
      (f) =>
        html`<a class="ov-chip f" href="#${fileAnchor(m.files.findIndex((x) => x.path === f.path))}" title="${f.path}">${name(f.path)}${f.add ? html` <span class="plus">+${f.add}</span>` : ''}${f.del ? html` <span class="minus">−${f.del}</span>` : ''}</a>`,
    );
  const shown = 4;
  const tried = c.tried ? quoteView(c.tried, html`<span class="ov-res ${c.tried.result}">${c.tried.result === 'worked' ? 'Tried for real: worked' : 'Tried for real: failed'}</span> `) : '';
  return html`<article class="ov-chg">
<div class="ov-model"><h3>${c.title}</h3><p class="ov-what">${c.what}</p></div>
${c.why ? quoteView(c.why) : html`<p class="ov-noq">No words in the recorded conversation ask for this.</p>`}${c.alsoWhy.map((q) => quoteView(q))}${tried}
<div class="ov-links">${chips}${files.slice(0, shown)}${files.length > shown ? html`<details class="ov-more"><summary>${plural(files.length - shown, 'more file')}</summary><div class="ov-links">${files.slice(shown)}</div></details>` : ''}</div>
</article>`;
}

/**
 * The overview section. Written: a one-sentence summary and the changes. Not written yet: the same frame with room
 * reserved for the changes, which the page fills in place from `src`. The facts above the changes need no model.
 */
export function renderOverview(m: PrPageModel): Safe {
  const o = m.overview;
  if (!o) return html``;
  const d = o.data;
  const legend = html`<p class="ov-legend"><span><span class="ov-key"></span>summary written by a model from the conversation</span><span><span class="ov-key solid"></span>quoted word for word, with who said it</span></p>`;
  if (d) {
    return html`<section id="overview" class="ov">
<h2>What changed, and why</h2>
${d.summary ? html`<p class="ov-sum ov-model">${d.summary}</p>` : ''}
${drivers(o)}
${legend}
<div class="ov-list">${d.changes.map((c) => changeView(m, c))}</div>
</section>`;
  }
  const wait = !!o.src;
  return html`<section id="overview" class="ov"${wait ? html` data-src="${o.src}" aria-busy="true"` : ''}>
<h2>What changed, and why</h2>
<p class="ov-status" role="status" data-ov-status>${wait ? 'Writing the overview from the conversation. The first time takes about half a minute.' : `No written overview here: ${o.off ?? 'no text model is set up'}.`}</p>
${drivers(o)}
${wait ? html`${legend}<div class="ov-list ov-wait" aria-hidden="true">${Array.from({ length: o.expect }, () => html`<div class="ov-skel"><i></i><i></i><i></i><i></i></div>`)}</div>` : ''}
</section>`;
}

export function renderPrPage(m: PrPageModel): string {
  const allTurns = m.sessions.flatMap((s) => s.turns);
  const work = allTurns.filter((t) => t.files.length);
  const agents = allTurns.filter((t) => t.fromAgent);
  const pct = m.coverage.lines ? Math.round((100 * m.coverage.credited) / m.coverage.lines) : 100;
  const adds = sum(m.files.map((f) => f.additions));
  const dels = sum(m.files.map((f) => f.deletions));
  const body = html`<div class="pr">
<header class="pr-head">
  <div class="pr-range"><code>${m.base}</code> ← <code>${m.head}</code></div>
  <h1>${m.title}</h1>
  <p class="pr-meta">${plural(m.commits.length, 'commit')} · ${plural(m.files.length, 'file')} ${counts(adds, dels)} · ${plural(work.length, 'turn')} wrote code${agents.length ? html` · ${plural(agents.length, 'message')} from other agents` : ''}</p>
  <p class="pr-cover">${m.coverage.credited.toLocaleString('en-US')} of ${m.coverage.lines.toLocaleString('en-US')} changed lines traced to the turn that wrote them (${pct}%).</p>
</header>
<nav class="pr-tabs">${m.overview ? html`<a href="#overview">Overview</a>` : ''}<a href="#conversation">Conversation</a><a href="#files">Files ${m.files.length}</a><a href="${m.oldHref}" class="muted">old page</a></nav>
${renderOverview(m)}
<section id="conversation" class="pr-conv">
${m.sessions.length ? m.sessions.map((s) => sessionBlock(s, m.sessions.length > 1)) : html`<p class="muted">No recorded conversation wrote this code.</p>`}
</section>
<section id="files" class="pr-filesec">
<h2>Files</h2>
${m.files.map(fileView)}
</section>
<details class="pr-commits"><summary>${plural(m.commits.length, 'commit')}</summary><ul>${m.commits.map((c) => html`<li><code>${c.sha.slice(0, 7)}</code> ${c.subject}</li>`)}</ul></details>
</div>`;
  return renderPage({ title: `${m.title} · ${m.repoName}`, crumbs: html`<span>${m.repoName}</span> / <span>${m.head}</span>`, body });
}
