// pl ask <session> --at <turn> [--model m] [--keep] [--no-save] [--json] "question"
import { ask, resolveSessionId } from '../../ask/index.ts';
import { parseArgs, parseTurn } from '../../ask/cli.ts';

const USAGE = 'usage: pl ask <session-prefix> --at <turn> [--model m] [--keep] [--no-save] [--json] "question"\n';

export async function run(args: string[]): Promise<number> {
  let p;
  try {
    p = parseArgs(args, { options: ['at', 'model'], flags: ['keep', 'no-save', 'json'] });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const [session, ...words] = p.positional;
  const question = words.join(' ').trim();
  if (!session || !question || !p.options.at) {
    process.stderr.write(USAGE);
    return 1;
  }
  const turn = parseTurn(p.options.at);
  const cwd = process.cwd();
  const sessionId = resolveSessionId(cwd, session);
  process.stderr.write(`asking at turn ${turn} of ${sessionId.slice(0, 8)}…\n`);
  const res = await ask({ cwd, sessionId, turn, question, model: p.options.model, keep: p.flags.has('keep'), save: !p.flags.has('no-save') });
  if (p.flags.has('json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(res.answer.trimEnd() + '\n');
  const meta = [
    `turn ${res.turn}`,
    `state: ${res.state?.source ?? '?'} ${res.state?.commit.slice(0, 8) ?? ''}`.trim(),
    res.model,
    res.costUsd !== undefined ? `$${res.costUsd.toFixed(4)}` : '',
    `fork ${res.forkSessionId?.slice(0, 8) ?? '-'}`,
    p.flags.has('no-save') ? 'not saved' : `saved to refs/promptlog/asks/${res.sessionId.slice(0, 8)}…`,
  ].filter(Boolean);
  process.stderr.write(`\n(${meta.join(' · ')})\n`);
  if (res.worktree) process.stderr.write(`worktree kept at ${res.worktree}\n`);
  return 0;
}
