// Worker thread body for ./run.ts: runs the (synchronous) runClaudeJson off the main thread, so a viewer
// serving HTTP keeps answering while a summary is generated.
import { parentPort, workerData } from 'node:worker_threads';
import { runClaudeJson, type RunClaudeOpts } from '../core/claude.ts';

try {
  parentPort!.postMessage({ ok: true, result: runClaudeJson(workerData as RunClaudeOpts) });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
