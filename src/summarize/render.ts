// Compact, budgeted rendering of a Review for the summarizer model.
//
// Pure: takes a Review plus a GitContext (diffs, commit bodies; see ./gitctx.ts) and returns text. Detail is
// shed in a fixed order (thinking, tool results, per-turn diffs, tool one-liners, the final diff, assistant text)
// until the text fits the budget. Human prompts go last, so long sessions keep what the human said and where
// they pushed back.
import type { FileChange, Review, Session, SessionSlice, Turn, TurnItem } from '../core/types.ts';

/** Bump when the rendering changes in a way that should invalidate cached summaries. */
export const RENDER_VERSION = 1;

export interface RenderBudget {
  /** Ceiling for the whole rendered material, in estimated tokens. */
  totalTokens: number;
  /** Ceiling for the final base..head diff at full detail. */
  finalDiffTokens: number;
  /** Ceiling for all per-turn diffs together, and for a single turn's diff. */
  turnDiffTokens: number;
  turnDiffTokensEach: number;
}

export const DEFAULT_BUDGET: RenderBudget = {
  totalTokens: 60_000,
  finalDiffTokens: 20_000,
  turnDiffTokens: 12_000,
  turnDiffTokensEach: 3_000,
};

export interface GitContext {
  /** `git diff <mergeBase> <head>` patch. */
  finalDiff: string;
  /** Files changed base..head. */
  finalFiles: FileChange[];
  /** `${sessionId}#${turn}` -> `git diff <stateBefore> <stateAfter>` patch. */
  turnDiffs: Record<string, string>;
  /** `${sessionId}#${turn}` -> changes between the previous turn's end and this turn's start (not by the agent). */
  betweenTurns: Record<string, { files: FileChange[]; patch: string }>;
  /** Full commit message body (without subject and trailers) per sha. */
  commitBodies: Record<string, string>;
  /** Absolute checkout-root prefixes (with trailing '/') to strip from paths in tool calls. */
  rootPrefixes: string[];
}

export const emptyGitContext = (): GitContext => ({ finalDiff: '', finalFiles: [], turnDiffs: {}, betweenTurns: {}, commitBodies: {}, rootPrefixes: [] });

// ---------------------------------------------------------------------------
// Small text helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Rough token estimate. Code and diffs run ~3.5 chars/token; being pessimistic keeps us under real limits. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5);
const tokensToChars = (t: number): number => Math.floor(t * 3.5);

/** Clip to at most `max` chars keeping head and tail (tails carry test summaries and error messages). */
export function clipMiddle(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const marker = (n: number) => `\n… [${n} chars omitted] …\n`;
  const room = Math.max(0, max - marker(s.length).length);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return s.slice(0, head) + marker(s.length - head - tail) + (tail > 0 ? s.slice(s.length - tail) : '');
}

export function clipEnd(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

const oneLine = (s: string, max: number) => clipEnd(s.replace(/\s*\n\s*/g, ' ⏎ ').trim(), max);
const indent = (s: string, pad: string) => s.replace(/^/gm, pad);

/** Session labels used in the rendering and the model's output: A, B, …, Z, AA, AB, … in slice order. */
export function sessionLabels(review: Pick<Review, 'slices'>): Map<string, string> {
  const labels = new Map<string, string>();
  const name = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : name(Math.floor(i / 26) - 1) + name(i % 26));
  for (const sl of review.slices) if (!labels.has(sl.sessionId)) labels.set(sl.sessionId, name(labels.size));
  return labels;
}

// ---------------------------------------------------------------------------
// Diff truncation
// ---------------------------------------------------------------------------

const GENERATED_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap)$|(^|\/)(dist|build|vendor)\//;

interface FileChunk {
  path: string;
  text: string;
}

export function splitDiff(patch: string): FileChunk[] {
  if (!patch.trim()) return [];
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.trim());
  return parts.map((text) => {
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(text);
    return { path: m?.[2] ?? '?', text: text.endsWith('\n') ? text : text + '\n' };
  });
}

