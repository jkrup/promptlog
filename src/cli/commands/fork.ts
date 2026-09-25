// pl fork <session> --at <turn> [--branch name] [--dir path] [--model m] [--exec]
import { execFork, fork } from '../../ask/index.ts';
import { parseArgs, parseTurn } from '../../ask/cli.ts';

const USAGE = 'usage: pl fork <session-prefix> --at <turn> [--branch name] [--dir path] [--model m] [--exec]\n';

export async function run(args: string[]): Promise<number> {
  let p;
  try {
    p = parseArgs(args, { options: ['at', 'branch', 'dir', 'model'], flags: ['exec'] });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const session = p.positional[0];
  if (!session || !p.options.at) {
    process.stderr.write(USAGE);
    return 1;
  }
  const f = fork({ cwd: process.cwd(), sessionId: session, turn: parseTurn(p.options.at), branch: p.options.branch, dir: p.options.dir, model: p.options.model });
  process.stderr.write(
    `forked ${f.sessionId.slice(0, 8)} at turn ${f.turn} (state: ${f.source})\n` +
      `  worktree  ${f.root}\n  branch    ${f.branch} @ ${f.commit.slice(0, 10)}\n  transcript ${f.transcriptPath}\n` +
      (f.copiedLocalSettings ? '  copied .claude/settings.local.json (promptlog hooks) into the worktree\n' : ''),
  );
  if (p.flags.has('exec')) return execFork(f);
  process.stderr.write('continue the conversation with:\n');
  process.stdout.write(f.commandLine + '\n');
  return 0;
}
