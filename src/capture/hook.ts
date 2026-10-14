// Claude Code hook handler. Must never break the user's session: all errors are logged and swallowed.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { currentBranch, headSha, repoRoot } from '../core/git.ts';
import { captureSession, diffTrees, localDir, relCwd, snapshotWorktree, type CaptureResult, type CurrentTurnInfo } from '../core/store.ts';
import type { SessionMeta } from '../core/types.ts';
import { isHumanPrompt, parseEntry } from '../core/transcript.ts';
import { forkParent, type ForkMarkerReader } from './fork.ts';
import { repoRedactor } from './redact.ts';
import { startMirror } from './mirror.ts';
import { claim, refusalMessage, release, renew, toolTargets } from './leases.ts';
import { readCaptureState, withSessionLock, writeCaptureState, type CaptureState, type SubagentRecord } from './state.ts';

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  last_assistant_message?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
  /** PreToolUse */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** SubagentStop */
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

export interface HookOptions {
  /** Snapshot size limit per file; default MAX_SNAPSHOT_FILE_BYTES. */
  maxFileBytes?: number;
  /** Reads `promptlog fork`'s marker (src/ask); when given, captures in a fork worktree record SessionMeta.parent. */
  readForkMarker?: ForkMarkerReader;
}

/** Session ids end up in file names and ref names, so only accept a conservative charset. */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..') && !id.endsWith('.lock');
}

function baseState(sessionId: string, transcriptPath: string): CaptureState {
  return { sessionId, transcriptPath, startedAt: new Date().toISOString() };
}

export function handleHook(event: string, payload: HookPayload, opts: HookOptions = {}): void {
  const cwd = payload.cwd ?? process.cwd();
  if (!existsSync(cwd)) return;
  const root = repoRoot(cwd);
  // Never capture outside a git work tree, or without the fields we need.
  if (!root || !payload.session_id || !payload.transcript_path) return;
  if (!isValidSessionId(payload.session_id)) throw new Error(`refusing unsafe session id ${JSON.stringify(payload.session_id.slice(0, 80))}`);
  const sessionId = payload.session_id;
  withSessionLock(root, sessionId, () => handleLocked(event, payload, { root, cwd, sessionId, transcriptPath: payload.transcript_path! }, opts));
}

interface Ctx {
  root: string;
  cwd: string;
  sessionId: string;
  transcriptPath: string;
}

