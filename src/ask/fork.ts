// fork(): continue a conversation from turn N in a new worktree on a new branch.
//
// Unlike ask worktrees, fork worktrees live OUTSIDE .git: Claude Code gates every edit under a `.git/` path behind a
// manual approval (even in acceptEdits mode), which would make an interactive fork unusable. Default location is a
// sibling of the main worktree: <main-root>-fork-<sid8>-t<N>.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { childClaudeEnv } from '../core/claude.ts';
import { gitMaybe, repoRoot } from '../core/git.ts';
import { readStoredSession } from '../core/store.ts';
import { materialize, type StateSource } from './materialize.ts';
import { buildResumeTranscript, writeTranscript } from './resume.ts';
import { commonGitDir, resolveSessionId } from './session.ts';

export const FORK_MARKER_FILE = 'fork.json';

/**
 * Written to <worktree-git-dir>/promptlog/fork.json (= `localDir(worktreeRoot)` + fork.json). Capture can read it
 * when a session starts in that worktree and set SessionMeta.parent. It is removed with the worktree.
 */
export interface ForkMarker {
  schema: 1;
  parent: { sessionId: string; turn: number };
  /**
   * promptUuid of the parent's turn N. `--fork-session` keeps message uuids, so a session whose transcript contains
   * this uuid is the fork (and its first N turns are copies of the parent's).
   */
  parentPromptUuid?: string;
  transcriptPath: string;
  branch: string;
  commit: string;
  source: StateSource;
  createdAt: string;
}

export function forkMarkerPath(worktreeGitDir: string): string {
  return join(worktreeGitDir, 'promptlog', FORK_MARKER_FILE);
}

/** The fork marker for the worktree containing `cwd`, if it was created by `pl fork`. */
export function readForkMarker(cwd: string): ForkMarker | null {
  const dir = gitMaybe(['rev-parse', '--absolute-git-dir'], { cwd });
  if (!dir) return null;
  const p = forkMarkerPath(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ForkMarker;
  } catch {
    return null;
  }
}

export interface ForkOptions {
  /** Any directory inside the repo. */
  cwd: string;
  /** Full session id or a unique prefix. */
  sessionId: string;
  turn: number;
  /** Default: promptlog/fork-<sid8>-t<N>. */
  branch?: string;
  /** Default: <main-worktree-root>-fork-<sid8>-t<N>. */
  dir?: string;
  /** Model for the printed/launched `claude` command. */
  model?: string;
}

export interface ForkResult {
  sessionId: string;
  turn: number;
  branch: string;
  /** Worktree root. */
  root: string;
  /** Directory to run claude in (root + the session's repo-relative cwd). */
  cwd: string;
  commit: string;
  source: StateSource;
  transcriptPath: string;
  markerPath: string;
  /** True when .claude/settings.local.json (e.g. repo-local promptlog hooks) was copied into the fork worktree. */
  copiedLocalSettings: boolean;
  /** argv to run in `cwd`. */
  command: string[];
  /** Copy-pasteable shell line: `cd <cwd> && claude --resume <path> --fork-session`. */
  commandLine: string;
}

export function defaultForkBranch(sessionId: string, turn: number): string {
  return `promptlog/fork-${sessionId.slice(0, 8)}-t${turn}`;
}

export function defaultForkDir(cwd: string, sessionId: string, turn: number): string {
  const common = commonGitDir(cwd);
  const main = basename(common) === '.git' ? dirname(common) : (repoRoot(cwd) ?? resolve(common, '..'));
  return `${main}-fork-${sessionId.slice(0, 8)}-t${turn}`;
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function fork(opts: ForkOptions): ForkResult {
  const sessionId = resolveSessionId(opts.cwd, opts.sessionId);
  const branch = opts.branch ?? defaultForkBranch(sessionId, opts.turn);
  if (gitMaybe(['check-ref-format', '--branch', branch], { cwd: opts.cwd }) === null) throw new Error(`invalid branch name: ${branch}`);
  if (gitMaybe(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: opts.cwd }) !== null) {
    throw new Error(`branch ${branch} already exists (pass --branch <name>, or delete it)`);
  }
  const dir = resolve(opts.dir ?? defaultForkDir(opts.cwd, sessionId, opts.turn));
  if (existsSync(dir)) throw new Error(`directory already exists: ${dir} (pass --dir <path>)`);

  const session = readStoredSession(opts.cwd, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  mkdirSync(dirname(dir), { recursive: true });
  const m = materialize({ cwd: opts.cwd, sessionId, turn: opts.turn, dir, branch, hooks: true, session });
  try {
    const transcriptPath = join(m.gitDir, 'promptlog', `fork-${sessionId}-t${opts.turn}.jsonl`);
    writeTranscript(transcriptPath, buildResumeTranscript(session, opts.turn, m.root).lines);

    const marker: ForkMarker = {
      schema: 1,
      parent: { sessionId, turn: opts.turn },
      ...(m.turnMeta.promptUuid ? { parentPromptUuid: m.turnMeta.promptUuid } : {}),
      transcriptPath,
      branch,
      commit: m.commit,
      source: m.source,
      createdAt: new Date().toISOString(),
    };
    const markerPath = forkMarkerPath(m.gitDir);
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');

    // Repo-local hooks live in the (normally gitignored) .claude/settings.local.json, so the snapshot doesn't carry
    // them. Copy it so the fork gets captured too.
    let copiedLocalSettings = false;
    const here = repoRoot(opts.cwd);
    const src = here ? join(here, '.claude', 'settings.local.json') : '';
    const dst = join(m.root, '.claude', 'settings.local.json');
    if (src && existsSync(src) && !existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copiedLocalSettings = true;
    }

    const command = ['claude', '--resume', transcriptPath, '--fork-session', ...(opts.model ? ['--model', opts.model] : [])];
    return {
      sessionId,
      turn: opts.turn,
      branch,
      root: m.root,
      cwd: m.cwd,
      commit: m.commit,
      source: m.source,
      transcriptPath,
      markerPath,
      copiedLocalSettings,
      command,
      commandLine: `cd ${shq(m.cwd)} && ${command.map(shq).join(' ')}`,
    };
  } catch (err) {
    m.cleanup({ deleteBranch: true });
    throw err;
  }
}

/** Launch the interactive fork (stdio inherited). Resolves with claude's exit code. */
export function execFork(f: ForkResult): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const [cmd, ...args] = f.command as [string, ...string[]];
    const child = spawn(cmd, args, { cwd: f.cwd, stdio: 'inherit', env: childClaudeEnv() });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
