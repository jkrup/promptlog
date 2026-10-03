// Which turn wrote each changed line of a diff.
//
// Agents commit rarely, so commits can't say which turn did the work. Lines can:
//   1. snapshot: a live-captured turn whose before/after trees added (or removed) that exact line. Exact.
//   2. conversation: the earliest turn whose tool calls contain the line: an Edit's new_string, a Write's content,
//      or the code inside a Bash command (agents often edit with scripts). Works for imported sessions too.
//   3. none: the line came from outside the conversation (an edit by hand, another tool).
// Short lines ("}", "return;") are too common to match on their own; they take the credit of the nearest credited
// changed lines around them when those agree, or are matched together with the lines around them.
import { gitBuf } from './git.ts';
import { parseDiff, type DiffFile } from './diff.ts';
import type { Session, Turn } from './types.ts';

export type Via = 'snapshot' | 'conversation';

export interface Credit {
  sessionId: string;
  turn: number;
  via: Via;
}

export interface TurnCredit {
  sessionId: string;
  turn: number;
  /** Changed lines credited to this turn. */
  lines: number;
  /** Per file: lines this turn added / removed in the diff. */
  files: Map<string, { additions: number; deletions: number }>;
}

export interface Attribution {
  files: DiffFile[];
  /** Credit for each changed line, keyed by lineKey(file, hunk, line) indexes into `files`. */
  credit: Map<string, Credit | null>;
  /** Keyed by turnId(sessionId, turn), in the order the turns happened. */
  turns: Map<string, TurnCredit>;
  totals: { lines: number; credited: number };
}

/** Lines shorter than this (after trimming) are matched only through their neighbours. */
export const MIN_MATCH = 12;
/** Tools whose inputs can carry code that ends up in files. Reads and searches only echo it. */
const NON_WRITING = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'Task', 'Agent']);

export const lineKey = (f: number, h: number, l: number) => `${f}:${h}:${l}`;
export const turnId = (sessionId: string, turn: number) => `${sessionId}#${turn}`;
const norm = (s: string) => s.trim();

/** Every string inside a tool input, at any depth (command, content, new_string, edits[].new_string, ...). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** What a turn's writing tool calls contain, as one string (for substring checks) and as a set of whole lines. */
function turnText(t: Turn): { blob: string; lines: Set<string>; trimmed: string } {
  const parts: string[] = [];
  for (const it of t.items) if (it.kind === 'tool' && !NON_WRITING.has(it.name)) strings(it.input, parts);
  const lines = new Set<string>();
  for (const p of parts) for (const l of p.split('\n')) {
    const n = norm(l);
    if (n.length >= MIN_MATCH) lines.add(n);
  }
  const blob = parts.join('\n');
  return { blob, lines, trimmed: blob.split('\n').map(norm).join('\n') };
}

interface TurnRef {
  sessionId: string;
  turn: Turn;
  at: string;
}

/** The changed lines a live-captured turn's own snapshots show, keyed `path\0add|del\0text`. */
function snapshotLines(cwd: string, t: Turn): Set<string> {
  const m = t.meta;
  const out = new Set<string>();
  if (!m?.stateBefore || !m.stateAfter || m.stateSource === 'commits' || m.stateBefore === m.stateAfter) return out;
  const buf = gitBuf(['diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', m.stateBefore, m.stateAfter, '--'], { cwd, allowFail: true });
  if (!buf) return out;
  for (const f of parseDiff(buf.toString('utf8'))) {
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.type === 'add') out.add(`${f.newPath}\0add\0${norm(l.text)}`);
      else if (l.type === 'del') out.add(`${f.oldPath}\0del\0${norm(l.text)}`);
    }
  }
  return out;
}

/**
 * Credit every changed line of `diffText` to a turn of `sessions`. Sessions in `prefer` (e.g. linked to the PR's
 * commits) win over others when both contain a line. `since` (ISO time, e.g. the PR's base commit) leaves out turns
 * of other sessions whose last activity is older: their code was already in the base.
 */
