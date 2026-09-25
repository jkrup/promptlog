// pl asks <session> [--at <turn>] [--json]: past Q&A on a session (refs/promptlog/asks/<id>).
import { listAsks, resolveSessionId } from '../../ask/index.ts';
import { parseArgs, parseTurn } from '../../ask/cli.ts';

const USAGE = 'usage: pl asks <session-prefix> [--at <turn>] [--json]\n';

export async function run(args: string[]): Promise<number> {
  let p;
  try {
    p = parseArgs(args, { options: ['at'], flags: ['json'] });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const prefix = p.positional[0];
  if (!prefix) {
    process.stderr.write(USAGE);
    return 1;
  }
  const cwd = process.cwd();
  const sessionId = resolveSessionId(cwd, prefix);
  const asks = listAsks(cwd, sessionId, p.options.at ? { turn: parseTurn(p.options.at) } : {});
  if (p.flags.has('json')) {
    process.stdout.write(JSON.stringify(asks, null, 2) + '\n');
    return 0;
  }
  if (asks.length === 0) {
    process.stdout.write(`no asks on ${sessionId.slice(0, 8)} yet (try \`pl ask ${sessionId.slice(0, 8)} --at <turn> "question"\`)\n`);
    return 0;
  }
  for (const a of asks) {
    const meta = [`turn ${a.turn}`, a.askedAt.slice(0, 16).replace('T', ' '), a.askedBy, a.model].filter(Boolean).join(' · ');
    process.stdout.write(`── ${meta}\nQ: ${a.question.replace(/\n/g, '\n   ')}\nA: ${a.answer.trim().replace(/\n/g, '\n   ')}\n\n`);
  }
  return 0;
}