function truncateChunk(c: FileChunk, maxChars: number): string {
  if (c.text.length <= maxChars) return c.text;
  const lines = c.text.split('\n');
  const out: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    // Always keep the file header, even when over budget.
    const isHeader = i < 6 && !l.startsWith('@@') && !out.some((x) => x.startsWith('@@'));
    if (!isHeader && used + l.length + 1 > maxChars) break;
    out.push(l);
    used += l.length + 1;
  }
  const rest = lines.slice(i).filter((l) => l.length > 0).length;
  if (rest > 0) out.push(`… [${rest} more diff lines in ${c.path} omitted]`);
  return out.join('\n') + '\n';
}

/**
 * Fit a multi-file patch into `maxTokens`. Lockfiles and generated files collapse to their header.
 * Remaining budget is shared fairly: small files stay whole, big files are cut at line boundaries.
 * `maxTokens <= 0` returns ''. `skipPaths` maps path -> note for files rendered elsewhere.
 */
export function truncateDiff(patch: string, maxTokens: number, skipPaths: Map<string, string> = new Map()): string {
  if (maxTokens <= 0) return '';
  const chunks = splitDiff(patch).map((c) => {
    const note = skipPaths.get(c.path);
    if (note) return { ...c, text: c.text.split('\n').slice(0, 1).join('\n') + `\n[${note}]\n` };
    if (GENERATED_RE.test(c.path)) {
      const n = c.text.split('\n').length;
      return { ...c, text: c.text.split('\n').slice(0, 1).join('\n') + `\n[generated or lock file: ${n} diff lines omitted]\n` };
    }
    return c;
  });
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  let budget = tokensToChars(maxTokens);
  if (total <= budget) return chunks.map((c) => c.text).join('');
  // Water-fill: visit small chunks first so they keep their full text and leave the rest to big ones.
  const order = chunks.map((c, i) => ({ c, i })).sort((a, b) => a.c.text.length - b.c.text.length);
  const out: string[] = new Array(chunks.length);
  let remaining = chunks.length;
  for (const { c, i } of order) {
    const share = Math.floor(budget / remaining);
    const text = truncateChunk(c, Math.max(share, 200));
    out[i] = text;
    budget -= text.length;
    remaining--;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Detail ladder
// ---------------------------------------------------------------------------

export interface Detail {
  /** Max chars of assistant thinking (0 drops it). */
  thinking: number;
  /** Max chars for non-error tool results (0 drops them); Read results use a fraction of this. */
  toolResult: number;
  /** Max chars for error results. */
  toolError: number;
  /** Replace tool one-liners with one grouped line per run of consecutive calls. */
  collapseTools: boolean;
  /** Max chars for assistant text that isn't the turn's final reply. */
  midText: number;
  /** Max chars for the final reply of each turn. */
  finalText: number;
  /** Max chars for the reply right before a human prompt that looks like a pushback. */
  protectedText: number;
  /** Max chars per human prompt. */
  prompt: number;
  turnDiffs: boolean;
  /** Token ceiling for the final diff, as a fraction of budget.finalDiffTokens (0 = file list only). */
  finalDiffShare: number;
  commitBodyLines: number;
}

const INF = Number.MAX_SAFE_INTEGER;

export const LADDER: Detail[] = [
  { thinking: 600, toolResult: 500, toolError: 800, collapseTools: false, midText: INF, finalText: INF, protectedText: INF, prompt: INF, turnDiffs: true, finalDiffShare: 1, commitBodyLines: 20 },
  { thinking: 0, toolResult: 200, toolError: 500, collapseTools: false, midText: INF, finalText: INF, protectedText: INF, prompt: INF, turnDiffs: true, finalDiffShare: 1, commitBodyLines: 20 },
  { thinking: 0, toolResult: 0, toolError: 300, collapseTools: false, midText: 2000, finalText: INF, protectedText: INF, prompt: INF, turnDiffs: false, finalDiffShare: 1, commitBodyLines: 12 },
  { thinking: 0, toolResult: 0, toolError: 200, collapseTools: true, midText: 600, finalText: 3000, protectedText: INF, prompt: INF, turnDiffs: false, finalDiffShare: 0.6, commitBodyLines: 8 },
  { thinking: 0, toolResult: 0, toolError: 120, collapseTools: true, midText: 200, finalText: 1200, protectedText: 3000, prompt: INF, turnDiffs: false, finalDiffShare: 0.3, commitBodyLines: 4 },
  { thinking: 0, toolResult: 0, toolError: 0, collapseTools: true, midText: 0, finalText: 600, protectedText: 1500, prompt: 4000, turnDiffs: false, finalDiffShare: 0.15, commitBodyLines: 2 },
  { thinking: 0, toolResult: 0, toolError: 0, collapseTools: true, midText: 0, finalText: 250, protectedText: 600, prompt: 1500, turnDiffs: false, finalDiffShare: 0, commitBodyLines: 0 },
  { thinking: 0, toolResult: 0, toolError: 0, collapseTools: true, midText: 0, finalText: 120, protectedText: 300, prompt: 600, turnDiffs: false, finalDiffShare: 0, commitBodyLines: 0 },
];

/** Human prompts that correct or redirect the agent. Used to keep the reply they react to at full length. */
const PUSHBACK_RE = /\b(no|nope|don'?t|do not|instead|wrong|actually|hmm+|why did|why not|revert|undo|not what|shouldn'?t|should not|stop|wait|but)\b/i;
export const looksLikePushback = (prompt: string): boolean => PUSHBACK_RE.test(prompt);

// ---------------------------------------------------------------------------
// Tool one-liners
// ---------------------------------------------------------------------------

type ToolItem = Extract<TurnItem, { kind: 'tool' }>;

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}

/** One line (or a short block for plans) describing a tool call, without its result. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = str(i, 'file_path') ?? str(i, 'notebook_path') ?? str(i, 'path') ?? '';
  switch (name) {
    case 'Read':
      return `Read ${path}${typeof i.offset === 'number' ? ` (from line ${i.offset})` : ''}`;
    case 'Write':
      return `Write ${path} (${(str(i, 'content') ?? '').replace(/\n$/, '').split('\n').length} lines)`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name} ${path}${i.replace_all ? ' (replace all)' : ''}`;
    case 'Bash':
      return `Bash: ${oneLine(str(i, 'command') ?? '', 240)}`;
    case 'Glob':
      return `Glob ${str(i, 'pattern') ?? ''}${path ? ` in ${path}` : ''}`;
    case 'Grep':
      return `Grep "${oneLine(str(i, 'pattern') ?? '', 80)}"${path ? ` in ${path}` : ''}${str(i, 'glob') ? ` (${str(i, 'glob')})` : ''}`;
    case 'WebFetch':
      return `WebFetch ${str(i, 'url') ?? ''}`;
    case 'WebSearch':
      return `WebSearch "${oneLine(str(i, 'query') ?? '', 120)}"`;
    case 'Task':
    case 'Agent':
      return `${name}(${str(i, 'subagent_type') ?? 'subagent'}): ${oneLine(str(i, 'description') ?? '', 100)} :: ${oneLine(str(i, 'prompt') ?? '', 300)}`;
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as { content?: string; status?: string }[]) : [];
      const mark = (s?: string) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
      return `TodoWrite: ${clipEnd(todos.map((t) => `${mark(t.status)} ${t.content ?? ''}`).join(' · '), 400)}`;
    }
    case 'ExitPlanMode':
      return `ExitPlanMode (proposed plan):\n${indent(clipMiddle(str(i, 'plan') ?? '', 4000), '    ')}`;
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as { question?: string }[]) : [];
      return `AskUserQuestion: ${oneLine(qs.map((q) => q.question ?? '').join(' | '), 300)}`;
    }
    default:
      return `${name} ${oneLine(JSON.stringify(input ?? {}), 160)}`;
  }
}

function resultBudget(t: ToolItem, d: Detail): number {
  if (t.isError) return d.toolError;
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode'].includes(t.name)) return 0; // success notices are noise
  if (t.name === 'Read') return Math.floor(d.toolResult / 3); // file contents; the diff shows what changed
  return d.toolResult;
}

function renderTool(t: ToolItem, d: Detail, strip: (s: string) => string): string {
  const head = `  ▸ ${strip(toolSummary(t.name, t.input))}${t.sidechain ? ' (subagent)' : ''}${t.isError ? '  ✗ ERROR' : ''}`;
  const budget = resultBudget(t, d);
  if (!budget || !t.result?.trim()) return head;
  const body = indent(clipMiddle(strip(t.result.trim()), budget), '        ');
  return `${head}\n      ⎿ ${body.slice(8)}`;
}

function renderCollapsed(tools: ToolItem[], d: Detail, strip: (s: string) => string): string {
  const byName = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const i = (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>;
    const target = str(i, 'file_path') ?? str(i, 'notebook_path');
    if (target) byName.set(t.name, (byName.get(t.name) ?? new Set()).add(strip(target)));
  }
  const parts = [...counts].map(([name, n]) => {
    const files = [...(byName.get(name) ?? [])];
    const list = files.length ? ` (${files.slice(0, 4).join(', ')}${files.length > 4 ? `, +${files.length - 4}` : ''})` : '';
    return `${name}${n > 1 ? `×${n}` : ''}${list}`;
  });
  const errors = tools.filter((t) => t.isError);
  const lines = [`  ▸ ${tools.length} tool call${tools.length === 1 ? '' : 's'}: ${parts.join(', ')}`];
  for (const e of errors) {
    const msg = d.toolError > 0 && e.result ? `: ${oneLine(strip(e.result), d.toolError)}` : '';
    lines.push(`    ✗ ERROR in ${oneLine(strip(toolSummary(e.name, e.input)), 160)}${msg}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Turns and sessions
// ---------------------------------------------------------------------------

export function makeStripper(prefixes: string[]): (s: string) => string {
  const sorted = [...new Set(prefixes)].filter((p) => p.length > 1).sort((a, b) => b.length - a.length);
  if (!sorted.length) return (s) => s;
  return (s) => {
    let out = s;
    for (const p of sorted) {
      out = out.split(p).join('');
      const bare = p.replace(/\/$/, '');
      // The checkout root itself (e.g. `cd /abs/repo && …`) becomes '.'.
      out = out.replace(new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s\'"`;:)])', 'g'), '.');
    }
    return out;
  };
}

const fmtFiles = (files: FileChange[]) => files.map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} +${f.additions}/-${f.deletions}`).join(', ');
const hhmm = (ts?: string) => (ts ? ts.replace('T', ' ').slice(0, 16) : '');

interface TurnRenderCtx {
  label: string;
  review: Review;
  git: GitContext;
  detail: Detail;
  strip: (s: string) => string;
  /** Diff budget left for per-turn diffs (mutable across turns). */
  turnDiffBudget: { tokens: number };
  budget: RenderBudget;
  /** Final diff file chunks by path, to avoid repeating identical per-turn file diffs. */
  finalChunks: Map<string, string>;
  protectedFinal: boolean;
  commitSubjects: Map<string, string>;
}

