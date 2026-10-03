// Pure render functions: view model in, HTML string out. No Node APIs and no framework, so this can
// later run on Cloudflare Workers. Every piece of transcript/git text goes through html`` (escaped)
// or renderMarkdown (escape-first); raw() is reserved for markup built in this directory.
import type { AskResult, FileChange, Glance, Leftover, QuickAskInfo, ReviewSummary, Session, SessionSlice, Turn, TurnItem } from '../core/types.ts';
import { clientMain } from './client.ts';
import { counts, diffStats, parseDiff, renderDiff, splitDiffText, statusBadge } from './diff.ts';
import { clip, html, join, plural, qs, raw, toHtml, type Html, type Safe } from './html.ts';
import { inline, plainPreview, renderMarkdown } from './markdown.ts';
import { CSS } from './styles.ts';
import { turnKey, type ExtrasMap, type FeatureState, type Features, type GlanceBlock, type IndexPageModel, type ReviewPageModel, type SessionPageModel, type TurnExtras } from './types.ts';

export { renderDiff } from './diff.ts';
export { renderMarkdown } from './markdown.ts';
export { escapeHtml } from './html.ts';

type ToolItem = Extract<TurnItem, { kind: 'tool' }>;

// ---------------------------------------------------------------------------
// Render context: session labels (A, B, …), path display hints, summary annotations
// ---------------------------------------------------------------------------

export interface SessionLabel {
  letter: string;
  color: number;
}

export interface RenderCtx {
  labels: Map<string, SessionLabel>;
  /** Single-session pages label turns "Turn 3" instead of "A·3". */
  single: boolean;
  features: Features;
  /** Absolute path prefixes (the agent's repo root) to strip when displaying tool paths. */
  pathPrefixes: string[];
  /** Summary-derived badges and one-line gists per turn anchor. */
  annotations?: Map<string, { badges: Safe; gist?: string }>;
}

const SESSION_COLORS = 6;

export function anchorId(sessionId: string, turn: number): string {
  return `t-${sessionId}-${turn}`;
}