function handleLocked(event: string, payload: HookPayload, ctx: Ctx, opts: HookOptions): void {
  const { root, sessionId, transcriptPath } = ctx;
  const now = new Date().toISOString();
  const state = readCaptureState(root, sessionId) ?? baseState(sessionId, transcriptPath);
  state.transcriptPath = transcriptPath;
  state.lastActivityAt = now;
  const snapshot = () =>
    snapshotWorktree(root, sessionId, {
      maxFileBytes: opts.maxFileBytes,
      onSkipped: (paths) => logError(root, event, `skipped ${paths.length} file(s) over the snapshot size limit: ${paths.slice(0, 5).join(', ')}`),
    });

  try {
    switch (event) {
      case 'SessionStart':
        state.ended = false;
        break;
      case 'UserPromptSubmit':
        state.pending = { startedAt: now, headBefore: headSha(root), stateBefore: snapshot(), branch: currentBranch(root) };
        if (payload.prompt) state.ask = repoRedactor(root)(firstLineOf(payload.prompt)).slice(0, 160);
        leaseSafe(root, event, () => renew(root, sessionId));
        break;
      case 'SubagentStop': {
        const p = payload.agent_transcript_path;
        if (p) {
          const subs = (state.subagents ??= []);
          if (!subs.some((s) => s.path === p)) subs.push({ path: p, ...(payload.agent_id ? { agentId: payload.agent_id } : {}) });
        }
        break;
      }
      case 'Stop': {
        const headAfter = headSha(root);
        const committed = !!state.pending && !!headAfter && state.pending.headBefore !== headAfter;
        const stateAfter = snapshot();
        // Every file this turn changed is claimed, even if the edit-time check couldn't see it (unusual Bash).
        const before = state.pending?.stateBefore;
        if (before && stateAfter && before !== stateAfter) {
          const changed = diffTrees(root, before, stateAfter).map((f) => f.path);
          if (changed.length) leaseSafe(root, event, () => claim(root, holderOf(root, sessionId, state), changed, { force: true }));
        }
        const res = capture(ctx, state, event, opts, { pending: state.pending, stateAfter, headAfter, endedAt: now });
        if (res) {
          state.pending = undefined;
          state.turnsSinceCommit = [...new Set([...(state.turnsSinceCommit ?? []), res.currentTurn])];
          // The commit's own push ran mid-turn; this one carries the conversation of the turn that made it.
          if (committed) startMirror(root);
        }
        break;
      }
      case 'SessionEnd': {
        // A turn that never got a Stop (e.g. interrupted) still has its pending snapshot: close it now.
        const current = state.pending ? { pending: state.pending, stateAfter: snapshot(), headAfter: headSha(root), endedAt: now } : undefined;
        const res = capture(ctx, state, event, opts, current, { endedAt: now });
        if (res && current) {
          state.pending = undefined;
          state.turnsSinceCommit = [...new Set([...(state.turnsSinceCommit ?? []), res.currentTurn])];
        }
        state.ended = true;
        leaseSafe(root, event, () => release(root, sessionId));
        rmSync(join(localDir(root), `index-${sessionId}`), { force: true }); // temp snapshot index; rebuilt if the session resumes
        break;
      }
      default:
        break;
    }
  } finally {
    writeCaptureState(root, state);
  }
}

