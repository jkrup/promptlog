// Claude Code hook handler. Must never break the user's session: all errors are logged and swallowed.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, headSha, repoRoot } from '../core/git.ts';
import { captureSession, localDir, readLocalState, relCwd, snapshotWorktree, writeLocalState, type LocalSessionState } from '../core/store.ts';

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  last_assistant_message?: string;
  source?: string;
  reason?: string;
}

function baseState(p: Required<Pick<HookPayload, 'session_id' | 'transcript_path'>>): LocalSessionState {
  return { sessionId: p.session_id, transcriptPath: p.transcript_path, startedAt: new Date().toISOString() };
}

export function handleHook(event: string, payload: HookPayload): void {
  const cwd = payload.cwd ?? process.cwd();
  const root = repoRoot(cwd);
  if (!root || !payload.session_id || !payload.transcript_path) return;
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  const now = new Date().toISOString();
  let state = readLocalState(root, sessionId) ?? baseState({ session_id: sessionId, transcript_path: transcriptPath });
  state.transcriptPath = transcriptPath;
  state.lastActivityAt = now;

  try {
    switch (event) {
      case 'SessionStart':
        state.ended = false;
        break;
      case 'UserPromptSubmit':
        state.pending = { startedAt: now, headBefore: headSha(root), stateBefore: snapshotWorktree(root, sessionId), branch: currentBranch(root) };
        break;
      case 'Stop': {
        const res = captureSession({
          root,
          sessionId,
          transcriptPath,
          cwd: relCwd(root, cwd),
          current: { pending: state.pending, stateAfter: snapshotWorktree(root, sessionId), headAfter: headSha(root), endedAt: now },
        });
        state.pending = undefined;
        if (res) state.turnsSinceCommit = [...new Set([...(state.turnsSinceCommit ?? []), res.currentTurn])];
        break;
      }
      case 'SessionEnd':
        captureSession({ root, sessionId, transcriptPath, cwd: relCwd(root, cwd), sessionPatch: { endedAt: now } });
        state.ended = true;
        break;
      default:
        break;
    }
  } finally {
    writeLocalState(root, state);
  }
}

export function logHookError(cwd: string | undefined, event: string, err: unknown): void {
  try {
    const root = repoRoot(cwd ?? process.cwd());
    if (!root) return;
    const msg = `${new Date().toISOString()} ${event} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    appendFileSync(join(localDir(root), 'errors.log'), msg);
  } catch {
    // nothing else we can do
  }
}
