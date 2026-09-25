// Assemble a Review: commit range (the "PR") -> the conversation slices that produced it.
// Many-to-many by construction: turns link to commits, so one range can pull from several sessions
// and one long session can feed several ranges.
import { git, gitMaybe } from './git.ts';
import { listSessions, loadSession } from './store.ts';
import type { CommitInfo, Review, Session, SessionSlice } from './types.ts';

const TRAILER_RE = /^Promptlog:\s*([\w-]+)#(\d+)\s*$/gm;

export function commitsInRange(cwd: string, base: string, head: string): CommitInfo[] {
  const out = gitMaybe(['log', '--reverse', '--format=%H%x1f%s%x1f%an%x1f%aI%x1f%B%x1e', `${base}..${head}`], { cwd });
  if (!out) return [];
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, author, date, body] = r.split('\x1f') as [string, string, string, string, string];
      const trailers = [...(body ?? '').matchAll(TRAILER_RE)].map((m) => ({ sessionId: m[1]!, turn: Number(m[2]) }));
      return { sha, subject, author, date, trailers };
    });
}

/** Parse "base..head", "base...head", or a single ref (compared against the default base). */
export function parseRange(cwd: string, spec: string | undefined): { base: string; head: string } {
  if (spec && spec.includes('..')) {
    const [base, head] = spec.split(/\.\.\.?/) as [string, string];
    return { base: base || 'HEAD', head: head || 'HEAD' };
  }
  const head = spec || 'HEAD';
  const base = ['main', 'master', 'trunk'].find((b) => gitMaybe(['rev-parse', '--verify', '-q', b], { cwd })) ?? `${head}~1`;
  return { base, head };
}

export function sliceSession(session: Session, inRange: Set<string>, trailerTurns: number[]): SessionSlice | null {
  const committing = new Set<number>(trailerTurns);
  for (const t of session.turns) if (t.meta?.commits?.some((c) => inRange.has(c))) committing.add(t.index);
  if (committing.size === 0) return null;
  const sorted = [...committing].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  // Start after the last earlier turn that committed outside this range (that work belongs to another review).
  let from = 1;
  for (const t of session.turns) {
    if (t.index >= first) break;
    if (t.meta?.commits?.some((c) => !inRange.has(c))) from = t.index + 1;
  }
  // Extend past the last committing turn through trailing discussion, until a turn commits outside the range.
  let to = last;
  for (const t of session.turns) {
    if (t.index <= last) continue;
    if (t.meta?.commits?.some((c) => !inRange.has(c))) break;
    to = t.index;
  }
  return { sessionId: session.meta.sessionId, fromTurn: from, toTurn: to, committingTurns: sorted };
}

export function assembleReview(cwd: string, base: string, head: string): Review {
  const mergeBase = gitMaybe(['merge-base', base, head], { cwd }) ?? base;
  const commits = commitsInRange(cwd, mergeBase, head);
  const inRange = new Set(commits.map((c) => c.sha));
  const trailerTurns = new Map<string, number[]>();
  for (const c of commits) for (const t of c.trailers) trailerTurns.set(t.sessionId, [...(trailerTurns.get(t.sessionId) ?? []), t.turn]);

  const sessions: Record<string, Session> = {};
  const slices: SessionSlice[] = [];
  for (const { sessionId } of listSessions(cwd)) {
    const s = loadSession(cwd, sessionId);
    if (!s) continue;
    const slice = sliceSession(s, inRange, trailerTurns.get(sessionId) ?? []);
    if (!slice) continue;
    sessions[sessionId] = s;
    slices.push(slice);
  }
  // Interleave by time so multi-session reviews read chronologically.
  const startOf = (sl: SessionSlice) => sessions[sl.sessionId]?.turns.find((t) => t.index === sl.fromTurn)?.timestamp ?? '';
  slices.sort((a, b) => (startOf(a) < startOf(b) ? -1 : 1));
  return { base, head, mergeBase: git(['rev-parse', mergeBase], { cwd }), commits, slices, sessions };
}
