// Headless claude calls for summarize and eval. Always goes through core's runClaudeJson (which strips the
// parent session's env), inside a worker thread so callers get a real Promise.
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ClaudeJsonResult, RunClaudeOpts } from '../core/claude.ts';
import { extractJson } from './schema.ts';

export function runClaudeJsonAsync(opts: RunClaudeOpts): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./claude-worker.ts', import.meta.url), { workerData: opts });
    w.once('message', (m: { ok: boolean; result?: ClaudeJsonResult; error?: string }) => {
      if (m.ok && m.result) resolve(m.result);
      else reject(new Error(m.error ?? 'claude worker failed'));
    });
    w.once('error', reject);
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error(`claude worker exited with code ${code}`));
    });
  });
}

export interface StructuredCall {
  prompt: string;
  schema: object;
  model?: string;
  system: string;
  timeoutMs?: number;
}

export interface StructuredResult {
  output: unknown;
  costUsd?: number;
  durationMs?: number;
  /** Model id actually used (from modelUsage), e.g. claude-sonnet-5. */
  model?: string;
  usage?: unknown;
}

/**
 * One tool-less, hook-less, non-persisted claude call with structured output. Runs in a neutral cwd so the
 * user's project settings, CLAUDE.md and promptlog capture hooks never see (or record) the summarizer.
 */
export async function runStructured(call: StructuredCall): Promise<StructuredResult> {
  const args = (safeMode: boolean) => [
    '--json-schema', JSON.stringify(call.schema),
    '--tools', '',
    '--no-session-persistence',
    '--system-prompt', call.system,
    ...(safeMode ? ['--safe-mode'] : []),
  ];
  const base = { cwd: tmpdir(), prompt: call.prompt, model: call.model, timeoutMs: call.timeoutMs ?? 10 * 60_000 };
  let res: ClaudeJsonResult;
  try {
    res = await runClaudeJsonAsync({ ...base, args: args(true) });
  } catch (err) {
    // Older CLIs don't know --safe-mode; --tools '' and the neutral cwd still keep the run isolated.
    if (!/unknown option.*safe-mode/i.test(String(err))) throw err;
    res = await runClaudeJsonAsync({ ...base, args: args(false) });
  }
  if (res.is_error) throw new Error(`claude returned an error: ${String(res.result).slice(0, 500)}`);
  const output = (res as { structured_output?: unknown }).structured_output ?? extractJson(String(res.result ?? ''));
  if (output == null) throw new Error(`claude returned no structured output: ${String(res.result).slice(0, 500)}`);
  const usage = res.modelUsage as Record<string, { outputTokens?: number }> | undefined;
  const model = usage ? Object.entries(usage).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] : undefined;
  return {
    output,
    costUsd: typeof res.total_cost_usd === 'number' ? res.total_cost_usd : undefined,
    durationMs: typeof res.duration_ms === 'number' ? res.duration_ms : undefined,
    model,
    usage: res.usage,
  };
}
