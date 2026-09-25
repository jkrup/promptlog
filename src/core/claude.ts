// Running the `claude` CLI headlessly (used by ask/fork/summarize).
import { spawnSync } from 'node:child_process';

/**
 * Env vars that tie a process to its *parent* Claude Code session. If `pl` itself runs inside Claude Code
 * (e.g. from its Bash tool) and we spawn `claude`, these would make the child reuse the parent's session id
 * and stream into the parent session. Always strip them for child runs.
 */
const PARENT_SESSION_VARS = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SYNC_SESSION_REFS', 'CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2', 'CLAUDE_CODE_TEE_SDK_STDOUT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_WORKER_EPOCH', 'CLAUDE_PID',
  'CLAUDE_CODE_SYNC_SKILLS',
];

export function childClaudeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of PARENT_SESSION_VARS) delete env[k];
  return { ...env, ...extra };
}

export interface ClaudeJsonResult {
  session_id: string;
  result: string;
  is_error?: boolean;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export interface RunClaudeOpts {
  cwd: string;
  prompt: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
}

/** `claude -p --output-format json` with the prompt on stdin. Throws on failure. */
export function runClaudeJson(opts: RunClaudeOpts): ClaudeJsonResult {
  const args = ['-p', '--output-format', 'json', ...(opts.model ? ['--model', opts.model] : []), ...(opts.args ?? [])];
  const res = spawnSync('claude', args, {
    cwd: opts.cwd,
    input: opts.prompt,
    env: childClaudeEnv(),
    timeout: opts.timeoutMs ?? 10 * 60_000,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.error) throw res.error;
  const out = res.stdout.toString('utf8');
  try {
    return JSON.parse(out) as ClaudeJsonResult;
  } catch {
    throw new Error(`claude exited ${res.status}: ${res.stderr.toString('utf8').slice(0, 2000) || out.slice(0, 2000)}`);
  }
}
