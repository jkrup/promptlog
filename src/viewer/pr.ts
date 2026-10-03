// The PR page: the conversation that built a commit range, turn by turn, with the code each turn wrote under it.
// Pure (model -> HTML). Expanders are <details>, so nothing loads in later and moves the page.
import { counts, statusBadge } from './diff.ts';
import { html, plural, type Safe } from './html.ts';
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
}

const anchor = (sessionId: string, turn: number) => `t-${sessionId.slice(0, 8)}-${turn}`;
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
${didLine(t)}
${nFiles ? html`<div class="pr-files">${t.files.map((f, i) => turnFile(f, nFiles <= 2 && i === 0))}</div>` : ''}
<a class="pr-raw" href="${t.rawHref}">Full turn${t.toolCalls ? ` · ${plural(t.toolCalls, 'tool call')}` : ''}</a>
</article>`;
}

/** A turn with no code in this PR: one line, expandable. */
function quietTurn(t: PrTurn): Safe {
  const first = t.ask.trim().split('\n')[0]!.slice(0, 160);
  return html`<details class="pr-quiet" id="${anchor(t.sessionId, t.turn)}">
<summary><span class="pr-n">turn ${t.turn}</span><span class="pr-q-who">${t.who}</span><span class="pr-q-ask${t.command ? ' cmd' : ''}">${first || '(empty)'}</span></summary>
<div class="pr-quiet-body">${askBlock(t)}${didLine(t)}<a class="pr-raw" href="${t.rawHref}">Full turn</a></div>
</details>`;
}

function sessionBlock(s: PrSession, multi: boolean): Safe {
  return html`<section class="pr-session c${s.color}">
${multi ? html`<h3 class="pr-session-title"><span class="dot" aria-hidden="true"></span>${s.title}${s.author ? html` <span class="muted">· ${s.author}</span>` : ''}</h3>` : ''}
${s.turns.map((t) => (t.files.length || t.fromAgent ? workTurn(t) : quietTurn(t)))}
</section>`;
}

function fileView(f: PrFile): Safe {
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
  return html`<details class="pr-file"><summary>${statusBadge(f.status)}<span class="pr-path">${f.path}</span>${counts(f.additions, f.deletions)}</summary>
<div class="pr-code">${f.hunks.map((h, i) => {
    last = '';
    return html`${i ? html`<div class="pl-gap">⋯</div>` : ''}${rows(h)}`;
  })}</div></details>`;
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
<nav class="pr-tabs"><a href="#conversation">Conversation</a><a href="#files">Files ${m.files.length}</a><a href="${m.oldHref}" class="muted">old page</a></nav>
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
