// Node side of the viewer: git + store -> plain view models for the pure render functions.
import { basename } from 'node:path';
import { gitBuf, gitMaybe, repoRoot } from '../core/git.ts';
import { attribute, lineKey, turnId } from '../core/attribution.ts';
import { assembleReview } from '../core/review.ts';
import { diffTrees, listSessions, loadSession, readStoredSession } from '../core/store.ts';
import { isCommandPrompt } from '../core/transcript.ts';
import type { AskResult, Review, Session, Turn } from '../core/types.ts';
import { basicGlance, displayPrompt } from '../quick/glance.ts';
import { cachedNotes } from '../quick/map.ts';
import { findLeftovers } from '../quick/leftovers.ts';
import { sessionCode } from '../quick/scope.ts';
import type { PrBlock, PrFile, PrFileLine, PrLine, PrPageModel, PrSession, PrTurn, PrTurnFile } from './pr.ts';
import { anchorId as anchorFor } from './render.ts';
import { turnKey, type BranchRow, type ExtrasMap, type Features, type IndexPageModel, type ReviewPageModel, type SessionPageModel, type SessionRow } from './types.ts';

/** Quick asks (whole-page, Jev + Gemini) carry a `quick` block; deep asks at a turn don't. */
export const isQuickAsk = (a: AskResult) => (a as { quick?: unknown }).quick !== undefined;

/** A stored title that is really a terminal or slash command (`!ls`) isn't a title. */
export const displayTitle = (t: string | undefined) => (t && !isCommandPrompt(t) ? t : undefined);

/** Quick asks on any of these turns, newest first. */
export function quickAsksFor(asks: Map<string, AskResult[]> | undefined, items: { sessionId: string; turns: Turn[] }[]): AskResult[] {
  const out: AskResult[] = [];
  for (const { sessionId, turns } of items) {
    const idx = new Set(turns.map((t) => t.index));
    for (const a of asks?.get(sessionId) ?? []) if (isQuickAsk(a) && idx.has(a.turn)) out.push(a);
  }
  return out.sort((a, b) => (a.askedAt < b.askedAt ? 1 : -1));
}

/** Diffs bigger than this are cut (on a line boundary) before rendering. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/**
 * A single revision that is safe to pass to git as an argument: never an option (leading '-'), no
 * whitespace/control characters, and not a range. Branch names can legally contain most other characters.
 */
export function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 256 && !rev.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(rev) && !rev.includes('..');
}

export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function repoName(cwd: string): string {
  const root = repoRoot(cwd);
  return root ? basename(root) : basename(cwd);
}

/** The branch reviews compare against: main, master or trunk, else the current branch. */
export function defaultBranch(cwd: string): string {
  return (
    ['main', 'master', 'trunk'].find((b) => gitMaybe(['rev-parse', '--verify', '-q', `refs/heads/${b}`], { cwd })) ??
    gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd }) ??
    'HEAD'
  );
}

/** `git diff a b` as text, capped at MAX_DIFF_BYTES. */
export function gitDiff(cwd: string, a: string, b: string): { text: string; truncated: boolean } {
  const buf = gitBuf(['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', a, b, '--'], { cwd, allowFail: true });
  if (!buf) return { text: '', truncated: false };
  if (buf.length <= MAX_DIFF_BYTES) return { text: buf.toString('utf8'), truncated: false };
  const cut = buf.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  return { text: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true };
}

/** Subjects for commit shas; commits that no longer exist get an empty subject. */
export function commitSubjects(cwd: string, shas: string[], known: Map<string, string> = new Map()): Map<string, string> {
  const out = new Map<string, string>();
  const unknown: string[] = [];
  for (const sha of new Set(shas)) {
    const k = known.get(sha);
    if (k !== undefined) out.set(sha, k);
    else if (/^[0-9a-f]{7,64}$/.test(sha)) unknown.push(sha);
  }
  if (unknown.length) {
    const all = gitMaybe(['show', '-s', '--format=%H%x1f%s', ...unknown], { cwd });
    const lines = all ? all.split('\n') : unknown.map((sha) => gitMaybe(['show', '-s', '--format=%H%x1f%s', sha], { cwd }) ?? '');
    for (const line of lines) {
      const [sha, subject] = line.split('\x1f');
      if (sha && subject !== undefined) out.set(sha, subject);
    }
  }
  return out;
}

