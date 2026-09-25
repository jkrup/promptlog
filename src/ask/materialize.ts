// Materialize a turn's repo state into a git worktree. See docs/ask-fork.md.
//
// A snapshot is a tree, not a commit, so we wrap it in a synthetic commit whose parent is the HEAD at the end
// of the turn. That keeps `git log` / `git diff HEAD~1` meaningful inside the worktree. When the snapshot equals
// that HEAD's tree (nothing uncommitted), the real commit is checked out instead.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitMaybe } from '../core/git.ts';
import { readStoredSession, type StoredSession } from '../core/store.ts';
import type { TurnMeta } from '../core/types.ts';
import { commitExists, commonGitDir, PROMPTLOG_IDENT, treeExists } from './session.ts';

/** Where the state came from: turn N's `after` snapshot, turn N+1's `before` snapshot, or turn N's HEAD commit. */
export type StateSource = 'after' | 'next-before' | 'head-after';

export interface TurnState {
  tree: string;
  source: StateSource;
  /** Commit to hang the snapshot on (HEAD at the end of the turn, else at its start), when present locally. */
  parent?: string;
}

export interface StateLookup {
  hasTree(sha: string): boolean;
  hasCommit(sha: string): boolean;
  treeOf(commit: string): string | null;
}

/**
 * Pick the repo state at the end of `turn`: its `after` snapshot, else the next turn's `before` snapshot,
 * else the HEAD commit at the end of the turn. Pure given `lookup`, so it is unit-testable.
 */
export function pickTurnState(turns: TurnMeta[], turn: number, lookup: StateLookup): TurnState | null {
  const t = turns.find((m) => m.index === turn);
  if (!t) return null;
  const next = turns.find((m) => m.index === turn + 1);
  const parent = [t.headAfter, t.headBefore].find((c): c is string => !!c && lookup.hasCommit(c));
  if (t.stateAfter && lookup.hasTree(t.stateAfter)) return { tree: t.stateAfter, source: 'after', parent };
  if (next?.stateBefore && lookup.hasTree(next.stateBefore)) return { tree: next.stateBefore, source: 'next-before', parent };
  if (t.headAfter && lookup.hasCommit(t.headAfter)) {
    const tree = lookup.treeOf(t.headAfter);
    if (tree) return { tree, source: 'head-after', parent: t.headAfter };
  }
  return null;
}

export function gitStateLookup(cwd: string): StateLookup {
  return {
    hasTree: (sha) => treeExists(cwd, sha),
    hasCommit: (sha) => commitExists(cwd, sha),
    treeOf: (commit) => gitMaybe(['rev-parse', `${commit}^{tree}`], { cwd }),
  };
}

/** The commit to check out for a turn state: the parent itself when trees match, else a synthetic snapshot commit. */
export function snapshotCommit(cwd: string, sessionId: string, turn: number, state: TurnState, date?: string): string {
  if (state.parent && gitMaybe(['rev-parse', `${state.parent}^{tree}`], { cwd }) === state.tree) return state.parent;
  // Fixed identity + the turn's timestamp: materializing the same turn twice yields the same commit.
  const env: Record<string, string> = { ...PROMPTLOG_IDENT };
  if (date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = date;
  const msg = [
    `promptlog snapshot: session ${sessionId.slice(0, 8)} turn ${turn}`,
    '',
    `Working tree at the end of turn ${turn} (source: ${state.source}), including uncommitted changes.`,
    '',
    `Promptlog-Snapshot: ${sessionId}#${turn}`,
  ].join('\n');
  return git(['commit-tree', state.tree, ...(state.parent ? ['-p', state.parent] : []), '-m', msg], { cwd, env });
}

export interface MaterializeOptions {
  /** Any directory inside the repo. */
  cwd: string;
  sessionId: string;
  turn: number;
  /** Worktree directory. Default: <git-common-dir>/promptlog/worktrees/<sid8>-t<N>-<random>. */
  dir?: string;
  /** Create this branch at the snapshot commit. Default: detached HEAD. */
  branch?: string;
  /** Run the repo's checkout hooks. Default false (ephemeral worktrees shouldn't trigger post-checkout hooks). */
  hooks?: boolean;
  /** Pre-loaded session (avoids re-reading the ref). */
  session?: StoredSession;
}

export interface Materialized {
  sessionId: string;
  turn: number;
  /** Worktree root. */
  root: string;
  /** Where the agent ran: root + the session's repo-relative cwd. */
  cwd: string;
  /** Per-worktree git dir. promptlog keeps worktree-local files in <gitDir>/promptlog (removed with the worktree). */
  gitDir: string;
  commit: string;
  tree: string;
  source: StateSource;
  parent?: string;
  branch?: string;
  session: StoredSession;
  turnMeta: TurnMeta;
  /** Remove the worktree (and the branch, if `deleteBranch`). Safe to call twice. */
  cleanup(opts?: { deleteBranch?: boolean }): void;
}

export function worktreesDir(cwd: string): string {
  return join(commonGitDir(cwd), 'promptlog', 'worktrees');
}

export function materialize(opts: MaterializeOptions): Materialized {
  const { cwd, sessionId, turn } = opts;
  const session = opts.session ?? readStoredSession(cwd, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const metas = session.turns.map((t) => t.meta);
  const turnMeta = metas.find((m) => m.index === turn);
  if (!Number.isInteger(turn) || !turnMeta) throw new Error(`session ${sessionId.slice(0, 8)} has turns 1..${metas.length}; no turn ${turn}`);
  const state = pickTurnState(metas, turn, gitStateLookup(cwd));
  if (!state) throw new Error(`no repo state recorded for turn ${turn} of session ${sessionId.slice(0, 8)} (no snapshot and no HEAD commit available)`);

  const commit = snapshotCommit(cwd, sessionId, turn, state, turnMeta.endedAt);
  const dir = opts.dir ?? join(worktreesDir(cwd), `${sessionId.slice(0, 8)}-t${turn}-${randomBytes(3).toString('hex')}`);
  if (existsSync(dir)) throw new Error(`worktree directory already exists: ${dir}`);
  mkdirSync(join(dir, '..'), { recursive: true });

  const pre = opts.hooks ? [] : ['-c', 'core.hooksPath=/dev/null'];
  const target = opts.branch ? ['-b', opts.branch] : ['--detach'];
  git([...pre, 'worktree', 'add', '--quiet', ...target, dir, commit], { cwd });

  const wtGitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: dir });
  const rel = session.meta.cwd || '';
  const agentCwd = rel && isDir(join(dir, rel)) ? join(dir, rel) : dir;
  let removed = false;
  return {
    sessionId,
    turn,
    root: dir,
    cwd: agentCwd,
    gitDir: wtGitDir,
    commit,
    tree: state.tree,
    source: state.source,
    parent: state.parent,
    branch: opts.branch,
    session,
    turnMeta,
    cleanup(o = {}) {
      if (removed) return;
      removed = true;
      removeWorktree(cwd, dir);
      if (o.deleteBranch && opts.branch) gitMaybe(['branch', '-D', opts.branch], { cwd });
    },
  };
}

/** `git worktree remove --force`, falling back to rm + prune if git refuses (e.g. the dir is half gone). */
export function removeWorktree(cwd: string, dir: string): void {
  if (gitMaybe(['worktree', 'remove', '--force', dir], { cwd }) === null) {
    rmSync(dir, { recursive: true, force: true });
    gitMaybe(['worktree', 'prune'], { cwd });
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