function capture(ctx: Ctx, state: CaptureState, event: string, opts: HookOptions, current: CurrentTurnInfo | undefined, patch: Partial<SessionMeta> = {}): CaptureResult | null {
  const { root, cwd, sessionId, transcriptPath } = ctx;
  const redact = repoRedactor(root, (msg) => logError(root, event, msg));
  const extraFiles = subagentFiles(state, transcriptPath);
  const sessionPatch: Partial<SessionMeta> = { ...patch };
  if (opts.readForkMarker) {
    try {
      const parent = forkParent(opts.readForkMarker, root, transcriptPath);
      if (parent) sessionPatch.parent = parent;
    } catch (err) {
      logError(root, event, `fork marker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const res = captureSession({ root, sessionId, transcriptPath, cwd: relCwd(root, cwd), current, redact, extraFiles, sessionPatch });
  if (res) {
    state.lastTurn = res.currentTurn;
    // Keep subagent files only while their turn can still be rewritten (the last two turns).
    if (state.subagents) {
      state.subagents = state.subagents.filter((s) => s.turn === undefined || s.turn >= res.currentTurn - 1);
      if (state.subagents.length === 0) delete state.subagents;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/** `promptId` of the first entry that has one. Claude Code tags every entry of a turn, including subagent entries. */
function firstPromptId(lines: string[]): string | undefined {
  for (const line of lines) {
    const e = parseEntry(line) as { promptId?: unknown } | null;
    if (e && typeof e.promptId === 'string') return e.promptId;
  }
  return undefined;
}

/** Turn number (1-based) of each human prompt's promptId, plus the total number of turns. */
export function promptTurns(lines: string[]): { byPromptId: Map<string, number>; turns: number } {
  const byPromptId = new Map<string, number>();
  let turns = 0;
  for (const line of lines) {
    if (!line.includes('"user"')) continue; // cheap prefilter: only user entries can be prompts
    const e = parseEntry(line);
    if (!e || !isHumanPrompt(e)) continue;
    turns++;
    const pid = (e as { promptId?: unknown }).promptId;
    if (typeof pid === 'string' && !byPromptId.has(pid)) byPromptId.set(pid, turns);
  }
  return { byPromptId, turns };
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()) : [];
}

/**
 * Resolve recorded subagent transcripts to turns and load them as `CaptureInput.extraFiles`
 * (`subagents/<file>.jsonl`, plus the `<file>.meta.json` Claude Code writes next to it).
 * A subagent belongs to the turn whose prompt has the same `promptId`; without one it goes to the latest turn.
 */
export function subagentFiles(state: CaptureState, transcriptPath: string): Map<number, Record<string, string>> | undefined {
  const subs = state.subagents?.filter((s) => existsSync(s.path));
  if (!subs?.length) return undefined;
  let index: ReturnType<typeof promptTurns> | undefined;
  const files = new Map<number, Record<string, string>>();
  for (const s of subs) {
    const content = readFileSync(s.path, 'utf8');
    if (s.turn === undefined) {
      index ??= promptTurns(readLines(transcriptPath));
      const pid = firstPromptId(content.split('\n', 20));
      const turn = (pid && index.byPromptId.get(pid)) || index.turns;
      if (turn < 1) continue;
      s.turn = turn;
    }
    const entry = files.get(s.turn) ?? {};
    const name = basename(s.path);
    entry[`subagents/${name}`] = content;
    const metaPath = join(dirname(s.path), name.replace(/\.jsonl$/, '') + '.meta.json');
    if (metaPath !== s.path && existsSync(metaPath)) entry[`subagents/${basename(metaPath)}`] = readFileSync(metaPath, 'utf8');
    files.set(s.turn, entry);
  }
  return files.size ? files : undefined;
}

export type { SubagentRecord };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 1024 * 1024;

function logError(root: string, event: string, msg: string): void {
  try {
    const file = join(localDir(root), 'errors.log');
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1');
    appendFileSync(file, `${new Date().toISOString()} ${event} ${msg}\n`);
  } catch {
    // nothing else we can do
  }
}

export function logHookError(cwd: string | undefined, event: string, err: unknown): void {
  try {
    const dir = cwd && existsSync(cwd) ? cwd : process.cwd();
    const root = repoRoot(dir);
    if (!root) return;
    logError(root, event, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } catch {
    // nothing else we can do
  }
}

// ---------------------------------------------------------------------------
// Leases (src/capture/leases.ts)
// ---------------------------------------------------------------------------

const firstLineOf = (s: string) => s.replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

function holderOf(root: string, sessionId: string, state: CaptureState | null) {
  return { sessionId, branch: currentBranch(root), worktree: root, ...(state?.ask ? { ask: state.ask } : {}) };
}

function leaseSafe(root: string, event: string, fn: () => unknown): void {
  if (process.env.PL_LEASES === 'off') return;
  try {
    fn();
  } catch (err) {
    logError(root, event, `leases: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Hook output that tells Claude Code to refuse a tool call, with the reason the agent will read. */
export interface PreToolUseOutput {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
}

/**
 * PreToolUse (Edit/Write/MultiEdit/NotebookEdit/Bash): claim the files the call is about to change, or refuse the call
 * when another live agent session holds one of them. Never throws; returns null to let the call through.
 */
export function preToolUse(payload: HookPayload): PreToolUseOutput | null {
  if (process.env.PL_LEASES === 'off') return null;
  const cwd = payload.cwd ?? process.cwd();
  try {
    if (!existsSync(cwd) || !payload.session_id || !isValidSessionId(payload.session_id) || !payload.tool_name) return null;
    const root = repoRoot(cwd);
    if (!root) return null;
    const targets = toolTargets(root, cwd, payload.tool_name, payload.tool_input);
    if (!targets.length) return null;
    const { refused } = claim(root, holderOf(root, payload.session_id, readCaptureState(root, payload.session_id)), targets);
    if (!refused.length) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusalMessage(refused) } };
  } catch (err) {
    logHookError(cwd, 'PreToolUse', err);
    return null;
  }
}