/** Per-turn extras: commit subjects, human edits between turns (before(N) vs after(N-1)), past asks. */
export function computeExtras(
  cwd: string,
  items: { session: Session; from: number; to: number }[],
  opts: { subjects?: Map<string, string>; asks?: Map<string, AskResult[]> } = {},
): ExtrasMap {
  const extras: ExtrasMap = {};
  const allShas = items.flatMap(({ session, from, to }) => session.turns.filter((t) => t.index >= from && t.index <= to).flatMap((t) => t.meta?.commits ?? []));
  const subjects = commitSubjects(cwd, allShas, opts.subjects);
  for (const { session, from, to } of items) {
    const sid = session.meta.sessionId;
    const byIndex = new Map(session.turns.map((t) => [t.index, t]));
    const asks = opts.asks?.get(sid) ?? [];
    for (const t of session.turns) {
      if (t.index < from || t.index > to) continue;
      const e: ExtrasMap[string] = {};
      if (t.meta?.commits?.length) e.commits = t.meta.commits.map((sha) => ({ sha, subject: subjects.get(sha) ?? '' }));
      const prevAfter = byIndex.get(t.index - 1)?.meta?.stateAfter;
      const before = t.meta?.stateBefore;
      if (prevAfter && before && prevAfter !== before) {
        try {
          const edits = diffTrees(cwd, prevAfter, before);
          if (edits.length) e.humanEdits = edits;
        } catch {
          // Snapshot trees not available locally (e.g. partially fetched); skip the marker.
        }
      }
      const turnAsks = asks.filter((a) => a.turn === t.index && !isQuickAsk(a));
      if (turnAsks.length) e.asks = turnAsks;
      if (Object.keys(e).length) extras[turnKey(sid, t.index)] = e;
    }
  }
  return extras;
}

export function buildReviewModel(cwd: string, base: string, head: string, opts: { features: Features; asks?: Map<string, AskResult[]>; review?: Review }): ReviewPageModel {
  const review = opts.review ?? assembleReview(cwd, base, head);
  const subjects = new Map(review.commits.map((c) => [c.sha, c.subject]));
  const extras = computeExtras(
    cwd,
    review.slices.map((sl) => ({ session: review.sessions[sl.sessionId]!, from: sl.fromTurn, to: sl.toTurn })),
    { subjects, asks: opts.asks },
  );
  const diff = gitDiff(cwd, review.mergeBase, head);
  const items = review.slices.map((sl) => ({ sessionId: sl.sessionId, turns: review.sessions[sl.sessionId]!.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn) }));
  const headSha = gitMaybe(['rev-parse', '--verify', '-q', `${head}^{commit}`], { cwd }) ?? undefined;
  const glance = { glance: basicGlance({ items, diff: diff.text }), target: `${base}..${head}`, asks: quickAsksFor(opts.asks, items), leftovers: findLeftovers(cwd, diff.text, headSha) };
  return { review, extras, diff: diff.text, diffTruncated: diff.truncated, features: opts.features, repoName: repoName(cwd), glance };
}

/** What a session changed overall: its first before-snapshot to its last after-snapshot. */
export function sessionDiff(cwd: string, session: Session): { text: string; truncated: boolean } {
  const from = session.turns.find((t) => t.meta?.stateBefore)?.meta?.stateBefore;
  const to = [...session.turns].reverse().find((t) => t.meta?.stateAfter)?.meta?.stateAfter;
  return from && to && from !== to ? gitDiff(cwd, from, to) : { text: '', truncated: false };
}

export function buildSessionModel(cwd: string, sessionId: string, opts: { features: Features; asks?: Map<string, AskResult[]> }): SessionPageModel | null {
  const session = loadSession(cwd, sessionId);
  if (!session) return null;
  const extras = computeExtras(cwd, [{ session, from: 1, to: Number.MAX_SAFE_INTEGER }], { asks: opts.asks });
  const diff = sessionDiff(cwd, session);
  const items = [{ sessionId, turns: session.turns }];
  const glance = {
    glance: basicGlance({ items, diff: diff.text, title: displayTitle(session.meta.title) }),
    target: sessionId,
    asks: quickAsksFor(opts.asks, items),
    leftovers: findLeftovers(cwd, diff.text, sessionCode(cwd, session.turns)?.rev),
  };
  return { session, extras, features: opts.features, repoName: repoName(cwd), diff: diff.text, diffTruncated: diff.truncated, glance };
}

/** Resolve a full session id from an exact id or a unique prefix. */
export function resolveSession(cwd: string, idOrPrefix: string): string | null {
  const ids = listSessions(cwd).map((s) => s.sessionId);
  if (ids.includes(idOrPrefix)) return idOrPrefix;
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0]! : null;
}