function renderTurn(t: Turn, sessionId: string, c: TurnRenderCtx): string {
  const d = c.detail;
  const id = `${c.label}${t.index}`;
  const out: string[] = [];
  out.push(`<turn id="${id}" session="${c.label}" turn="${t.index}"${t.timestamp ? ` time="${hhmm(t.timestamp)}"` : ''}${t.model ? ` model="${t.model}"` : ''}>`);

  const between = c.git.betweenTurns[`${sessionId}#${t.index}`];
  if (between?.files.length) {
    out.push(`<changes_before_turn note="working-tree changes made between the previous turn and this prompt, not by the agent in this session (the human, or another session)">`);
    out.push(fmtFiles(between.files));
    if (d.turnDiffs && between.patch) {
      const p = truncateDiff(between.patch, Math.min(c.budget.turnDiffTokensEach, c.turnDiffBudget.tokens));
      c.turnDiffBudget.tokens -= estimateTokens(p);
      if (p) out.push(p.trimEnd());
    }
    out.push(`</changes_before_turn>`);
  }

  out.push(`<human>\n${clipMiddle(t.prompt.trim() || '(empty prompt)', d.prompt)}\n</human>`);

  // Agent activity in order. The last text item is the reply the human saw.
  const lastTextIdx = t.items.map((it) => it.kind).lastIndexOf('text');
  const body: string[] = [];
  let run: ToolItem[] = [];
  // Collapsed mode: one grouped line per turn, placed where the first tool call happened.
  const collapsedAll = t.items.filter((it): it is ToolItem => it.kind === 'tool' && it.name !== 'ExitPlanMode' && it.name !== 'AskUserQuestion');
  let collapsedDone = false;
  const flush = () => {
    if (!run.length) return;
    if (d.collapseTools) {
      if (!collapsedDone) body.push(renderCollapsed(collapsedAll, d, c.strip));
      collapsedDone = true;
    } else for (const x of run) body.push(renderTool(x, d, c.strip));
    run = [];
  };
  t.items.forEach((it, i) => {
    if (it.kind === 'tool') {
      if (it.name === 'ExitPlanMode' || it.name === 'AskUserQuestion') {
        // Plans and questions to the human are conversation, not tool noise.
        flush();
        body.push(`  ▸ ${c.strip(toolSummary(it.name, it.input))}`);
        return;
      }
      run.push(it);
      return;
    }
    flush();
    if (it.kind === 'text') {
      const isFinal = i === lastTextIdx;
      const max = isFinal ? (c.protectedFinal ? d.protectedText : d.finalText) : d.midText;
      if (max > 0) body.push(`AI${isFinal ? ' (final reply)' : ''}: ${clipMiddle(c.strip(it.text.trim()), max)}`);
    } else if (it.kind === 'thinking') {
      if (d.thinking > 0) body.push(`AI (thinking): ${clipMiddle(it.text.trim(), d.thinking)}`);
    } else if (it.kind === 'event') {
      if (it.subtype === 'interrupt') body.push('[the human interrupted the agent here]');
      else if (it.subtype === 'compact_boundary') body.push('[context was compacted here]');
      else if (it.subtype === 'compact_summary') body.push(`[compaction summary]: ${clipMiddle(it.text, Math.min(d.midText, 1500))}`);
      else if (d.toolResult > 0) body.push(`[${it.subtype}]: ${clipMiddle(c.strip(it.text), 300)}`);
    }
  });
  flush();
  if (body.length) out.push(`<agent>\n${body.join('\n')}\n</agent>`);
  else out.push('<agent>(no reply recorded)</agent>');

  const m = t.meta;
  if (m?.filesChanged?.length) out.push(`<files_changed_this_turn>${fmtFiles(m.filesChanged)}</files_changed_this_turn>`);
  if (m?.commits?.length) {
    const inRange = new Set(c.review.commits.map((x) => x.sha));
    out.push(`<commits_this_turn>${m.commits.map((sha) => `${sha.slice(0, 7)}${inRange.has(sha) ? '' : ' (outside this range)'} ${c.commitSubjects.get(sha) ?? ''}`.trimEnd()).join('; ')}</commits_this_turn>`);
  }
  if (d.turnDiffs && m?.filesChanged?.length) {
    const patch = c.git.turnDiffs[`${sessionId}#${t.index}`];
    if (patch) {
      // Files whose turn diff is identical to the final diff are shown once, in the final diff.
      const same = new Map<string, string>();
      for (const ch of splitDiff(patch)) if (c.finalChunks.get(ch.path) === ch.text) same.set(ch.path, 'identical to this file in the final diff');
      const allSame = splitDiff(patch).every((ch) => same.has(ch.path));
      if (allSame) out.push(`<turn_diff>(identical to the final diff for these files)</turn_diff>`);
      else if (c.turnDiffBudget.tokens > 200) {
        const p = truncateDiff(patch, Math.min(c.budget.turnDiffTokensEach, c.turnDiffBudget.tokens), same);
        c.turnDiffBudget.tokens -= estimateTokens(p);
        out.push(`<turn_diff note="what the agent changed during ${id}">\n${p.trimEnd()}\n</turn_diff>`);
      } else out.push(`<turn_diff>(omitted: diff budget used up)</turn_diff>`);
    }
  }
  out.push('</turn>');
  return out.join('\n');
}