function letterFor(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function makeLabels(sessionIds: string[]): Map<string, SessionLabel> {
  const m = new Map<string, SessionLabel>();
  for (const id of sessionIds) if (!m.has(id)) m.set(id, { letter: letterFor(m.size), color: m.size % SESSION_COLORS });
  return m;
}

export function turnLabel(ctx: RenderCtx, sessionId: string, turn: number): string {
  const l = ctx.labels.get(sessionId);
  if (ctx.single || !l) return `Turn ${turn}`;
  return `${l.letter}·${turn}`;
}

/** Link chip to a turn anchor; plain text when the turn isn't on this page. */
export function turnRef(ctx: RenderCtx, sessionId: string | undefined, turn: number | undefined): Safe {
  if (!sessionId || turn === undefined) return html``;
  const l = ctx.labels.get(sessionId);
  if (!l) return html`<span class="tref muted">${sessionId.slice(0, 8)} turn ${turn}</span>`;
  return html`<a class="tref c${l.color}" href="#${anchorId(sessionId, turn)}">${turnLabel(ctx, sessionId, turn)}</a>`;
}

/** Learn the agent's absolute repo root from tool paths that end in a known repo-relative path. */
export function learnPathPrefixes(sessions: Session[], knownPaths: Iterable<string>): string[] {
  const known = [...new Set(knownPaths)].filter(Boolean);
  const prefixes = new Set<string>();
  for (const s of sessions)
    for (const t of s.turns)
      for (const it of t.items) {
        if (it.kind !== 'tool') continue;
        const p = toolPath(it);
        if (!p || !p.startsWith('/')) continue;
        const k = known.find((k) => p.endsWith('/' + k));
        if (k) prefixes.add(p.slice(0, p.length - k.length));
      }
  return [...prefixes].sort((a, b) => b.length - a.length);
}

function displayPath(ctx: RenderCtx, p: string): string {
  for (const pre of ctx.pathPrefixes) if (p.startsWith(pre)) return p.slice(pre.length);
  return p;
}

function stripPrefixes(ctx: RenderCtx, text: string): string {
  let t = text;
  for (const pre of ctx.pathPrefixes) t = t.split(pre).join('');
  return t;
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** Server-side fallback text for a timestamp; the client island rewrites it in the viewer's timezone. */
export function fmtTime(iso: string | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[4]}:${m[5]} UTC`;
}

export function time(iso: string | undefined, cls = ''): Safe {
  if (!iso) return html``;
  return html`<time datetime="${iso}"${cls ? raw(` class="${cls}"`) : ''}>${fmtTime(iso)}</time>`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function turnDuration(t: Turn): string {
  const start = t.meta?.startedAt ?? t.timestamp;
  const end = t.meta?.endedAt;
  if (!start || !end) return '';
  return fmtDuration(Date.parse(end) - Date.parse(start));
}

export function initials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

function shortModel(m: string | undefined): string {
  return (m ?? '').replace(/^claude-/, '');
}

function sessionModels(s: Session): string[] {
  return [...new Set(s.turns.map((t) => t.model ?? t.meta?.model).filter((m): m is string => !!m && m !== '<synthetic>'))];
}

const short = (sha: string) => sha.slice(0, 7);

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export interface PageOpts {
  title: string;
  crumbs?: Html;
  body: Safe;
  /** Show the "show thinking" toggle with this many thinking blocks. */
  thinking?: number;
}

/** The page's only scripts. Exported so the server can allow exactly these via CSP hashes. */
export const HEAD_SCRIPT = "document.documentElement.classList.add('js')";
export const CLIENT_SCRIPT = `(${clientMain.toString()})();`;
export const PAGE_SCRIPTS = [HEAD_SCRIPT, CLIENT_SCRIPT];

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#c2613f"/><rect x="9" y="7" width="5" height="18" rx="1.5" fill="#fff"/><rect x="17" y="11" width="7" height="3" rx="1.5" fill="#fff" opacity=".85"/><rect x="17" y="17" width="5" height="3" rx="1.5" fill="#fff" opacity=".6"/></svg>')}`;

export function renderPage(o: PageOpts): string {
  const thinkingToggle =
    o.thinking && o.thinking > 0
      ? html`<label class="toggle"><input type="checkbox" id="show-thinking"> <span>Show thinking <span class="muted">(${o.thinking})</span></span></label>`
      : '';
  return (
    '<!doctype html>' +
    toHtml(html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${o.title}</title>
<link rel="icon" href="${FAVICON}">
<style>${raw(CSS)}</style>
<script>${raw(HEAD_SCRIPT)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">▍</span>promptlog</a>
    <nav class="crumbs" aria-label="Breadcrumb">${o.crumbs ?? ''}</nav>
    <div class="topbar-right">${thinkingToggle}</div>
  </div>
</header>
<main id="main" class="wrap">
${o.body}
</main>
<script>${raw(CLIENT_SCRIPT)}</script>
</body>
</html>`)
  );
}

export function renderErrorPage(status: number, message: string, detail?: string): string {
  return renderPage({
    title: `${status} · promptlog`,
    body: html`<section class="error-page"><div class="eyebrow">Error ${status}</div><h1>${message}</h1>${detail ? html`<pre class="error-detail">${detail}</pre>` : ''}<p><a href="/">Back to all sessions</a></p></section>`,
  });
}

// ---------------------------------------------------------------------------
// Turn items -> segments
// ---------------------------------------------------------------------------

type Segment =
  | { kind: 'text'; text: string; final: boolean }
  | { kind: 'tools'; tools: ToolItem[] }
  | { kind: 'thinking'; text: string }
  | { kind: 'event'; subtype: string; text: string };

export function segments(items: TurnItem[]): Segment[] {
  const out: Segment[] = [];
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.tools.push(it);
      else out.push({ kind: 'tools', tools: [it] });
    } else if (it.kind === 'text') out.push({ kind: 'text', text: it.text, final: false });
    else if (it.kind === 'thinking') out.push({ kind: 'thinking', text: it.text });
    else out.push({ kind: 'event', subtype: it.subtype, text: it.text });
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const s = out[i]!;
    if (s.kind === 'text') {
      s.final = true;
      break;
    }
  }
  return out;
}

function toolPath(t: ToolItem): string | undefined {
  const inp = (t.input ?? {}) as Record<string, unknown>;
  const p = inp.file_path ?? inp.notebook_path ?? inp.path;
  return typeof p === 'string' ? p : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
}

/** Short "Read server.js" / "Bash git commit" label for the collapsed tool strip. */
export function toolLabel(t: ToolItem): { name: string; arg: string } {
  const inp = (t.input ?? {}) as Record<string, unknown>;
  const name = t.name;
  const p = toolPath(t);
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'NotebookRead':
      return { name, arg: p ? basename(p) : '' };
    case 'Bash': {
      const cmd = str(inp.command).trim();
      if (/\bgit\s+commit\b/.test(cmd)) return { name, arg: 'git commit' };
      const first = (cmd.split('\n')[0] ?? '').replace(/^cd\s+\S+\s*&&\s*/, '');
      return { name, arg: clip(first, 44) };
    }
    case 'Grep':
      return { name, arg: clip(str(inp.pattern), 32) };
    case 'Glob':
      return { name, arg: clip(str(inp.pattern), 32) };
    case 'WebFetch': {
      const m = /^https?:\/\/([^/?#]+)/.exec(str(inp.url));
      return { name, arg: m?.[1] ?? '' };
    }
    case 'WebSearch':
      return { name, arg: clip(str(inp.query), 32) };
    case 'Task':
    case 'Agent':
      return { name, arg: clip(str(inp.description), 36) };
    case 'TodoWrite':
      return { name: 'Todos', arg: Array.isArray(inp.todos) ? plural(inp.todos.length, 'item') : '' };
    case 'Skill':
      return { name, arg: str(inp.skill ?? inp.name) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return { name: `${mcp[1]}: ${mcp[2]}`, arg: '' };
      return { name, arg: p ? basename(p) : '' };
    }
  }
}

function toolStrip(tools: ToolItem[]): Safe {
  const groups: { name: string; arg: string; n: number; err: boolean }[] = [];
  for (const t of tools) {
    const l = toolLabel(t);
    const last = groups[groups.length - 1];
    if (last && last.name === l.name && last.arg === l.arg) {
      last.n++;
      last.err ||= !!t.isError;
    } else groups.push({ ...l, n: 1, err: !!t.isError });
  }
  const MAX = 8;
  const shown = groups.slice(0, MAX);
  const rest = groups.slice(MAX).reduce((n, g) => n + g.n, 0);
  return join(
    [
      ...shown.map(
        (g) => html`<span class="tl${g.err ? ' tl-err' : ''}"><b>${g.name}</b>${g.arg ? html` <span class="targ">${g.arg}</span>` : ''}${g.n > 1 ? html`<span class="times">×${g.n}</span>` : ''}</span>`,
      ),
      rest ? html`<span class="tl muted">+${rest} more</span>` : '',
    ],
    html`<span class="dot" aria-hidden="true">·</span>`,
  );
}

const MAX_RESULT = 20000;

function pre(text: string, cls = ''): Safe {
  const t = text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) : text;
  const more = text.length - t.length;
  return html`<pre class="${cls}">${t}</pre>${more > 0 ? html`<div class="clip-note">… ${more.toLocaleString('en-US')} more characters (see raw log)</div>` : ''}`;
}

function editView(ctx: RenderCtx, oldS: string, newS: string): Safe {
  const del = oldS ? oldS.split('\n').map((l) => html`<div class="del">-${stripPrefixes(ctx, l)}</div>`) : [];
  const add = newS ? newS.split('\n').map((l) => html`<div class="add">+${stripPrefixes(ctx, l)}</div>`) : [];
  return html`<div class="mini-diff">${del}${add}</div>`;
}

function toolInput(ctx: RenderCtx, t: ToolItem): Safe {
  const inp = (t.input ?? {}) as Record<string, unknown>;
  const p = toolPath(t);
  // The path is already in the tool's summary line; only show it here when it differs (not repo-relative).
  const pathRow = p && displayPath(ctx, p) === p && p.startsWith('/') ? html`<div class="tool-path"><code>${p}</code></div>` : '';
  switch (t.name) {
    case 'Bash':
      return html`${inp.description ? html`<div class="tool-caption">${str(inp.description)}</div>` : ''}${pre('$ ' + stripPrefixes(ctx, str(inp.command)), 'cmd')}`;
    case 'Edit':
      return html`${pathRow}${inp.replace_all ? html`<div class="tool-caption">replace all</div>` : ''}${editView(ctx, str(inp.old_string), str(inp.new_string))}`;
    case 'MultiEdit': {
      const edits = Array.isArray(inp.edits) ? (inp.edits as Record<string, unknown>[]) : [];
      return html`${pathRow}${edits.map((e) => editView(ctx, str(e.old_string), str(e.new_string)))}`;
    }
    case 'Write':
      return html`${pathRow}${pre(str(inp.content), 'file')}`;
    case 'Read': {
      const range = inp.offset || inp.limit ? ` (lines ${str(inp.offset ?? 1)}+${inp.limit ? `, limit ${str(inp.limit)}` : ''})` : '';
      return html`${pathRow}<div class="tool-caption">${range ? range.trim() : 'whole file'}</div>`;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(inp.todos) ? (inp.todos as Record<string, unknown>[]) : [];
      return html`<ul class="todos">${todos.map((td) => html`<li class="todo-${str(td.status)}"><span class="todo-box" aria-hidden="true">${td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '◐' : '○'}</span> ${str(td.content)}</li>`)}</ul>`;
    }
    case 'Task':
    case 'Agent':
      return html`<div class="tool-caption">${str(inp.subagent_type)} ${str(inp.description)}</div><div class="md">${renderMarkdown(str(inp.prompt))}</div>`;
    default:
      return pre(stripPrefixes(ctx, JSON.stringify(t.input ?? null, null, 2)), 'json');
  }
}

function toolDetail(ctx: RenderCtx, t: ToolItem): Safe {
  const l = toolLabel(t);
  const p = toolPath(t);
  const target = p ? displayPath(ctx, p) : l.arg;
  const result = t.result === undefined ? html`<div class="clip-note">No result recorded.</div>` : pre(stripPrefixes(ctx, t.result), `result${t.isError ? ' err' : ''}`);
  return html`<li><details class="tool${t.isError ? ' is-err' : ''}">
<summary><span class="tname">${l.name}</span> <span class="targ">${target}</span>${t.isError ? html` <span class="badge b-err">error</span>` : ''}${t.sidechain ? html` <span class="badge b-muted">subagent</span>` : ''}</summary>
<div class="tool-body"><div class="tool-sec">Input</div>${toolInput(ctx, t)}<div class="tool-sec">Result</div>${result}</div>
</details></li>`;
}

function renderSegment(ctx: RenderCtx, seg: Segment): Safe {
  switch (seg.kind) {
    case 'text':
      return html`<div class="reply${seg.final ? ' final' : ''}"><div class="md clamp" data-clamp>${renderMarkdown(seg.text)}</div><button type="button" class="more" hidden aria-expanded="false">Show more</button></div>`;
    case 'tools': {
      const errs = seg.tools.filter((t) => t.isError).length;
      return html`<details class="tools">
<summary><span class="tools-ico" aria-hidden="true">›_</span><span class="strip">${toolStrip(seg.tools)}</span><span class="tools-n">${plural(seg.tools.length, 'call')}${errs ? html`, <span class="minus">${errs} failed</span>` : ''}</span></summary>
<ol class="tool-list">${seg.tools.map((t) => toolDetail(ctx, t))}</ol>
</details>`;
    }
    case 'thinking':
      return html`<details class="thinking"><summary><span class="think-ico" aria-hidden="true">∴</span> Thinking <span class="muted">${plainPreview(seg.text, 90)}</span></summary><div class="md">${renderMarkdown(seg.text)}</div></details>`;
    case 'event': {
      const label: Record<string, string> = {
        interrupt: 'Interrupted',
        compact_summary: 'Compaction summary',
        compact_boundary: 'Conversation compacted',
        command_output: 'Command output',
        injected: 'Injected',
      };
      if (seg.subtype === 'compact_boundary' || seg.subtype === 'interrupt') return html`<div class="event ev-${seg.subtype}">${label[seg.subtype]}</div>`;
      return html`<details class="event ev-${seg.subtype}"><summary>${label[seg.subtype] ?? seg.subtype} <span class="muted">${plainPreview(seg.text, 80)}</span></summary>${pre(seg.text)}</details>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/** Human prompt: escaped plain text, newlines kept, `code` spans highlighted. */
export function renderPrompt(prompt: string): Safe {
  if (!prompt.trim()) return html`<span class="muted">(empty prompt)</span>`;
  const parts = prompt.split(/(`[^`\n]+`)/g);
  return html`${parts.map((p, i) => (i % 2 === 1 ? html`<code>${p.slice(1, -1)}</code>` : p))}`;
}

function fileChip(f: FileChange): Safe {
  return html`<span class="chip file" title="${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}">${statusBadge(f.status)}<span class="fname">${f.path}</span>${counts(f.additions, f.deletions)}</span>`;
}

function humanEditMarker(ctx: RenderCtx, session: Session, t: Turn, edits: FileChange[]): Safe {
  const who = session.meta.author?.name ?? 'The human';
  const add = edits.reduce((n, f) => n + f.additions, 0);
  const del = edits.reduce((n, f) => n + f.deletions, 0);
  const id = `he-${session.meta.sessionId}-${t.index}`;
  const src = `/api/turn-diff${qs({ session: session.meta.sessionId, turn: t.index, span: 'human', format: 'html' })}`;
  return html`<div class="human-edit" role="note">
<div class="he-row"><span class="he-ico" aria-hidden="true">✎</span><span><strong>${who} edited ${plural(edits.length, 'file')}</strong> by hand before ${turnLabel(ctx, session.meta.sessionId, t.index)} ${counts(add, del)}</span>
<button type="button" class="act" data-panel="${id}" data-src="${src}" aria-expanded="false" aria-controls="${id}">View edits</button></div>
<div class="chips">${edits.map(fileChip)}</div>
<div class="panel" id="${id}" hidden></div>
</div>`;
}

export function renderAskResult(a: AskResult): Safe {
  const meta = [a.askedBy, a.costUsd !== undefined ? `$${a.costUsd.toFixed(3)}` : '', a.forkSessionId ? `fork ${a.forkSessionId.slice(0, 8)}` : ''].filter(Boolean);
  return html`<div class="ask-item">
<div class="ask-q"><span class="ask-q-ico" aria-hidden="true">?</span>${a.question}</div>
<div class="ask-a md">${renderMarkdown(a.answer)}</div>
<div class="ask-meta">${time(a.askedAt)}${meta.length ? html` · ${meta.join(' · ')}` : ''}${a.forkSessionId ? html` · <code class="copyable" title="Resume with: claude --resume ${a.forkSessionId}">claude --resume ${a.forkSessionId}</code>` : ''}</div>
</div>`;
}

function askBox(ctx: RenderCtx, sessionId: string, turn: number, asks: AskResult[] | undefined): Safe {
  const label = turnLabel(ctx, sessionId, turn);
  const id = `ask-${sessionId}-${turn}`;
  const past = html`<div class="asks" data-asks>${(asks ?? []).map(renderAskResult)}</div>`;
  if (!ctx.features.ask.available) {
    return html`${past}<div class="ask ask-off"><span class="ask-ico" aria-hidden="true">?</span><span>Deep ask at ${label}</span><span class="muted">· not available yet</span></div>`;
  }
  return html`${past}<form class="ask" data-ask data-session="${sessionId}" data-turn="${turn}" autocomplete="off">
<label class="sr-only" for="${id}">Deep ask at ${label}</label>
<span class="ask-ico" aria-hidden="true">?</span>
<input id="${id}" name="question" type="text" placeholder="Deep ask at ${label}: Claude Code reopens the repo as it was then (your Claude plan, ~1 min)" title="Runs Claude Code on your machine with your Claude plan, in a copy of the repo exactly as it was at ${label}. For most questions, use the quick Ask box at the top." required>
<button type="submit">Deep ask</button>
<div class="ask-status" aria-live="polite"></div>
</form>`;
}

export function renderTurn(ctx: RenderCtx, session: Session, t: Turn, extras: TurnExtras | undefined): Safe {
  const sid = session.meta.sessionId;
  const label = ctx.labels.get(sid);
  const aid = anchorId(sid, t.index);
  const segs = segments(t.items);
  const files = t.meta?.filesChanged ?? [];
  const commits = extras?.commits ?? (t.meta?.commits ?? []).map((sha) => ({ sha, subject: '' }));
  const dur = turnDuration(t);
  const toolCount = t.items.filter((i) => i.kind === 'tool').length;
  const ann = ctx.annotations?.get(aid);
  const hasDiff = !!(t.meta?.stateBefore && t.meta?.stateAfter && t.meta.stateBefore !== t.meta.stateAfter);
  const diffId = `d-${sid}-${t.index}`;
  const rawId = `r-${sid}-${t.index}`;
  const author = session.meta.author?.name;

  const chips: Safe[] = [
    ...files.map(fileChip),
    ...commits.map((c) => html`<span class="chip commit" title="${c.sha}"><span class="commit-ico" aria-hidden="true">●</span><code>${short(c.sha)}</code>${c.subject ? html` <span class="csub">${clip(c.subject, 64)}</span>` : ''}</span>`),
  ];
  if (!files.length && !commits.length && t.meta?.stateAfter) chips.push(html`<span class="chip none">no file changes</span>`);

  return html`${extras?.humanEdits?.length ? humanEditMarker(ctx, session, t, extras.humanEdits) : ''}
<article class="turn c${label?.color ?? 0}" id="${aid}" data-session="${sid}" data-turn="${t.index}">
<header class="turn-head">
  <a class="tlabel" href="#${aid}" title="Link to this turn">${turnLabel(ctx, sid, t.index)}</a>
  <span class="avatar" aria-hidden="true">${initials(t.from ?? author)}</span><span class="who">${t.from ?? author ?? 'Human'}</span>
  ${time(t.timestamp ?? t.meta?.startedAt, 'when')}
  <span class="annot" data-annot="${aid}">${ann?.badges ?? ''}</span>
</header>
${ann?.gist ? html`<div class="gist" data-gist="${aid}">${ann.gist}</div>` : html`<div class="gist" data-gist="${aid}" hidden></div>`}
${t.from ? html`<div class="from-peer">Message from <strong>${t.from}</strong> (another Claude session)</div>` : ''}
<div class="prompt">${renderPrompt(t.prompt)}</div>
<div class="ai">
  <div class="ai-head"><span class="ai-dot" aria-hidden="true"></span><span>Claude</span>${t.model ? html`<span class="muted">${shortModel(t.model)}</span>` : ''}${toolCount ? html`<span class="muted">· ${plural(toolCount, 'tool call')}</span>` : ''}${dur ? html`<span class="muted">· ${dur}</span>` : ''}</div>
  ${segs.length ? segs.map((s) => renderSegment(ctx, s)) : html`<div class="reply muted">(no response recorded)</div>`}
</div>
<footer class="turn-foot">
  ${chips.length ? html`<div class="chips">${chips}</div>` : ''}
  <div class="actions">
    ${hasDiff && files.length ? html`<button type="button" class="act" data-panel="${diffId}" data-src="/api/turn-diff${qs({ session: sid, turn: t.index, format: 'html' })}" aria-expanded="false" aria-controls="${diffId}"><span aria-hidden="true">±</span> View this turn's diff</button>` : ''}
    <button type="button" class="act" data-panel="${rawId}" data-src="/api/turn-raw${qs({ session: sid, turn: t.index, format: 'html' })}" aria-expanded="false" aria-controls="${rawId}"><span aria-hidden="true">{ }</span> Raw log</button>
  </div>
  <div class="panel" id="${diffId}" hidden></div>
  <div class="panel" id="${rawId}" hidden></div>
  ${askBox(ctx, sid, t.index, extras?.asks)}
</footer>
</article>`;
}

function countThinking(sessions: Session[], inRange: (s: Session, t: Turn) => boolean): number {
  let n = 0;
  for (const s of sessions) for (const t of s.turns) if (inRange(s, t)) n += t.items.filter((i) => i.kind === 'thinking').length;
  return n;
}

// ---------------------------------------------------------------------------
// Summary panel
// ---------------------------------------------------------------------------

export interface SummaryUrls {
  api: string;
  mock?: string;
}

export function renderSummaryLoading(urls: SummaryUrls, turns: number): Safe {
  return html`<div class="sum-head"><h2>Summary</h2><span class="sum-prov muted">loading</span></div>
<div class="sum-loading" role="status">
  <div class="spinner" aria-hidden="true"></div>
  <div><strong>Reading ${plural(turns, 'turn')} so you don't have to…</strong><div class="muted small">Intent, pushbacks, open loops and a plan-vs-diff check. First run calls Claude and can take a minute; <span data-elapsed></span></div></div>
</div>
<div class="skeleton" aria-hidden="true"><span style="width:92%"></span><span style="width:78%"></span><span style="width:85%"></span></div>`;
}

/** The deep review doesn't run on page load: it uses the reviewer's Claude plan, so it waits for a click. */
export function renderSummaryIdle(turns: number): Safe {
  return html`<div class="sum-head"><h2>Deep review</h2></div>
<div class="sum-idle">
  <div><strong>Pushbacks, open loops, plan vs diff and risks</strong><div class="muted small">Claude Code reads all ${plural(turns, 'turn')} and the diff. Uses your Claude plan and takes about a minute; cached after the first run.</div></div>
  <button type="button" class="act primary" data-summary-run>Run deep review</button>
</div>`;
}

export function renderSummaryUnavailable(reason: string, urls: SummaryUrls): Safe {
  return html`<div class="sum-head"><h2>Summary</h2></div>
<div class="sum-empty">
  <div class="sum-empty-ico" aria-hidden="true">≡</div>
  <div>
    <strong>Summary not available yet.</strong>
    <p>${reason} The conversation below is the full record: every prompt, reply and tool call, with the code diff one tab over.</p>
    ${urls.mock ? html`<p><a href="${urls.mock}">Preview this panel with mock data →</a></p>` : ''}
  </div>
</div>`;
}

export function renderSummaryError(message: string): Safe {
  return html`<div class="sum-head"><h2>Summary</h2></div>
<div class="sum-empty sum-err">
  <div class="sum-empty-ico" aria-hidden="true">!</div>
  <div><strong>The summary failed to generate.</strong><pre class="error-detail">${clip(message, 2000)}</pre><p><button type="button" class="act" data-summary-refresh>Try again</button></p></div>
</div>`;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
const PVD_ORDER = { missing: 0, partial: 1, unclear: 2, done: 3 } as const;
/** Items shown per summary list before a "show more" expander. */
const SUMMARY_TOP = 3;

/** Summary strings are model output with light markdown (`code`, **bold**). */
const md1 = (s: string | undefined): Safe => raw(inline(s ?? ''));

function topN<T>(items: T[], render: (t: T) => Safe, n = SUMMARY_TOP): Safe {
  const head = items.slice(0, n);
  const rest = items.slice(n);
  return html`<ul class="sum-list">${head.map((t) => html`<li>${render(t)}</li>`)}</ul>${
    rest.length ? html`<details class="sum-more"><summary>Show ${rest.length} more</summary><ul class="sum-list">${rest.map((t) => html`<li>${render(t)}</li>`)}</ul></details>` : ''
  }`;
}

export function renderSummary(ctx: RenderCtx, s: ReviewSummary, opts: { mock?: boolean; hideHref?: string } = {}): Safe {
  const ref = (sid?: string, turn?: number) => turnRef(ctx, sid, turn);
  const risks = [...(s.riskFlags ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const pvd = [...(s.planVsDiff ?? [])].sort((a, b) => (PVD_ORDER[a.status] ?? 9) - (PVD_ORDER[b.status] ?? 9));
  const pvdOpen = pvd.filter((p) => p.status !== 'done');
  const pvdDone = pvd.filter((p) => p.status === 'done');
  const statusLabel: Record<string, string> = { done: 'Done', partial: 'Partial', missing: 'Missing', unclear: 'Unclear' };
  const card = (title: string, n: number, body: Html, cls = '', extra: Html = '') =>
    n ? html`<section class="sum-card ${cls}"><h3>${title} <span class="count">${n}</span>${extra}</h3>${body}</section>` : '';

  const pvdItem = (p: ReviewSummary['planVsDiff'][number]) =>
    html`<span class="pvd-st pvd-${p.status}">${statusLabel[p.status] ?? p.status}</span><div><div>${md1(p.claim)} ${ref(p.sessionId, p.turn)}</div>${p.evidence ? html`<div class="muted small">${md1(p.evidence)}</div>` : ''}</div>`;
  const decisionItem = (d: ReviewSummary['decisions'][number]) =>
    html`<div><div><strong>${md1(d.decision)}</strong> ${ref(d.sessionId, d.turn)}</div>${d.rationale ? html`<div class="muted small">${md1(d.rationale)}</div>` : ''}${
      d.alternatives?.length ? html`<div class="small alts">Rejected: ${join(d.alternatives.map((a) => html`<span class="alt">${md1(a)}</span>`), ', ')}</div>` : ''
    }</div>`;
  const pvdTally = pvd.length
    ? html`<span class="pvd-tally">${(['done', 'partial', 'missing', 'unclear'] as const).map((st) => {
        const n = pvd.filter((p) => p.status === st).length;
        return n ? html`<span class="pvd-st pvd-${st}">${n} ${statusLabel[st]!.toLowerCase()}</span>` : '';
      })}</span>`
    : '';

  const more: Safe[] = [];
  if (s.decisions?.length)
    more.push(html`<details class="sum-fold"><summary>Decisions <span class="count">${s.decisions.length}</span></summary><ul class="sum-list">${s.decisions.map((d) => html`<li>${decisionItem(d)}</li>`)}</ul></details>`);
  if (s.assumptions?.length)
    more.push(html`<details class="sum-fold"><summary>Assumptions <span class="count">${s.assumptions.length}</span></summary><ul class="sum-list bullets">${s.assumptions.map((a) => html`<li><span>${md1(a)}</span></li>`)}</ul></details>`);

  return html`${opts.mock ? html`<div class="mock-banner" role="note"><strong>Mock data.</strong> Layout preview only, not generated from this review.${opts.hideHref ? html` <a href="${opts.hideHref}">Hide</a>` : ''}</div>` : ''}
<div class="sum-head"><h2>Summary</h2><span class="sum-prov muted">${s.model ? `${shortModel(s.model)} · ` : ''}${time(s.generatedAt)}${!opts.mock ? html` · <button type="button" class="linkish" data-summary-refresh>regenerate</button>` : ''}</span></div>
<div class="sum-intent">${md1(s.intent)}</div>
${s.approach ? html`<div class="sum-approach"><div class="clamp" data-clamp><span class="sum-k">Approach</span> ${md1(s.approach)}</div><button type="button" class="more" hidden aria-expanded="false">Show more</button></div>` : ''}
<div class="sum-grid">
${card(
  'Pushbacks',
  s.pushbacks?.length ?? 0,
  topN(s.pushbacks ?? [], (p) => html`${ref(p.sessionId, p.turn)}<div><div class="pb-human">“${md1(p.humanSaid)}”</div><div class="pb-ai"><span class="pb-arrow" aria-hidden="true">↳</span> ${md1(p.aiChanged)}</div></div>`),
  'pushbacks wide',
)}
${card('Risk flags', risks.length, topN(risks, (r) => html`<span class="sev sev-${r.severity}">${r.severity}</span><div>${md1(r.note)} ${ref(r.sessionId, r.turn)}</div>`), 'risk')}
${card('Open loops', s.openLoops?.length ?? 0, topN(s.openLoops ?? [], (o) => html`<span class="loop-ico" aria-hidden="true">○</span><div>${md1(o.item)} ${ref(o.sessionId, o.turn)}</div>`), 'loops')}
${card(
  'Plan vs diff',
  pvd.length,
  html`${pvdOpen.length ? topN(pvdOpen, pvdItem, 4) : html`<div class="muted small">Every claim checked out against the diff.</div>`}${
    pvdDone.length ? html`<details class="sum-more"><summary>${plural(pvdDone.length, 'claim')} verified done</summary><ul class="sum-list">${pvdDone.map((p) => html`<li>${pvdItem(p)}</li>`)}</ul></details>` : ''
  }`,
  'wide',
  pvdTally,
)}
</div>
${more.length ? html`<div class="sum-folds">${more}</div>` : ''}`;
}

/** Badges + gists the summary adds to turn headers, keyed by anchor id. */
export function summaryAnnotations(ctx: RenderCtx, s: ReviewSummary): Map<string, { badges: Safe; gist?: string }> {
  type Kind = 'push' | 'risk' | 'loop' | 'pvd' | 'dec';
  type Entry = { counts: Map<Kind, { n: number; titles: string[]; cls: string }>; gist?: string };
  const acc = new Map<string, Entry>();
  const add = (sid: string | undefined, turn: number | undefined, kind: Kind, title: string, cls: string) => {
    if (!sid || turn === undefined || !ctx.labels.has(sid)) return;
    const id = anchorId(sid, turn);
    const e: Entry = acc.get(id) ?? { counts: new Map() };
    acc.set(id, e);
    const c = e.counts.get(kind) ?? { n: 0, titles: [], cls };
    c.n++;
    c.titles.push(plainPreview(title, 200));
    e.counts.set(kind, c);
  };
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  for (const p of s.pushbacks ?? []) add(p.sessionId, p.turn, 'push', p.humanSaid, 'b-push');
  const risks = [...(s.riskFlags ?? [])].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  // Sorted most severe first, so a turn's risk badge takes the colour of its worst flag.
  for (const r of risks) add(r.sessionId, r.turn, 'risk', r.note, `b-risk-${r.severity}`);
  for (const o of s.openLoops ?? []) add(o.sessionId, o.turn, 'loop', o.item, 'b-loop');
  for (const p of s.planVsDiff ?? []) if (p.status === 'missing' || p.status === 'partial') add(p.sessionId, p.turn, 'pvd', p.claim, 'b-pvd');
  for (const d of s.decisions ?? []) add(d.sessionId, d.turn, 'dec', d.decision, 'b-dec');
  for (const t of s.timeline ?? []) {
    if (!t.sessionId || !ctx.labels.has(t.sessionId)) continue;
    const id = anchorId(t.sessionId, t.turn);
    const e: Entry = acc.get(id) ?? { counts: new Map() };
    e.gist = t.gist;
    acc.set(id, e);
  }
  const label: Record<Kind, [string, string]> = { push: ['Pushback', 'Pushbacks'], risk: ['Risk', 'Risks'], loop: ['Open loop', 'Open loops'], pvd: ['Plan ≠ diff', 'Plan ≠ diff'], dec: ['Decision', 'Decisions'] };
  const order: Kind[] = ['push', 'risk', 'loop', 'pvd', 'dec'];
  const out = new Map<string, { badges: Safe; gist?: string }>();
  for (const [id, e] of acc) {
    const badges = order
      .filter((k) => e.counts.has(k))
      .map((k) => {
        const c = e.counts.get(k)!;
        const [one, many] = label[k];
        return html`<a class="badge ${c.cls}" href="#summary" title="${c.titles.join('\n')}">${c.n > 1 ? `${c.n} ${many}` : one}</a>`;
      });
    out.set(id, { badges: html`${badges}`, gist: e.gist });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// At a glance: one "asked / did" line per turn, then each changed file with why and where
// ---------------------------------------------------------------------------

const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0] || 'Human';
const fileAnchor = (path: string) => `f-${path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const VERDICT_TEXT: Record<string, string> = { yes: 'Yes', no: 'No', partly: 'Partly', unclear: 'Unclear', 'not discussed': 'Not discussed' };

export interface GlanceParts {
  glance: Safe;
  files: Safe;
}

/** The glance and files sections for a page. `sessions` are the sessions the glance's turns come from. */
export function renderGlanceParts(
  ctx: RenderCtx,
  sessions: Session[],
  g: Glance,
  diff: string,
  o: { src?: string; glanceFeature?: FeatureState; headlineInBox?: boolean; leftovers?: Leftover[] } = {},
): GlanceParts {
  const byId = new Map(sessions.map((s) => [s.meta.sessionId, s]));
  const turnOf = (sid: string, n: number) => byId.get(sid)?.turns.find((t) => t.index === n);
  const touched = new Map<string, { sessionId: string; turn: number }[]>();
  for (const t of g.turns) for (const f of turnOf(t.sessionId, t.turn)?.meta?.filesChanged ?? []) touched.set(f.path, [...(touched.get(f.path) ?? []), { sessionId: t.sessionId, turn: t.turn }]);

  const prov =
    g.source === 'gemini'
      ? `written by ${g.model ?? 'Gemini'} from per-turn notes`
      : o.src
        ? 'rough outline from the prompts · Gemini version loading…'
        : `rough outline from the prompts${o.glanceFeature && !o.glanceFeature.available ? ` · ${o.glanceFeature.reason}` : ''}`;

  // Key turns only; terminal commands and small talk fold into one line so the glance stays short.
  const key = g.turns.filter((t) => !t.minor);
  const minor = key.length ? g.turns.filter((t) => t.minor) : [];
  const rows = (key.length ? key : g.turns).map((t) => {
    const aid = anchorId(t.sessionId, t.turn);
    const color = ctx.labels.get(t.sessionId)?.color ?? 0;
    const lbl = turnLabel(ctx, t.sessionId, t.turn);
    const turn = turnOf(t.sessionId, t.turn);
    const nFiles = turn?.meta?.filesChanged?.length ?? 0;
    const commits = turn?.meta?.commits ?? [];
    return html`<li class="gt c${color}"><a class="tlabel" href="#${aid}">${lbl}</a>
<div class="gt-body">
  <div class="gt-line"><span class="gt-who">${firstName(byId.get(t.sessionId)?.meta.author?.name)}</span><span class="gt-text">${md1(t.asked)}</span></div>
  <div class="gt-line"><span class="gt-who gt-ai">Claude</span><span class="gt-text">${md1(t.did)}</span></div>
  ${nFiles || commits.length ? html`<div class="gt-meta">${nFiles ? plural(nFiles, 'file') : ''}${nFiles && commits.length ? ' · ' : ''}${commits.length ? html`committed ${join(commits.map((c) => html`<code>${short(c)}</code>`), ', ')}` : ''}</div>` : ''}
</div></li>`;
  });
  if (minor.length) {
    rows.push(html`<li class="gt gt-fold"><span class="gt-fold-k">Also</span>${join(minor.map((t) => html`<a class="tref" href="#${anchorId(t.sessionId, t.turn)}">${turnLabel(ctx, t.sessionId, t.turn)}</a> <span>${md1(t.asked)}</span>`), html`<span class="dot">·</span>`)}</li>`);
  }

  const beyond = g.beyond ?? [];
  const beyondBlock = beyond.length
    ? html`<div class="beyond" id="beyond">
<h3>Beyond what was asked <span class="count">${beyond.length}</span></h3>
<ul>${beyond.map(
        (b) => html`<li>
<div class="bw-change">${md1(b.change)}${b.paths.length ? html` <span class="bw-where">${b.paths.map((p) => html`<a href="#${fileAnchor(p)}"><code>${displayPath(ctx, p)}</code></a>`)}</span>` : ''}</div>
<div class="bw-reason${b.reason ? '' : ' none'}">${b.reason ? html`<span class="muted">Claude's reason:</span> ${md1(b.reason)}` : b.mentioned ? 'No reason given in the conversation.' : 'Never mentioned in the conversation. Only the diff shows it.'}</div>
</li>`,
      )}</ul>
</div>`
    : '';

  // "Did it change it everywhere?": each name the work took out, and where the code still has it. git grep, no model.
  const left = o.leftovers ?? [];
  const changed = new Set(parseDiff(diff).map((f) => f.newPath));
  const hitPath = (p: string, line: number) => {
    const label = html`<code>${displayPath(ctx, p)}:${line}</code>`;
    return changed.has(p) ? html`<a href="#${fileAnchor(p)}">${label}</a>` : label;
  };
  const everywhereBlock = left.length
    ? html`<div class="everywhere" id="everywhere">
<h3>Did it change it everywhere? <span class="ev-prov">code search, no AI</span></h3>
<ul>${left.map((l) => {
        const untouched = l.stillIn.filter((h) => !h.wrote);
        const written = l.stillIn.filter((h) => h.wrote);
        const missed = untouched.length + l.more;
        const status = missed
          ? `Still in ${plural(missed, 'place')} this change didn't touch:`
          : written.length
            ? `Only left on ${plural(written.length, 'line')} this change wrote:`
            : 'Gone everywhere.';
        const row = (h: Leftover['stillIn'][number]) => html`<li${h.wrote ? html` class="ev-wrote"` : ''}>${hitPath(h.path, h.line)} <code class="ev-text">${h.text}</code>${h.wrote && missed ? html` <span class="ev-tag">written by this change</span>` : ''}</li>`;
        return html`<li class="${missed ? 'ev-left' : 'ev-gone'}">
<div class="ev-name"><code>${l.name}</code> <span class="muted">taken out of ${join(l.removedFrom.map((p) => html`<code>${displayPath(ctx, p)}</code>`), ', ')}</span></div>
<div class="ev-status">${status}</div>
${l.stillIn.length || l.more ? html`<ol class="ev-hits">${untouched.map(row)}${l.more ? html`<li class="more">and ${l.more} more</li>` : ''}${written.map(row)}</ol>` : ''}
</li>`;
      })}</ul>
</div>`
    : '';

  const glance = html`<section class="glance" id="glance" aria-label="At a glance" aria-live="polite"${o.src ? html` data-src="${o.src}"` : ''}>
<div class="glance-head"><h2>At a glance</h2><span class="glance-prov muted">${prov}</span></div>
${g.headline && o.headlineInBox !== false ? html`<p class="glance-headline">${md1(g.headline)}</p>` : ''}
${rows.length ? html`<ol class="glance-turns">${rows}</ol>` : html`<div class="empty-note">No turns.</div>`}
${beyondBlock}
${everywhereBlock}
</section>`;

  const parsed = parseDiff(diff);
  const stats = new Map(parsed.map((f) => [f.newPath, f]));
  const chunks = splitDiffText(diff);
  const st = diffStats(parsed);
  const fileRows = g.files.map((f) => {
    const d = stats.get(f.path);
    const by = touched.get(f.path) ?? [];
    return html`<li><details class="fw" id="${fileAnchor(f.path)}"><summary>
<span class="fw-top">${d ? statusBadge(d.status) : ''}<code class="fw-path">${displayPath(ctx, f.path)}</code>${d ? counts(d.additions, d.deletions) : ''}${by.length ? html`<span class="fw-by">${by.map((b) => turnRef(ctx, b.sessionId, b.turn))}</span>` : ''}<span class="fw-open" aria-hidden="true">diff</span></span>
${f.why ? html`<span class="fw-why">${md1(f.why)}</span>` : ''}
${f.spots.length ? html`<ol class="fw-spots">${f.spots.map((sp) => html`<li class="${sp.kind}"><span class="ln">${sp.kind === 'del' ? '−' : '+'}${sp.line}</span><code>${sp.text}</code></li>`)}${f.moreSpots ? html`<li class="more">and ${plural(f.moreSpots, 'more changed line')}</li>` : ''}</ol>` : ''}
</summary>
<div class="fw-diff">${renderDiff(chunks.get(f.path) ?? '', { emptyText: 'No diff available for this file.' })}</div>
</details></li>`;
  });
  const files = html`<section class="files-why" id="files" aria-label="Files changed">
<div class="glance-head"><h2>Files changed</h2>${parsed.length ? html`<span class="muted small">${plural(st.files, 'file')} ${counts(st.additions, st.deletions)}</span>` : ''}</div>
${fileRows.length ? html`<ul class="fw-list">${fileRows}</ul>` : html`<div class="empty-note">No file changes.</div>`}
</section>`;
  return { glance, files };
}

/**
 * The yes/no chip follows the written answer when it starts with one, with Jev's own answer beside it
 * (agreeing or not); otherwise it shows Jev's answer.
 */
function verdictChip(q: QuickAskInfo | undefined, answer: string): Safe | '' {
  const v = q?.verdict;
  // Older asks predate `lead`; read it off the answer the same way.
  const lead = q?.lead ?? (v ? (/^\W*(yes|no)\b/i.exec(answer)?.[1]?.toLowerCase() as 'yes' | 'no' | undefined) : undefined);
  if (!lead && !v) return '';
  const label = lead ?? v!.label;
  const pct = v ? Math.round(v.confidence * 100) : 0;
  const jev = !v ? '' : !lead ? `Jev, ${pct}% sure` : v.label === lead ? `Jev agrees, ${pct}% sure` : v.label === 'unclear' ? 'Jev unsure' : `Jev leaned ${VERDICT_TEXT[v.label]?.toLowerCase() ?? v.label} (${pct}%)`;
  return html`<div class="qa-verdict v-${label.replace(/\s+/g, '-')}"><strong>${VERDICT_TEXT[label] ?? label}</strong>${jev ? html`<span class="muted"> · ${jev}</span>` : ''}</div>`;
}

/** One quick ask: verdict chip, answer, where it looked. */
export function renderQuickAskResult(a: AskResult): Safe {
  const q = (a as { quick?: QuickAskInfo }).quick;
  const v = q?.verdict;
  const multi = new Set((q?.scores ?? []).map((s) => s.sessionId)).size > 1;
  const lbl = (u: { sessionId: string; turn: number }) => (multi ? `${u.sessionId.slice(0, 8)} turn ${u.turn}` : `turn ${u.turn}`);
  const used = q?.used ?? [];
  const meta: Html[] = [
    time(a.askedAt),
    used.length ? html`from ${join(used.map((u) => html`<a href="#${anchorId(u.sessionId, u.turn)}">${lbl(u)}</a>`), ', ')}` : 'no turn matched',
    q ? `${q.models.jev} + ${q.models.gemini}` : '',
    a.askedBy ?? '',
  ];
  return html`<div class="ask-item qa">
<div class="ask-q"><span class="ask-q-ico" aria-hidden="true">?</span>${a.question}</div>
${verdictChip(q, a.answer)}
<div class="ask-a md">${renderMarkdown(a.answer)}</div>
${q?.codeSearch ? html`<div class="qa-search small">Searched ${q.codeSearch.where} for ${join(q.codeSearch.patterns.map((p) => html`<code>${p.text}</code> <span class="muted">(${p.matches === 1 ? '1 match' : `${p.matches} matches`})</span>`), ', ')}</div>` : ''}
<div class="ask-meta">${join(meta, ' · ')}</div>
</div>`;
}

/** The page-level ask box: quick answers about the whole page (Jev + Gemini), not the user's Claude plan. */
export function renderQuickAsk(block: Pick<GlanceBlock, 'target' | 'asks'>, f: FeatureState | undefined): Safe {
  const past = html`<div class="qasks" data-qasks>${block.asks.map(renderQuickAskResult)}</div>`;
  if (!f?.available) {
    return html`<section class="qask-sec" id="ask" aria-label="Ask about this work"><div class="qask qask-off"><span class="ask-ico" aria-hidden="true">?</span><span>Ask about this work</span><span class="muted">· ${f ? f.reason : 'not set up'}</span></div>${past}</section>`;
  }
  return html`<section class="qask-sec" id="ask" aria-label="Ask about this work">
<form class="qask" data-qask data-target="${block.target}" autocomplete="off">
<label class="sr-only" for="qask-input">Ask about this work</label>
<span class="ask-ico" aria-hidden="true">?</span>
<input id="qask-input" name="question" type="text" placeholder="Ask about this work, e.g. “did it swap every URL?”" required>
<button type="submit">Ask</button>
</form>
<div class="qask-note muted small">Answers in seconds from the turn notes, the relevant turns and, when it helps, a search of the code. Uses Jev + Gemini Flash, not your Claude plan.</div>
<div class="ask-status" aria-live="polite"></div>
${past}
</section>`;
}

/** Collapsed by default: the page leads with the glance; the full record is one click away. */
function fullRecord(title: string, sub: string, body: Safe): Safe {
  return html`<details class="full" id="full"><summary><span class="full-title">${title}</span><span class="muted small">${sub}</span></summary>
<div class="full-body">${body}</div>
</details>`;
}

export function sessionCtx(s: Session, features: Features): RenderCtx {
  const known: string[] = [];
  for (const t of s.turns) for (const f of t.meta?.filesChanged ?? []) known.push(f.path);
  return { labels: makeLabels([s.meta.sessionId]), single: true, features, pathPrefixes: learnPathPrefixes([s], known) };
}

export function reviewCtx(m: Pick<ReviewPageModel, 'review' | 'features'>, diffPaths: string[] = []): RenderCtx {
  const { review } = m;
  const sessions = Object.values(review.sessions);
  const known = [...diffPaths];
  for (const s of sessions) for (const t of s.turns) for (const f of t.meta?.filesChanged ?? []) known.push(f.path);
  return { labels: makeLabels(review.slices.map((s) => s.sessionId)), single: false, features: m.features, pathPrefixes: learnPathPrefixes(sessions, known) };
}

function sliceTurns(review: ReviewPageModel['review'], sl: SessionSlice): Turn[] {
  return review.sessions[sl.sessionId]?.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn) ?? [];
}

export function reviewUrl(base: string, head: string, extra: Record<string, string | undefined> = {}): string {
  return `/review${qs({ base, head, ...extra })}`;
}

export function renderReviewPage(m: ReviewPageModel): string {
  const { review } = m;
  const files = parseDiff(m.diff);
  const ctx = reviewCtx(m, files.map((f) => f.newPath));
  const st = diffStats(files);
  if (m.summary) ctx.annotations = summaryAnnotations(ctx, m.summary.data);
  const slices = review.slices;
  const totalTurns = slices.reduce((n, sl) => n + sliceTurns(review, sl).length, 0);

  // Which turn made each commit (TurnMeta.commits first, then trailers).
  const madeBy = new Map<string, { sessionId: string; turn: number }>();
  for (const sl of slices) for (const t of sliceTurns(review, sl)) for (const c of t.meta?.commits ?? []) if (!madeBy.has(c)) madeBy.set(c, { sessionId: sl.sessionId, turn: t.index });
  for (const c of review.commits) for (const tr of c.trailers) if (!madeBy.has(c.sha) && ctx.labels.has(tr.sessionId)) madeBy.set(c.sha, tr);

  const sessionCard = (sl: SessionSlice) => {
    const s = review.sessions[sl.sessionId]!;
    const l = ctx.labels.get(sl.sessionId)!;
    const models = sessionModels(s);
    const turns = sliceTurns(review, sl);
    const range = sl.fromTurn === sl.toTurn ? `turn ${sl.fromTurn}` : `turns ${sl.fromTurn}–${sl.toTurn}`;
    return html`<a class="scard c${l.color}" href="#slice-${sl.sessionId}">
<span class="sl">${l.letter}</span>
<span class="scard-body"><span class="scard-title">${s.meta.title ?? sl.sessionId.slice(0, 8)}</span>
<span class="scard-meta">${s.meta.author?.name ?? 'unknown author'} · ${s.meta.agent}${s.meta.agentVersion ? ` ${s.meta.agentVersion}` : ''}${models.length ? ` · ${models.map(shortModel).join(', ')}` : ''}</span>
<span class="scard-meta">${range}${s.turns.length > turns.length ? ` of ${s.turns.length}` : ''} · ${time(turns[0]?.timestamp)}</span></span>
</a>`;
  };

  const commitRow = (c: ReviewPageModel['review']['commits'][number]) => {
    const by = madeBy.get(c.sha);
    return html`<li><code class="sha" title="${c.sha}">${short(c.sha)}</code><span class="csub">${c.subject}</span>${by ? turnRef(ctx, by.sessionId, by.turn) : html`<span class="tref muted" title="No captured turn made this commit">by hand</span>`}</li>`;
  };

  const flowText =
    slices.length === 0
      ? 'No captured conversation for this range'
      : slices.length === 1
        ? '1 session → this PR'
        : `${slices.length} sessions → this PR`;

  const hero = html`<section class="hero">
<div class="eyebrow">Review <span class="range"><code>${review.base}</code> <span aria-hidden="true">←</span><span class="sr-only">from</span> <code>${review.head}</code></span></div>
<h1>${review.head}</h1>
<p class="lede"><strong>${flowText}</strong> · ${plural(review.commits.length, 'commit')} · ${plural(totalTurns, 'turn')} · ${plural(st.files, 'file')} ${counts(st.additions, st.deletions)}</p>
<div class="flow">
  <div class="flow-col"><div class="flow-k">${slices.length === 1 ? 'Session' : 'Sessions'}</div>${slices.length ? slices.map(sessionCard) : html`<div class="empty-note">No captured sessions link to these commits.</div>`}</div>
  <div class="flow-arrow" aria-hidden="true"><span>→</span></div>
  <div class="flow-col"><div class="flow-k">Commits <span class="muted">${short(review.mergeBase)}..${review.head}</span></div>${review.commits.length ? html`<ol class="commits">${review.commits.map(commitRow)}</ol>` : html`<div class="empty-note">No commits in range.</div>`}</div>
</div>
</section>`;

  const summaryUrls: SummaryUrls = {
    api: `/api/summary${qs({ base: review.base, head: review.head })}`,
    mock: reviewUrl(review.base, review.head, { mockSummary: '1' }),
  };
  let summaryInner: Safe;
  let summaryAttrs = '';
  if (m.summary) summaryInner = renderSummary(ctx, m.summary.data, { mock: m.summary.mock, hideHref: reviewUrl(review.base, review.head) });
  else if (!m.features.summary.available) summaryInner = renderSummaryUnavailable(m.features.summary.reason, summaryUrls);
  else {
    summaryInner = renderSummaryIdle(totalTurns);
    summaryAttrs = toHtml(html` data-src="${summaryUrls.api}"`);
  }
  const summary = html`<section class="summary" id="summary" aria-label="Summary" aria-live="polite"${raw(summaryAttrs)}>${summaryInner}</section>`;

  const conversation = slices.map((sl, i) => {
    const s = review.sessions[sl.sessionId]!;
    const l = ctx.labels.get(sl.sessionId)!;
    const turns = sliceTurns(review, sl);
    const prev = slices[i - 1];
    return html`<section class="slice c${l.color}" id="slice-${sl.sessionId}" aria-label="Session ${l.letter}">
<header class="slice-head">
  <span class="sl">${l.letter}</span>
  <div><div class="slice-title">${s.meta.title ?? sl.sessionId}</div>
  <div class="slice-meta">${prev ? 'Then a new session · ' : ''}${sl.fromTurn === sl.toTurn ? `turn ${sl.fromTurn}` : `turns ${sl.fromTurn}–${sl.toTurn}`} of ${s.turns.length} · ${s.meta.branch ? html`<code>${s.meta.branch}</code> · ` : ''}<a href="/session/${sl.sessionId}">full session</a></div></div>
</header>
${sl.fromTurn > 1 ? html`<div class="slice-note">Turns 1–${sl.fromTurn - 1} of this session produced commits outside this range. <a href="/session/${sl.sessionId}">See them in the full session</a>.</div>` : ''}
${turns.map((t) => renderTurn(ctx, s, t, m.extras[turnKey(sl.sessionId, t.index)]))}
${sl.toTurn < s.turns.length ? html`<div class="slice-note">The session continues for ${plural(s.turns.length - sl.toTurn, 'more turn')} after this review. <a href="/session/${sl.sessionId}#${anchorId(sl.sessionId, sl.toTurn + 1)}">Continue reading</a>.</div>` : ''}
</section>`;
  });

  const tabs = html`<div class="tabs" role="tablist" aria-label="Review views">
<a class="tab" role="tab" id="tab-conversation" href="#conversation" aria-controls="conversation" aria-selected="true" data-tab="conversation">Conversation <span class="count">${plural(totalTurns, 'turn')}</span></a>
<a class="tab" role="tab" id="tab-diff" href="#diff" aria-controls="diff" aria-selected="false" data-tab="diff">Code diff <span class="count">${plural(st.files, 'file')} ${counts(st.additions, st.deletions)}</span></a>
</div>`;

  const panels = html`${tabs}
<section class="tabpanel" id="conversation" role="tabpanel" aria-labelledby="tab-conversation">${conversation.length ? conversation : html`<div class="empty-note">No conversation slices for this range. Commits here weren't made in a captured session.</div>`}</section>
<section class="tabpanel" id="diff" role="tabpanel" aria-labelledby="tab-diff"><div class="diff-intro muted small"><code>git diff ${short(review.mergeBase)}..${review.head}</code>. The code is the compiled output; the conversation is the source.</div>${renderDiff(m.diff, { emptyText: 'No code changes in this range.', truncated: m.diffTruncated })}</section>`;

  const sessions = Object.values(review.sessions);
  const parts = m.glance ? renderGlanceParts(ctx, sessions, m.glance.glance, m.diff, { src: m.glance.src, glanceFeature: m.features.glance, leftovers: m.glance.leftovers }) : null;
  const full = fullRecord('Full conversation and code diff', `${plural(totalTurns, 'turn')} · every prompt, reply and tool call · deep ask at any turn`, panels);
  const body = parts && m.glance ? html`${hero}${parts.glance}${renderQuickAsk(m.glance, m.features.quick)}${parts.files}${summary}${full}` : html`${hero}${summary}${panels}`;
  return renderPage({
    title: `${review.base}..${review.head} · promptlog`,
    crumbs: html`${m.repoName ? html`<a href="/">${m.repoName}</a><span class="sep">/</span>` : ''}<span>review</span><span class="sep">/</span><code>${review.head}</code>`,
    body,
    thinking: countThinking(sessions, (s, t) => slices.some((sl) => sl.sessionId === s.meta.sessionId && t.index >= sl.fromTurn && t.index <= sl.toTurn)),
  });
}

// ---------------------------------------------------------------------------
// Session page
// ---------------------------------------------------------------------------

export function renderSessionPage(m: SessionPageModel): string {
  const s = m.session;
  const sid = s.meta.sessionId;
  const ctx = sessionCtx(s, m.features);
  const title = m.glance?.glance.headline || s.meta.title || sid;
  const models = sessionModels(s);
  const commits = s.turns.flatMap((t) => (m.extras[turnKey(sid, t.index)]?.commits ?? (t.meta?.commits ?? []).map((sha) => ({ sha, subject: '' }))).map((c) => ({ ...c, turn: t.index })));
  const last = s.turns[s.turns.length - 1];
  const facts: Html[] = [
    s.meta.author ? html`<span>${s.meta.author.name}</span>` : '',
    html`<span>${s.meta.agent}${s.meta.agentVersion ? ` ${s.meta.agentVersion}` : ''}</span>`,
    models.length ? html`<span>${models.map(shortModel).join(', ')}</span>` : '',
    s.meta.branch ? html`<span><code>${s.meta.branch}</code></span>` : '',
    html`<span>${plural(s.turns.length, 'turn')}</span>`,
    html`<span>${time(s.meta.startedAt)}${last?.meta?.endedAt ? html` → ${time(last.meta.endedAt)}` : ''}</span>`,
  ];
  const hero = html`<section class="hero">
<div class="eyebrow">Session <code>${sid}</code></div>
<h1 data-headline>${title}</h1>
<p class="lede facts">${join(facts, html`<span class="dot" aria-hidden="true">·</span>`)}</p>
${s.meta.parent ? html`<p class="slice-note">Forked from <a href="/session/${s.meta.parent.sessionId}#${anchorId(s.meta.parent.sessionId, s.meta.parent.turn)}">${s.meta.parent.sessionId.slice(0, 8)} turn ${s.meta.parent.turn}</a>.</p>` : ''}
${commits.length ? html`<div class="flow-k">Commits made in this session</div><ol class="commits">${commits.map((c) => html`<li><code class="sha" title="${c.sha}">${short(c.sha)}</code><span class="csub">${c.subject}</span>${turnRef(ctx, sid, c.turn)}</li>`)}</ol>` : ''}
</section>`;
  const conversation = html`<section class="slice c0" id="conversation">${s.turns.map((t) => renderTurn(ctx, s, t, m.extras[turnKey(sid, t.index)]))}</section>`;
  // The headline is the page title here, so the glance box doesn't repeat it (the client upgrades the h1).
  const parts = m.glance ? renderGlanceParts(ctx, [s], m.glance.glance, m.diff ?? '', { src: m.glance.src, glanceFeature: m.features.glance, headlineInBox: false, leftovers: m.glance.leftovers }) : null;
  const body = parts && m.glance
    ? html`${hero}${parts.glance}${renderQuickAsk(m.glance, m.features.quick)}${parts.files}${fullRecord('Full conversation', `${plural(s.turns.length, 'turn')} · every prompt, reply and tool call · deep ask at any turn`, conversation)}`
    : html`${hero}${conversation}`;
  return renderPage({
    title: `${title} · promptlog`,
    crumbs: html`${m.repoName ? html`<a href="/">${m.repoName}</a><span class="sep">/</span>` : ''}<span>session</span><span class="sep">/</span><code>${sid.slice(0, 8)}</code>`,
    body,
    thinking: countThinking([s], () => true),
  });
}

// ---------------------------------------------------------------------------
// Index page
// ---------------------------------------------------------------------------

export function renderIndexPage(m: IndexPageModel): string {
  const branches = m.branches.length
    ? html`<ul class="branch-list">${m.branches.map(
        (b) => html`<li class="branch-card">
<div class="branch-top">
  ${b.exists && b.branch !== b.base ? html`<a class="branch-name" href="${reviewUrl(b.base, b.head)}"><code>${b.head}</code></a>` : html`<code class="branch-name">${b.branch}</code>`}
  ${b.exists ? (b.branch === b.base ? html`<span class="badge b-muted">default branch</span>` : html`<span class="muted small">${plural(b.ahead, 'commit')} ahead of <code>${b.base}</code></span>`) : html`<span class="badge b-muted">branch not found locally</span>`}
  ${b.updatedAt ? html`<span class="muted small right">${time(b.updatedAt)}</span>` : ''}
</div>
<ul class="branch-sessions">${b.sessions.map((s) => html`<li><a href="/session/${s.sessionId}">${s.title ?? s.sessionId.slice(0, 8)}</a></li>`)}</ul>
${b.exists && b.branch !== b.base ? html`<a class="act primary" href="${reviewUrl(b.base, b.head)}">Review <code>${b.base}..${b.head}</code> →</a>` : ''}
</li>`,
      )}</ul>`
    : html`<div class="empty-note">No branches with captured sessions yet.</div>`;

  const sessions = m.sessions.length
    ? html`<div class="table-wrap"><table class="sessions">
<thead><tr><th>Session</th><th>Branch</th><th class="num-col">Turns</th><th class="num-col">Commits</th><th>Author</th><th>Updated</th></tr></thead>
<tbody>${m.sessions.map(
        (s) => html`<tr>
<td><a href="/session/${s.sessionId}">${s.title ?? '(untitled)'}</a> <code class="muted small">${s.sessionId.slice(0, 8)}</code></td>
<td>${s.branch ? html`<code>${s.branch}</code>` : html`<span class="muted">-</span>`}</td>
<td class="num-col">${s.turns}</td><td class="num-col">${s.commits}</td>
<td>${s.author ?? ''}</td><td>${time(s.updatedAt)}</td>
</tr>`,
      )}</tbody></table></div>`
    : html`<div class="empty-note">No sessions captured yet. Run <code>promptlog install</code>, then use Claude Code in this repo.</div>`;

  const body = html`<section class="hero">
<div class="eyebrow">Repository</div>
<h1>${m.repoName}</h1>
<p class="lede">${plural(m.sessions.length, 'captured session')} · reviews compare against <code>${m.defaultBranch}</code></p>
</section>
<section class="index-sec"><h2>Branches with conversations</h2>${branches}</section>
<section class="index-sec"><h2>All sessions</h2>${sessions}</section>`;
  return renderPage({ title: `${m.repoName} · promptlog`, crumbs: html`<span>${m.repoName}</span>`, body });
}

// ---------------------------------------------------------------------------
// Fragments served by the API
// ---------------------------------------------------------------------------

/** Raw transcript lines for a turn, pretty-printed one entry at a time. */
export function renderRawLog(lines: string[], rawHref?: string): Safe {
  const entries = lines.map((l, i) => {
    let head = `line ${i + 1}`;
    let body = l;
    try {
      const v = JSON.parse(l) as { type?: string; timestamp?: string; message?: { role?: string } };
      head = [v.type, v.message?.role && v.message.role !== v.type ? v.message.role : '', v.timestamp].filter(Boolean).join(' · ') || head;
      body = JSON.stringify(v, null, 2);
    } catch {
      /* not JSON: show as-is */
    }
    return html`<div class="raw-entry"><div class="raw-head">${head}</div><pre>${body}</pre></div>`;
  });
  return html`<div class="raw-log"><div class="raw-bar muted small">${plural(lines.length, 'transcript entry', 'transcript entries')}${rawHref ? html` · <a href="${rawHref}" target="_blank" rel="noopener">open as .jsonl</a>` : ''}</div>${entries}</div>`;
}

/** Fragment helpers so the server can reuse the page's context for async fragments. */
export function renderSummaryFragment(m: Pick<ReviewPageModel, 'review' | 'features'>, s: ReviewSummary): { html: string; annotations: Record<string, { badges: string; gist?: string }> } {
  const ctx = reviewCtx(m);
  const ann = summaryAnnotations(ctx, s);
  const annotations: Record<string, { badges: string; gist?: string }> = {};
  for (const [k, v] of ann) annotations[k] = { badges: v.badges.__html, gist: v.gist };
  return { html: toHtml(renderSummary(ctx, s)), annotations };
}

export type { ExtrasMap };
