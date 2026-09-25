// Async `claude -p --output-format json`. Same contract as core's runClaudeJson (same args, childClaudeEnv, prompt on
// stdin) but non-blocking, because the viewer calls ask() from an HTTP handler and a sync spawn would freeze it.
import { spawn } from 'node:child_process';
import { childClaudeEnv, type ClaudeJsonResult, type RunClaudeOpts } from '../core/claude.ts';

export type ClaudeRunner = (opts: RunClaudeOpts) => Promise<ClaudeJsonResult>;

export const runClaudeJsonAsync: ClaudeRunner = (opts) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', ...(opts.model ? ['--model', opts.model] : []), ...(opts.args ?? [])];
    // childClaudeEnv strips the parent Claude Code session's vars: without it a nested run hijacks the parent session.
    const child = spawn('claude', args, { cwd: opts.cwd, env: childClaudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (timedOut) return reject(new Error(`claude timed out after ${opts.timeoutMs ?? 600_000}ms`));
      try {
        resolve(JSON.parse(stdout) as ClaudeJsonResult);
      } catch {
        const stderr = Buffer.concat(err).toString('utf8');
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`));
      }
    });
    child.stdin.on('error', () => {}); // EPIPE if claude exits early; reported via 'close'
    child.stdin.end(opts.prompt);
  });