function renderSession(slice: SessionSlice, s: Session, label: string, c: Omit<TurnRenderCtx, 'label' | 'protectedFinal'>): string {
  const turns = s.turns.filter((t) => t.index >= slice.fromTurn && t.index <= slice.toTurn);
  const total = s.turns.length;
  const attrs = [
    `label="${label}"`,
    `id="${s.meta.sessionId.slice(0, 8)}"`,
    s.meta.title ? `title="${s.meta.title.replace(/"/g, "'")}"` : '',
    s.meta.branch ? `branch="${s.meta.branch}"` : '',
    `turns="${slice.fromTurn}-${slice.toTurn} of ${total}"`,
    `committing_turns="${slice.committingTurns.join(',')}"`,
    s.meta.parent ? `forked_from="${s.meta.parent.sessionId.slice(0, 8)} turn ${s.meta.parent.turn}"` : '',
  ].filter(Boolean);
  const out = [`<session ${attrs.join(' ')}>`];
  if (slice.fromTurn > 1) out.push(`(turns 1-${slice.fromTurn - 1} are omitted: they produced commits outside this range)`);
  turns.forEach((t, i) => {
    const next = turns[i + 1] ?? s.turns.find((x) => x.index === t.index + 1);
    out.push(renderTurn(t, s.meta.sessionId, { ...c, label, protectedFinal: !!next && looksLikePushback(next.prompt) }));
  });
  if (slice.toTurn < total) out.push(`(turns ${slice.toTurn + 1}-${total} are omitted: they belong to later work)`);
  out.push('</session>');
  return out.join('\n');
}

