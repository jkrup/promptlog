// ask(): answer a reviewer's question against the conversation + repo state at a turn.
//   1. materialize turn N's state into a throwaway worktree (under <git-common-dir>/promptlog/worktrees/)
//   2. write the transcript up to turn N, paths rewritten to the worktree
//   3. `claude -p --resume <path> --fork-session` with read-only tools, hooks off, reviewer framing
//   4. persist the Q&A to refs/promptlog/asks/<sessionId>, remove the worktree
import { join } from 'node:path';
import { buildResumeTranscript, writeTranscript } from './resume.ts';
import { materialize, type Materialized } from './materialize.ts';
import { newAskId, saveAsk, type StoredAsk } from './asks.ts';
import { runClaudeJsonAsync, type ClaudeRunner } from './run.ts';
import { gitIdentity, resolveSessionId } from './session.ts';

/** Tools the answering Claude may use. Everything else is denied (`--permission-mode dontAsk`). */
export const ASK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
export const ASK_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(cat:*)'];
export const ASK_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

export function askSystemPrompt(turn: number, sessionId: string): string {
  return [
    `You are answering a code reviewer's question about the state at turn ${turn} of this conversation (session ${sessionId.slice(0, 8)}).`,
    `- The conversation above is the author's Claude Code session up to and including turn ${turn}. Anything after that has not happened yet from your point of view.`,
    `- Your working directory is a temporary git worktree restored to exactly how the repository looked at the end of turn ${turn}, uncommitted changes included. File paths in the conversation were rewritten to point here.`,
    '- The next message comes from a reviewer, not the original author. Answer about the code and conversation as they are at this point, not how they might end up.',
    '- Look at the files when the question is about code, and cite paths and line numbers. Be concise and direct.',
    '- Just answer. Do not offer to make changes or ask follow-up questions; the reviewer cannot reply in this thread.',
    '- Do not modify files or run anything that changes state. You only have read-only tools.',
  ].join('\n');
}

/** The message sent as the next user turn. The stored question stays the reviewer's raw text. */
export function askPrompt(question: string, turn: number): string {
  return `[Reviewer question about the state at turn ${turn}. Answer it; do not change anything or offer to.]\n\n${question}`;
}

/** Flags for the answering `claude -p` run (after `-p --output-format json [--model m]`). */
export function askClaudeArgs(transcriptPath: string, turn: number, sessionId: string): string[] {
  return [
    '--resume', transcriptPath,
    '--fork-session',
    '--tools', ASK_TOOLS.join(','),
    '--allowedTools', ASK_ALLOWED_TOOLS.join(','),
    '--disallowedTools', ASK_DISALLOWED_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    // Hooks off: the ask must not be captured as a new session by promptlog's own hooks (or trigger any others).
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--append-system-prompt', askSystemPrompt(turn, sessionId),
  ];
}

export interface AskOptions {
  /** Any directory inside the repo. */
  cwd: string;
  /** Full session id or a unique prefix. */
  sessionId: string;
  turn: number;
  question: string;
  model?: string;
  /** Keep the worktree after answering (its path is returned as `worktree`). */
  keep?: boolean;
  /** Persist to refs/promptlog/asks/<sessionId>. Default true. */
  save?: boolean;
  /** Override "Name <email>" of the asker. Default: local git identity. */
  askedBy?: string;
  timeoutMs?: number;
  /** Injected Claude runner (tests). Default: async `claude -p`. */
  runner?: ClaudeRunner;
}

export interface AskRun extends StoredAsk {
  /** Worktree path when `keep` was set. Local only; never persisted. */
  worktree?: string;
  /** Resume transcript path when `keep` was set. */
  transcriptPath?: string;
}

export async function ask(opts: AskOptions): Promise<AskRun> {
  const question = opts.question.trim();
  if (!question) throw new Error('empty question');
  const sessionId = resolveSessionId(opts.cwd, opts.sessionId);
  const m: Materialized = materialize({ cwd: opts.cwd, sessionId, turn: opts.turn });
  try {
    const transcriptPath = join(m.gitDir, 'promptlog', `resume-${sessionId}-t${opts.turn}.jsonl`);
    writeTranscript(transcriptPath, buildResumeTranscript(m.session, opts.turn, m.root).lines);
    const askedAt = new Date().toISOString();
    const res = await (opts.runner ?? runClaudeJsonAsync)({
      cwd: m.cwd,
      prompt: askPrompt(question, opts.turn),
      model: opts.model,
      args: askClaudeArgs(transcriptPath, opts.turn, sessionId),
      timeoutMs: opts.timeoutMs,
    });
    if (res.is_error || typeof res.result !== 'string') throw new Error(`claude failed: ${String(res.result ?? res.subtype ?? 'no result').slice(0, 2000)}`);
    const askedBy = opts.askedBy ?? gitIdentity(opts.cwd);
    const stored: StoredAsk = {
      schema: 1,
      id: newAskId(askedAt),
      sessionId,
      turn: opts.turn,
      question,
      answer: res.result.trim(),
      forkSessionId: res.session_id,
      askedAt,
      ...(askedBy ? { askedBy } : {}),
      ...(typeof res.total_cost_usd === 'number' ? { costUsd: res.total_cost_usd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      state: { source: m.source, commit: m.commit, tree: m.tree },
    };
    if (opts.save !== false) saveAsk(opts.cwd, stored);
    return opts.keep ? { ...stored, worktree: m.root, transcriptPath } : stored;
  } finally {
    if (!opts.keep) m.cleanup();
  }
}
