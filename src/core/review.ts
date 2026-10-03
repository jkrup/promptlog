// Assemble a Review: commit range (the "PR") -> the conversation slices that produced it.
// Many-to-many by construction: one range can pull from several sessions and one long session can feed several ranges.
// A session belongs to a range when its turns wrote the range's lines (src/core/attribution.ts) or made its commits.
import { attribute } from './attribution.ts';
import { git, gitBuf, gitMaybe } from './git.ts';
import { listSessions, loadSession } from './store.ts';
import type { CommitInfo, Review, Session, SessionSlice } from './types.ts';

const TRAILER_RE = /^Promptlog:\s*([\w-]+)#(\d+)\s*$/gm;
/** A session not linked to the range's commits joins it only if its turns wrote at least this many of its lines. */
const MIN_SESSION_LINES = 5;
/** Attribution reads the whole range diff; past this it reads only the start (huge generated changes). */
const MAX_RANGE_DIFF_BYTES = 32 * 1024 * 1024;

function rangeDiff(cwd: string, a: string, b: string): string {
  const buf = gitBuf(['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', a, b, '--'], { cwd, allowFail: true });
  if (!buf) return '';
  if (buf.length <= MAX_RANGE_DIFF_BYTES) return buf.toString('utf8');
  const cut = buf.subarray(0, MAX_RANGE_DIFF_BYTES).toString('utf8');
  return cut.slice(0, cut.lastIndexOf('\n') + 1);
}

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

export function sliceSession(session: Session, inRange: Set<string>, trailerTurns: number[], workTurns: number[] = []): SessionSlice | null {
  const committing = new Set<number>(trailerTurns);
  for (const t of session.turns) if (t.meta?.commits?.some((c) => inRange.has(c))) committing.add(t.index);
  const anchors = new Set<number>([...committing, ...workTurns]);
  if (anchors.size === 0) return null;
  const sorted = [...anchors].sort((a, b) => a - b);
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
  return {
    sessionId: session.meta.sessionId,
    fromTurn: from,
    toTurn: to,
    committingTurns: [...committing].sort((a, b) => a - b),
    workTurns: [...workTurns].sort((a, b) => a - b),
  };
}

export function assembleReview(cwd: string, base: string, head: string): Review {
  const mergeBase = gitMaybe(['merge-base', base, head], { cwd }) ?? base;
  const commits = commitsInRange(cwd, mergeBase, head);
  const inRange = new Set(commits.map((c) => c.sha));
  const trailerTurns = new Map<string, number[]>();
  for (const c of commits) for (const t of c.trailers) trailerTurns.set(t.sessionId, [...(trailerTurns.get(t.sessionId) ?? []), t.turn]);

  const all = listSessions(cwd)
    .map(({ sessionId }) => loadSession(cwd, sessionId))
    .filter((s): s is Session => !!s);
  const linked = new Set(all.filter((s) => trailerTurns.has(s.meta.sessionId) || s.turns.some((t) => t.meta?.commits?.some((c) => inRange.has(c)))).map((s) => s.meta.sessionId));
  const since = gitMaybe(['show', '-s', '--format=%cI', mergeBase], { cwd });
  const attribution = attribute(cwd, rangeDiff(cwd, mergeBase, head), all, { prefer: linked, ...(since ? { since: new Date(since).toISOString() } : {}) });
  const work = new Map<string, number[]>();
  const workLines = new Map<string, number>();
  for (const t of attribution.turns.values()) {
    work.set(t.sessionId, [...(work.get(t.sessionId) ?? []), t.turn]);
    workLines.set(t.sessionId, (workLines.get(t.sessionId) ?? 0) + t.lines);
  }

  const sessions: Record<string, Session> = {};
  const slices: SessionSlice[] = [];
  for (const s of all) {
    const sessionId = s.meta.sessionId;
    // A stray line or two matched in an unrelated session doesn't make it part of the PR.
    const ownWork = linked.has(sessionId) || (workLines.get(sessionId) ?? 0) >= MIN_SESSION_LINES ? (work.get(sessionId) ?? []) : [];
    const slice = sliceSession(s, inRange, trailerTurns.get(sessionId) ?? [], ownWork);
    if (!slice) continue;
    sessions[sessionId] = s;
    slices.push(slice);
  }
  // Interleave by time so multi-session reviews read chronologically.
  const startOf = (sl: SessionSlice) => sessions[sl.sessionId]?.turns.find((t) => t.index === sl.fromTurn)?.timestamp ?? '';
  slices.sort((a, b) => (startOf(a) < startOf(b) ? -1 : 1));
  return { base, head, mergeBase: git(['rev-parse', mergeBase], { cwd }), commits, slices, sessions, attribution };
}