function renderCommits(review: Review, git: GitContext, labels: Map<string, string>, d: Detail): string {
  const turnOf = new Map<string, string[]>();
  for (const sl of review.slices) {
    const s = review.sessions[sl.sessionId];
    for (const t of s?.turns ?? []) for (const sha of t.meta?.commits ?? []) turnOf.set(sha, [...(turnOf.get(sha) ?? []), `${labels.get(sl.sessionId)}${t.index}`]);
  }
  for (const c of review.commits)
    for (const tr of c.trailers) {
      const l = labels.get(tr.sessionId);
      if (l && !(turnOf.get(c.sha) ?? []).includes(`${l}${tr.turn}`)) turnOf.set(c.sha, [...(turnOf.get(c.sha) ?? []), `${l}${tr.turn}`]);
    }
  const lines = review.commits.map((c) => {
    const where = turnOf.get(c.sha);
    const tag = where?.length ? `[${where.join(', ')}]` : '[no captured conversation: made outside the recorded sessions]';
    const body = d.commitBodyLines > 0 ? (git.commitBodies[c.sha] ?? '').split('\n').filter((l) => l.trim()).slice(0, d.commitBodyLines) : [];
    return `- ${c.sha.slice(0, 7)} ${tag} ${c.subject}${body.length ? '\n' + indent(body.join('\n'), '    ') : ''}`;
  });
  return `<commits count="${review.commits.length}" order="oldest first">\n${lines.join('\n') || '(none)'}\n</commits>`;
}