export function buildIndexModel(cwd: string): IndexPageModel {
  const base = defaultBranch(cwd);
  const rows: SessionRow[] = [];
  const byBranch = new Map<string, { sessions: { sessionId: string; title?: string }[]; updatedAt?: string }>();
  for (const { sessionId } of listSessions(cwd)) {
    const s = readStoredSession(cwd, sessionId);
    if (!s) continue;
    rows.push({
      sessionId,
      title: displayTitle(s.meta.title),
      branch: s.meta.branch,
      author: s.meta.author?.name,
      turns: s.turns.length,
      commits: s.turns.reduce((n, t) => n + (t.meta.commits?.length ?? 0), 0),
      startedAt: s.meta.startedAt,
      updatedAt: s.meta.updatedAt,
    });
    const branches = new Set([s.meta.branch, ...s.turns.map((t) => t.meta.branch)].filter((b): b is string => !!b && b !== 'HEAD'));
    for (const b of branches) {
      const e = byBranch.get(b) ?? { sessions: [] };
      e.sessions.push({ sessionId, title: displayTitle(s.meta.title) });
      if (!e.updatedAt || (s.meta.updatedAt && s.meta.updatedAt > e.updatedAt)) e.updatedAt = s.meta.updatedAt;
      byBranch.set(b, e);
    }
  }
  rows.sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1));
  const branches: BranchRow[] = [...byBranch].map(([branch, e]) => {
    const local = isSafeRev(branch) && !!gitMaybe(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd });
    const remote = !local && isSafeRev(branch) && !!gitMaybe(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd });
    const head = remote ? `origin/${branch}` : branch;
    const exists = local || remote;
    const ahead = exists && branch !== base ? Number(gitMaybe(['rev-list', '--count', `${base}..${head}`, '--'], { cwd }) ?? 0) : 0;
    return { branch, base, exists, head, ahead, sessions: e.sessions, updatedAt: e.updatedAt };
  });
  // Feature branches first (most recent activity first), then the default branch, then missing branches.
  const rank = (b: BranchRow) => (!b.exists ? 2 : b.branch === base ? 1 : 0);
  branches.sort((a, b) => rank(a) - rank(b) || ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1));
  return { repoName: repoName(cwd), defaultBranch: base, branches, sessions: rows };
}

/** Transcript lines stored for one turn. */
export function turnRaw(cwd: string, sessionId: string, turn: number): string[] | null {
  const s = readStoredSession(cwd, sessionId);
  const t = s?.turns.find((x) => x.meta.index === turn);
  return t ? t.transcript : null;
}

/**
 * Diff for a turn. span 'agent' (default): stateBefore(N)..stateAfter(N), what happened during the turn.
 * span 'human': stateAfter(N-1)..stateBefore(N), edits made by hand between turns.
 */
export function turnDiff(cwd: string, sessionId: string, turn: number, span: 'agent' | 'human' = 'agent'): { text: string; truncated: boolean } | null {
  const s = readStoredSession(cwd, sessionId);
  if (!s) return null;
  const meta = s.turns.find((x) => x.meta.index === turn)?.meta;
  if (!meta) return null;
  const from = span === 'human' ? s.turns.find((x) => x.meta.index === turn - 1)?.meta.stateAfter : meta.stateBefore;
  const to = span === 'human' ? meta.stateBefore : meta.stateAfter;
  if (!from || !to) return { text: '', truncated: false };
  return gitDiff(cwd, from, to);
}

// ---------------------------------------------------------------------------
// PR page: turns with the code each one wrote (src/core/attribution.ts), rendered by ./pr.ts
// ---------------------------------------------------------------------------

/** Context lines shown around each run of changed lines. */
const PR_CONTEXT = 2;

