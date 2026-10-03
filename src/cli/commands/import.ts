import { repoRoot } from '../../core/git.ts';
import { importTranscript } from '../../capture/backfill.ts';

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
  let res;
  try {
    res = importTranscript(root, file, i >= 0 ? args[i + 1] : undefined, (msg) => process.stderr.write(`warning: ${msg}\n`));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!res) {
    process.stderr.write('no human prompts found in transcript\n');
    return 1;
  }
  const subs = res.subagents ? `, ${res.subagents} subagent transcript(s)` : '';
  process.stdout.write(`imported ${res.sessionId}: ${res.turns} turns${subs} -> ${res.commit.slice(0, 10)}\n`);
  return 0;
}