export interface RenderResult {
  text: string;
  /** Index into LADDER that fit (LADDER.length means hard-truncated). */
  level: number;
  tokens: number;
  labels: Map<string, string>;
}

/** Render at detail level `d`. The final diff gets `diffTokens` (defaults to the level's share of the diff budget). */
function renderAt(review: Review, git: GitContext, budget: RenderBudget, d: Detail, labels: Map<string, string>, diffTokens?: number): string {
  const strip = makeStripper(git.rootPrefixes);
  const finalChunks = new Map(splitDiff(git.finalDiff).map((c) => [c.path, c.text]));
  const commitSubjects = new Map(review.commits.map((c) => [c.sha, c.subject]));
  const head: string[] = [];
  head.push(`<range base="${review.base}" head="${review.head}" merge_base="${review.mergeBase.slice(0, 7)}" sessions="${review.slices.length}" commits="${review.commits.length}"/>`);
  head.push(renderCommits(review, git, labels, d));

  const conv: string[] = ['<conversation note="sessions in chronological order; turn ids like A2 mean session A, turn 2">'];
  const turnDiffBudget = { tokens: budget.turnDiffTokens };
  for (const sl of review.slices) {
    const s = review.sessions[sl.sessionId];
    if (!s) continue;
    conv.push(renderSession(sl, s, labels.get(sl.sessionId)!, { review, git, detail: d, strip, turnDiffBudget, budget, finalChunks, commitSubjects }));
  }
  conv.push('</conversation>');

  const diff: string[] = [];
  diff.push(`<final_diff range="${review.mergeBase.slice(0, 7)}..${review.head}" files="${git.finalFiles.length}">`);
  diff.push(`Files: ${fmtFiles(git.finalFiles) || '(none)'}`);
  const patch = truncateDiff(git.finalDiff, diffTokens ?? Math.floor(budget.finalDiffTokens * d.finalDiffShare));
  if (patch) diff.push(patch.trimEnd());
  else if (git.finalDiff) diff.push('(patch omitted to fit the budget; file list above)');
  diff.push('</final_diff>');
  return [...head, '', ...conv, '', ...diff].join('\n');
}

