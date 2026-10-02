// What a quick ask (or `promptlog map`) looks at: one whole session, or the conversation slices behind a commit range.
import { gitMaybe } from '../core/git.ts';
import { assembleReview, parseRange } from '../core/review.ts';
import { listSessions, loadSession } from '../core/store.ts';
import type { Session, Turn } from '../core/types.ts';
import { resolveSessionId } from '../ask/session.ts';

export interface Scope {
  /** "session <id8>" or "<base>..<head>". */
  label: string;
  /** In conversation order (review slices are ordered by time). */
  sessions: { session: Session; turns: Turn[] }[];
  /** The code as of the end of this work, for code search: the PR head commit, or the session's last snapshot tree. */
  code?: { rev: string; label: string };
}

/** True when `target` names a captured session (full id or unique-ish prefix) rather than a git range. */
export function isSessionTarget(cwd: string, target: string): boolean {
  if (target.includes('..')) return false;
  // Prefixes need 4+ characters, so a stray question word like "a" or "be" is never taken for a session.
  return listSessions(cwd).some((s) => s.sessionId === target || (target.length >= 4 && s.sessionId.startsWith(target)));
}

/** The session's code at the end of its last turn that has a snapshot, else the HEAD it ended on. */
export function sessionCode(cwd: string, turns: Turn[]): Scope['code'] {
  for (const t of [...turns].reverse()) {
    const tree = t.meta?.stateAfter;
    if (tree && gitMaybe(['cat-file', '-e', `${tree}^{tree}`], { cwd }) !== null) return { rev: tree, label: `the code at the end of turn ${t.index}` };
    const head = t.meta?.headAfter;
    if (head && gitMaybe(['cat-file', '-e', `${head}^{commit}`], { cwd }) !== null) return { rev: head, label: `commit ${head.slice(0, 8)} (after turn ${t.index})` };
  }
  return undefined;
}

/** A session id/prefix, a range `base..head`, a single ref (compared to main/master), or nothing (HEAD vs main). */
export function resolveScope(cwd: string, target?: string): Scope {
  if (target && isSessionTarget(cwd, target)) {
    const id = resolveSessionId(cwd, target);
    const session = loadSession(cwd, id);
    if (!session || !session.turns.length) throw new Error(`session ${id.slice(0, 8)} has no turns`);
    return { label: `session ${id.slice(0, 8)}`, sessions: [{ session, turns: session.turns }], code: sessionCode(cwd, session.turns) };
  }
  const { base, head } = parseRange(cwd, target);
  const review = assembleReview(cwd, base, head);
  const sessions = review.slices.flatMap((sl) => {
    const session = review.sessions[sl.sessionId];
    const turns = session?.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn) ?? [];
    return session && turns.length ? [{ session, turns }] : [];
  });
  if (!sessions.length) throw new Error(`no captured conversations behind ${base}..${head} (pass a session id or another range; see \`promptlog ls\`)`);
  const sha = gitMaybe(['rev-parse', '--verify', '-q', `${head}^{commit}`], { cwd });
  return { label: `${base}..${head}`, sessions, ...(sha ? { code: { rev: sha, label: `${head} (${sha.slice(0, 8)})` } } : {}) };
}
