import { basename, resolve } from 'node:path';
import { repoRoot } from '../../core/git.ts';
import { captureSession } from '../../core/store.ts';

export async function run(args: string[]): Promise<number> {
  const file = args[0];
  if (!file) {
    process.stderr.write('usage: pl import <transcript.jsonl> [--session <id>]\n');
    return 1;
  }
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository\n');
    return 1;
  }
  const i = args.indexOf('--session');
  const sessionId = (i >= 0 ? args[i + 1] : undefined) ?? basename(file).replace(/\.jsonl$/, '');
  const res = captureSession({ root, sessionId, transcriptPath: resolve(file) });
  if (!res) {
    process.stderr.write('no human prompts found in transcript\n');
    return 1;
  }
  process.stdout.write(`imported ${sessionId}: ${res.turnCount} turns -> ${res.commit.slice(0, 10)}\n`);
  return 0;
}