export function attribute(cwd: string, diffText: string, sessions: Session[], opts: { prefer?: Set<string>; since?: string } = {}): Attribution {
  const files = parseDiff(diffText);
  const credit = new Map<string, Credit | null>();
  const turns = new Map<string, TurnCredit>();
  const totals = { lines: 0, credited: 0 };

  // Turns in the order they happened; preferred sessions first so they win ties on "earliest".
  const lastActivity = (t: Turn) => [t.timestamp, t.meta?.endedAt, ...t.items.map((i) => i.timestamp)].filter(Boolean).sort().pop() ?? '';
  const refs: TurnRef[] = sessions
    .flatMap((s) => s.turns.map((t) => ({ sessionId: s.meta.sessionId, turn: t, at: t.timestamp ?? t.meta?.startedAt ?? '' })))
    // Sessions tied to the range's commits always count; other sessions only if they were active after the base.
    .filter((r) => !opts.since || opts.prefer?.has(r.sessionId) || lastActivity(r.turn) >= opts.since);
  refs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const tiers = opts.prefer?.size ? [refs.filter((r) => opts.prefer!.has(r.sessionId)), refs.filter((r) => !opts.prefer!.has(r.sessionId))] : [refs];

  // 1. Snapshots: the latest live turn that made the exact change.
  const bySnapshot = new Map<string, TurnRef>();
  for (const tier of [...tiers].reverse()) for (const r of tier) for (const k of snapshotLines(cwd, r.turn)) bySnapshot.set(k, r);

  // 2. Conversation: the earliest turn whose writing tool calls contain the line.
  const texts = new Map<TurnRef, ReturnType<typeof turnText>>();
  const textOf = (r: TurnRef) => texts.get(r) ?? (texts.set(r, turnText(r.turn)), texts.get(r)!);
  // Added lines go to the earliest turn that wrote them (later turns may quote them as context); removed lines to the
  // latest turn that mentions them (the one that took them out; earlier mentions are where they were written).
  const firstWith = new Map<string, TurnRef>();
  const lastWith = new Map<string, TurnRef>();
  for (const tier of [...tiers].reverse()) {
    for (let i = tier.length - 1; i >= 0; i--) for (const l of textOf(tier[i]!).lines) firstWith.set(l, tier[i]!);
    for (const r of tier) for (const l of textOf(r).lines) lastWith.set(l, r);
  }
  const bySubstring = (text: string, latest: boolean): TurnRef | undefined => {
    for (const tier of tiers) {
      const order = latest ? [...tier].reverse() : tier;
      for (const r of order) if (textOf(r).blob.includes(text)) return r;
    }
    return undefined;
  };

  const give = (key: string, r: TurnRef | undefined, via: Via) => credit.set(key, r ? { sessionId: r.sessionId, turn: r.turn.index, via } : null);
  files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) =>
      h.lines.forEach((l, li) => {
        if (l.type !== 'add' && l.type !== 'del') return;
        totals.lines++;
        const text = norm(l.text);
        const key = lineKey(fi, hi, li);
        const snap = bySnapshot.get(`${l.type === 'add' ? f.newPath : f.oldPath}\0${l.type}\0${text}`);
        if (snap) return give(key, snap, 'snapshot');
        if (text.length < MIN_MATCH) return credit.set(key, null);
        const latest = l.type === 'del';
        give(key, (latest ? lastWith : firstWith).get(text) ?? bySubstring(text, latest), 'conversation');
      }),
    ),
  );

  // 3. Short lines take their neighbours' credit when the changed lines on both sides agree.
  files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) => {
      const changed = h.lines.map((l, li) => ({ l, li })).filter(({ l }) => l.type === 'add' || l.type === 'del');
      changed.forEach(({ l, li }, k) => {
        const key = lineKey(fi, hi, li);
        if (credit.get(key) || norm(l.text).length >= MIN_MATCH) return;
        const near = (step: number) => {
          for (let j = k + step; j >= 0 && j < changed.length; j += step) {
            const c = credit.get(lineKey(fi, hi, changed[j]!.li));
            if (c) return c;
            if (norm(changed[j]!.l.text).length >= MIN_MATCH) return null;
          }
          return null;
        };
        // Take the credit of the nearest credited lines on either side, if the ones that exist agree.
        const sides = [near(-1), near(1)].filter((c): c is Credit => !!c);
        if (sides.length && sides.every((c) => c.sessionId === sides[0]!.sessionId && c.turn === sides[0]!.turn)) credit.set(key, sides[0]!);
      });
    }),
  );

  // 4. A short line still without credit (often alone in its hunk, like one name added to an import list): look for it
  //    together with the lines around it, which is distinctive even when the line alone isn't.
  const byWindow = (window: string, latest: boolean): TurnRef | undefined => {
    for (const tier of tiers) {
      const order = latest ? [...tier].reverse() : tier;
      for (const r of order) if (textOf(r).trimmed.includes(window)) return r;
    }
    return undefined;
  };
  files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) =>
      h.lines.forEach((l, li) => {
        if ((l.type !== 'add' && l.type !== 'del') || credit.get(lineKey(fi, hi, li))) return;
        // Neighbours as they read in that version of the file: added lines live with context and other added lines,
        // removed lines with context and other removed lines.
        const side = (j: number) => {
          const x = h.lines[j];
          return x && x.type !== 'meta' && (x.type === 'ctx' || x.type === l.type) ? norm(x.text) : undefined;
        };
        let p = li - 1;
        while (p >= 0 && h.lines[p]!.type !== 'ctx' && h.lines[p]!.type !== l.type) p--;
        let n = li + 1;
        while (n < h.lines.length && h.lines[n]!.type !== 'ctx' && h.lines[n]!.type !== l.type) n++;
        const [before, after] = [side(p), side(n)];
        const me = norm(l.text);
        const windows = [before !== undefined && after !== undefined ? `${before}\n${me}\n${after}` : '', before !== undefined ? `${before}\n${me}` : '', after !== undefined ? `${me}\n${after}` : ''];
        for (const w of windows) {
          if (w.length < 2 * MIN_MATCH) continue;
          const r = byWindow(w, l.type === 'del');
          if (r) {
            give(lineKey(fi, hi, li), r, 'conversation');
            return;
          }
        }
      }),
    ),
  );

  // Per-turn totals, in the order the turns happened.
  for (const r of refs) turns.set(turnId(r.sessionId, r.turn.index), { sessionId: r.sessionId, turn: r.turn.index, lines: 0, files: new Map() });
  files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) =>
      h.lines.forEach((l, li) => {
        const c = credit.get(lineKey(fi, hi, li));
        if (!c) return;
        totals.credited++;
        const tc = turns.get(turnId(c.sessionId, c.turn))!;
        tc.lines++;
        const path = f.status === 'D' ? f.oldPath : f.newPath;
        const fc = tc.files.get(path) ?? { additions: 0, deletions: 0 };
        if (l.type === 'add') fc.additions++;
        else fc.deletions++;
        tc.files.set(path, fc);
      }),
    ),
  );
  for (const [k, v] of turns) if (v.lines === 0) turns.delete(k);
  return { files, credit, turns, totals };
}