/** The start of Claude's reply, as plain text: its first paragraph, cut at a sentence end. */
function replyStart(text: string, max = 260): string {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|```|\||- |\d+\. )/.test(p)) ?? text.trim();
  const flat = para.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

export function buildPrModel(cwd: string, base: string, head: string, review: Review): PrPageModel {
  const a = review.attribution ?? attribute(cwd, '', []);
  const names = new Map<string, string>();
  for (const s of Object.values(review.sessions)) names.set(s.meta.sessionId, s.meta.author?.name ?? 'you');
  const whoOf = (sessionId: string, turn: number): string => {
    const t = review.sessions[sessionId]?.turns.find((x) => x.index === turn);
    return t?.from ?? names.get(sessionId) ?? 'you';
  };

  // Blocks per turn: runs of consecutive changed lines with the same credit, with context around them.
  const blocks = new Map<string, Map<string, PrBlock[]>>();
  const files: PrFile[] = a.files.map((f, fi) => {
    const path = f.status === 'D' ? f.oldPath : f.newPath;
    const hunks: PrFileLine[][] = f.hunks.map((h, hi) => {
      const out: PrFileLine[] = [];
      // Changed-line positions per turn in this hunk; nearby ones merge into one block (no repeated context).
      const mine = new Map<string, number[]>();
      h.lines.forEach((l, li) => {
        if (l.type === 'meta') return;
        if (l.type === 'ctx') {
          out.push({ kind: 'ctx', text: l.text, no: l.newNo });
          return;
        }
        const c = a.credit.get(lineKey(fi, hi, li)) ?? null;
        out.push({ kind: l.type, text: l.text, no: l.type === 'del' ? l.oldNo : l.newNo, by: c ? { sessionId: c.sessionId, turn: c.turn, who: whoOf(c.sessionId, c.turn) } : null });
        if (c) mine.set(turnId(c.sessionId, c.turn), [...(mine.get(turnId(c.sessionId, c.turn)) ?? []), li]);
      });
      for (const [key, idx] of mine) {
        const spans: [number, number][] = [];
        for (const i of idx) {
          const last = spans[spans.length - 1];
          if (last && i - last[1] <= 2 * PR_CONTEXT + 1) last[1] = i;
          else spans.push([i, i]);
        }
        for (const [start, end] of spans) {
          const lines: PrLine[] = [];
          for (let i = Math.max(0, start - PR_CONTEXT); i <= Math.min(h.lines.length - 1, end + PR_CONTEXT); i++) {
            const l = h.lines[i]!;
            if (l.type === 'meta') continue;
            const ours = (l.type === 'add' || l.type === 'del') && idx.includes(i);
            // Other turns' changes inside the span: their added lines are part of the file, so show them as context;
            // their removed lines aren't, so leave them out.
            if (!ours && l.type === 'del') continue;
            lines.push({ kind: ours ? (l.type as 'add' | 'del') : 'ctx', text: l.text, no: l.type === 'del' ? l.oldNo : l.newNo });
          }
          const byPath = blocks.get(key) ?? new Map<string, PrBlock[]>();
          byPath.set(path, [...(byPath.get(path) ?? []), { lines }]);
          blocks.set(key, byPath);
        }
      }
      return out;
    });
    return { path, status: f.status, additions: f.additions, deletions: f.deletions, hunks };
  });

  const labels = review.slices.map((sl) => sl.sessionId);
  const sessions: PrSession[] = review.slices.map((sl) => {
    const s = review.sessions[sl.sessionId]!;
    const turns = s.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn);
    const notes = cachedNotes(cwd, sl.sessionId, turns);
    return {
      sessionId: sl.sessionId,
      title: s.meta.title ?? sl.sessionId.slice(0, 8),
      ...(s.meta.author?.name ? { author: s.meta.author.name } : {}),
      color: labels.indexOf(sl.sessionId) % 6,
      turns: turns.map((t): PrTurn => {
        const credit = a.turns.get(turnId(sl.sessionId, t.index));
        const byPath = blocks.get(turnId(sl.sessionId, t.index)) ?? new Map<string, PrBlock[]>();
        const turnFiles: PrTurnFile[] = credit
          ? [...credit.files].map(([path, c]) => ({ path, additions: c.additions, deletions: c.deletions, blocks: byPath.get(path) ?? [] }))
          : [];
        const note = notes.get(t.index);
        const reply = t.finalResponse?.trim();
        const midTurn = t.items.flatMap((i) =>
          i.kind === 'event' && i.subtype === 'midturn'
            ? [{ text: i.text, who: i.from ?? names.get(sl.sessionId) ?? 'you', fromAgent: !!i.from, ...(i.timestamp ? { at: i.timestamp } : {}) }]
            : [],
        );
        return {
          sessionId: sl.sessionId,
          turn: t.index,
          ...(t.timestamp ? { at: t.timestamp } : {}),
          who: t.from ?? names.get(sl.sessionId) ?? 'you',
          fromAgent: !!t.from,
          ask: displayPrompt(t.prompt),
          command: isCommandPrompt(t.prompt),
          ...(note?.did ? { did: { text: note.did, source: 'summary' as const } } : reply ? { did: { text: replyStart(reply), source: 'reply' as const } } : {}),
          files: turnFiles.sort((x, y) => y.additions + y.deletions - (x.additions + x.deletions)),
          additions: sumBy(turnFiles, (f) => f.additions),
          deletions: sumBy(turnFiles, (f) => f.deletions),
          toolCalls: t.items.filter((i) => i.kind === 'tool').length,
          rawHref: `/session/${encodeURIComponent(sl.sessionId)}#${anchorFor(sl.sessionId, t.index)}`,
          ...(midTurn.length ? { midTurn } : {}),
        };
      }),
    };
  });

  const branch = gitMaybe(['rev-parse', '--verify', '-q', `refs/heads/${head}`], { cwd }) ? head : '';
  const title = review.commits.length === 1 ? review.commits[0]!.subject : branch || review.commits.at(-1)?.subject || `${base}..${head}`;
  return {
    title,
    base,
    head,
    commits: review.commits.map((c) => ({ sha: c.sha, subject: c.subject })),
    coverage: { lines: a.totals.lines, credited: a.totals.credited },
    sessions,
    files,
    repoName: repoName(cwd),
    oldHref: `/review-old?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
  };
}

const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
