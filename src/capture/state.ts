// Capture-side local state (<git-dir>/promptlog/sessions/<id>.json) and a per-session lock.
// Hooks for one session can overlap (a background subagent's SubagentStop during the main Stop, a git commit hook while
// a turn is captured), so every read-modify-write of a session's state goes through `withSessionLock`.
import { closeSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { localDir, readLocalState, type LocalSessionState } from '../core/store.ts';

export interface SubagentRecord {
  /** Absolute path of the subagent transcript (`agent_transcript_path`). */
  path: string;
  agentId?: string;
  /** Turn the subagent belongs to, once resolved. */
  turn?: number;
}

/** LocalSessionState plus fields only capture uses. All additions are optional, so older files still load. */
export interface CaptureState extends LocalSessionState {
  /** Turn number written by the last capture. */
  lastTurn?: number;
  /** Subagent transcripts to store with their turn; kept while that turn can still be rewritten. */
  subagents?: SubagentRecord[];
}

export function readCaptureState(root: string, sessionId: string): CaptureState | null {
  return readLocalState(root, sessionId) as CaptureState | null;
}

/** Same file as core's writeLocalState, written atomically so a concurrent reader never sees a partial file. */
export function writeCaptureState(root: string, state: CaptureState): void {
  const file = join(localDir(root), 'sessions', `${state.sessionId}.json`);
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
  renameSync(file + '.tmp', file);
}

export function removeCaptureState(root: string, sessionId: string): void {
  rmSync(join(localDir(root), 'sessions', `${sessionId}.json`), { force: true });
}

/** Session ids with local state in this worktree. */
export function localSessionIds(root: string): string[] {
  const dir = join(localDir(root), 'sessions');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

export interface LockOpts {
  timeoutMs?: number;
  /** A lock older than this is assumed to belong to a crashed process and is broken. */
  staleMs?: number;
}

/** Run `fn` holding an exclusive lock file. Throws if the lock can't be taken within `timeoutMs`. */
export function withLock<T>(lockPath: string, fn: () => T, opts: LockOpts = {}): T {
  const timeout = opts.timeoutMs ?? 20_000;
  const stale = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeout;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > stale) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export function withSessionLock<T>(root: string, sessionId: string, fn: () => T, opts?: LockOpts): T {
  return withLock(join(localDir(root), 'sessions', `${sessionId}.lock`), fn, opts);
}
