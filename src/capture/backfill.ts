// Backfill: bring in the Claude Code sessions a repo already has on this machine, so review works from day one.
// Claude Code keeps each folder's transcripts in ~/.claude/projects/<folder path with every non-alphanumeric as "-">/.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gitMaybe } from '../core/git.ts';
import { captureSession, readStoredSession } from '../core/store.ts';
import { isValidSessionId, subagentFiles } from './hook.ts';
import { repoRedactor } from './redact.ts';
import type { CaptureState } from './state.ts';

export interface ImportResult {
  sessionId: string;
  turns: number;
  subagents: number;
  commit: string;
}

/** Import one transcript into the repo at `root` (also what `promptlog import` does). Null when it has no prompts. */
export function importTranscript(root: string, file: string, sessionId = basename(file).replace(/\.jsonl$/, ''), onWarning?: (msg: string) => void): ImportResult | null {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  const transcriptPath = resolve(file);
  // Subagent transcripts live in <dir>/<session-id>/subagents/*.jsonl next to the main transcript.
  const subDir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
  const state: CaptureState = { sessionId, transcriptPath, startedAt: new Date().toISOString() };
  if (existsSync(subDir)) state.subagents = readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ path: join(subDir, f) }));
  const redact = repoRedactor(root, onWarning);
  const res = captureSession({ root, sessionId, transcriptPath, redact, extraFiles: subagentFiles(state, transcriptPath) });
  return res ? { sessionId, turns: res.turnCount, subagents: state.subagents?.length ?? 0, commit: res.commit } : null;
}

/** Claude Code's transcript folder for a working directory. */
export function claudeProjectDir(path: string, home = homedir()): string {
  return join(home, '.claude', 'projects', path.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Every worktree of the repo (the main checkout included). */
export function worktreePaths(root: string): string[] {
  const out = gitMaybe(['worktree', 'list', '--porcelain'], { cwd: root }) ?? '';
  const paths = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  return paths.length ? paths : [root];
}

export interface BackfillResult {
  sessions: number;
  turns: number;
  commitsLinked: number;
  skipped: string[];
}

/** Import every Claude Code session recorded in any of the repo's worktrees. Safe to repeat: imports are idempotent. */
export function backfill(root: string, opts: { home?: string; onWarning?: (msg: string) => void } = {}): BackfillResult {
  const result: BackfillResult = { sessions: 0, turns: 0, commitsLinked: 0, skipped: [] };
  for (const wt of worktreePaths(root)) {
    const dir = claudeProjectDir(wt, opts.home);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const file = join(dir, f);
      try {
        const res = importTranscript(root, file, undefined, opts.onWarning);
        if (!res) continue;
        result.sessions++;
        result.turns += res.turns;
        const stored = readStoredSession(root, res.sessionId);
        result.commitsLinked += stored ? new Set(stored.turns.flatMap((t) => t.meta.commits)).size : 0;
      } catch (err) {
        result.skipped.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}