/** Render the review at the most detailed level that fits `budget.totalTokens`. */
export function renderReviewForModel(review: Review, git: GitContext = emptyGitContext(), budget: Partial<RenderBudget> = {}): RenderResult {
  const b: RenderBudget = { ...DEFAULT_BUDGET, ...budget };
  const labels = sessionLabels(review);
  let text = '';
  for (let level = 0; level < LADDER.length; level++) {
    const d = LADDER[level]!;
    text = renderAt(review, git, b, d, labels);
    const tokens = estimateTokens(text);
    if (tokens > b.totalTokens) continue;
    // Fits. Hand any room that is left to the final diff (up to its full budget): the diff is the ground truth
    // for plan-vs-diff, so it shouldn't stay cut when the conversation shed enough detail to make space.
    const withoutDiff = estimateTokens(renderAt(review, git, b, d, labels, 0));
    const room = Math.min(b.finalDiffTokens, b.totalTokens - withoutDiff - 50);
    const current = Math.floor(b.finalDiffTokens * d.finalDiffShare);
    if (room > current && git.finalDiff) {
      const wider = renderAt(review, git, b, d, labels, room);
      const wt = estimateTokens(wider);
      if (wt <= b.totalTokens) return { text: wider, level, tokens: wt, labels };
    }
    return { text, level, tokens, labels };
  }
  // Still too big: keep the start (commits, early turns) and the end (latest turns, diff file list).
  const clipped = clipMiddle(text, tokensToChars(b.totalTokens));
  return { text: clipped, level: LADDER.length, tokens: estimateTokens(clipped), labels };
}
