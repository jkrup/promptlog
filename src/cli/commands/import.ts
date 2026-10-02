import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { repoRoot } from '../../core/git.ts';
import { captureSession } from '../../core/store.ts';
import { isValidSessionId, subagentFiles } from '../../capture/hook.ts';
import { repoRedactor } from '../../capture/redact.ts';
import type { CaptureState } from '../../capture/state.ts';

export async function run(args: string[]): Promise<number> {
  const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--session');
  if (!file) {
    process.stderr.write('usage: promptlog import <transcript.jsonl> [--session <id>]\n');
    return 1;
  }
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository\n');
    return 1;
  }
  const i = args.indexOf('--session');
  const sessionId = (i >= 0 ? args[i + 1] : undefined) ?? basename(file).replace(/\.jsonl$/, '');
  if (!isValidSessionId(sessionId)) {
    process.stderr.write(`invalid session id: ${sessionId}\n`);
    return 1;
  }
  const transcriptPath = resolve(file);
  // Claude Code keeps subagent transcripts in <dir>/<session-id>/subagents/*.jsonl next to the main transcript.
  const subDir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
  const state: CaptureState = { sessionId, transcriptPath, startedAt: new Date().toISOString() };
  if (existsSync(subDir)) state.subagents = readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ path: join(subDir, f) }));
  const redact = repoRedactor(root, (msg) => process.stderr.write(`warning: ${msg}\n`));
  const res = captureSession({ root, sessionId, transcriptPath, redact, extraFiles: subagentFiles(state, transcriptPath) });
  if (!res) {
    process.stderr.write('no human prompts found in transcript\n');
    return 1;
  }
  const subs = state.subagents?.length ? `, ${state.subagents.length} subagent transcript(s)` : '';
  process.stdout.write(`imported ${sessionId}: ${res.turnCount} turns${subs} -> ${res.commit.slice(0, 10)}\n`);
  return 0;
}
