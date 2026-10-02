// Commit trailers: `Promptlog: <sessionId>#<turn>` on commits made while sessions in this worktree have uncommitted turns.
// Driven by git hooks installed by `promptlog install` (see githooks.ts):
//   prepare-commit-msg -> addTrailers      append one trailer per session (idempotent, so amend doesn't duplicate)
//   commit-msg         -> stripIfOnlyTrailers  let git abort an otherwise empty message
//   post-commit        -> clearAfterCommit     reset turnsSinceCommit
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git, gitMaybe } from '../core/git.ts';
import { promptTurns } from './hook.ts';
import { localSessionIds, readCaptureState, removeCaptureState, withSessionLock, writeCaptureState } from './state.ts';

export const TRAILER_KEY = 'Promptlog';
/** A pending (in-progress) turn older than this is assumed abandoned and no longer tags commits. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface TrailerRef {
  sessionId: string;
  turn: number;
}

export const formatTrailer = (t: TrailerRef) => `${TRAILER_KEY}: ${t.sessionId}#${t.turn}`;

/** True while git is replaying commits (rebase, cherry-pick, revert): those keep their own messages. */
export function inSequenceOperation(root: string): boolean {
  const out = gitMaybe(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD'], { cwd: root });
  if (!out) return false;
  return out.split('\n').some((p) => p && existsSync(isAbsolute(p) ? p : join(root, p)));
}

/**
 * One trailer per session in this worktree that has turns since the last commit, or a turn in progress.
 * The turn is the latest such turn.
 */
export function pendingTrailers(root: string, now = Date.now()): TrailerRef[] {
  const out: TrailerRef[] = [];
  for (const id of localSessionIds(root).sort()) {
    const st = readCaptureState(root, id);
    if (!st) continue;
    const turns = [...(st.turnsSinceCommit ?? [])];
    const p = st.pending;
    if (p && !st.ended && now - Date.parse(p.startedAt) < PENDING_MAX_AGE_MS) {
      // The commit is being made during a turn: that turn is the prompt count in the transcript right now.
      const lines = existsSync(st.transcriptPath) ? readFileSync(st.transcriptPath, 'utf8').split('\n') : [];
      const inProgress = promptTurns(lines).turns || (st.lastTurn ?? 0) + 1;
      turns.push(inProgress);
    }
    if (turns.length) out.push({ sessionId: id, turn: Math.max(...turns) });
  }
  return out;
}

/** prepare-commit-msg: append trailers to the message file. Returns the trailers that were requested. */
export function addTrailers(root: string, msgFile: string, source?: string): TrailerRef[] {
  if (source === 'merge' || inSequenceOperation(root)) return [];
  const trailers = pendingTrailers(root);
  if (trailers.length === 0) return [];
  const args = ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent'];
  for (const t of trailers) args.push('--trailer', formatTrailer(t));
  git([...args, msgFile], { cwd: root });
  return trailers;
}

function commentChar(root: string): string {
  const c = gitMaybe(['config', '--get', 'core.commentChar'], { cwd: root });
  return c && c !== 'auto' ? c : '#';
}

const TRAILER_LINE = new RegExp(`^${TRAILER_KEY}:\\s*\\S+#\\d+\\s*$`);

/**
 * commit-msg: if the message is nothing but our trailers (plus comments), remove them so git aborts the commit for an
 * empty message, as it would have without us. Returns true when it stripped something.
 */
export function stripIfOnlyTrailers(root: string, msgFile: string): boolean {
  const text = readFileSync(msgFile, 'utf8');
  const cc = commentChar(root);
  const lines = text.split('\n');
  const scissors = lines.findIndex((l) => l.startsWith(`${cc} ------------------------ >8 ------------------------`));
  const body = (scissors >= 0 ? lines.slice(0, scissors) : lines).filter((l) => !l.startsWith(cc));
  const hasOurs = body.some((l) => TRAILER_LINE.test(l));
  const hasContent = body.some((l) => l.trim() && !TRAILER_LINE.test(l));
  if (!hasOurs || hasContent) return false;
  writeFileSync(msgFile, lines.filter((l, i) => (scissors >= 0 && i >= scissors) || !TRAILER_LINE.test(l)).join('\n'));
  return true;
}

/** post-commit: the commit consumed the pending trailers. Ended sessions with nothing left are forgotten. */
export function clearAfterCommit(root: string): string[] {
  if (inSequenceOperation(root)) return [];
  const cleared: string[] = [];
  for (const id of localSessionIds(root)) {
    withSessionLock(
      root,
      id,
      () => {
        const st = readCaptureState(root, id);
        if (!st) return;
        if (st.turnsSinceCommit?.length) cleared.push(id);
        if (st.ended && !st.pending) {
          removeCaptureState(root, id);
          return;
        }
        if (!st.turnsSinceCommit?.length) return;
        st.turnsSinceCommit = [];
        writeCaptureState(root, st);
      },
      { timeoutMs: 5_000 },
    );
  }
  return cleared;
}
