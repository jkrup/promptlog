// promptlog map [<session> | <base>..<head>] [--model m] [--json]
// Build (or read from cache) the per-turn notes quick asks search: what the AI did, decided, and deferred.
import { parseArgs } from '../../ask/cli.ts';
import { repoGeminiClient, resolveScope, sessionMap, type TurnNote } from '../../quick/index.ts';

const USAGE = 'usage: promptlog map [<session> | <base>..<head>] [--model m] [--json]   (needs a Gemini key in ~/.config/promptlog/config.json or GEMINI_API_KEY)\n';

export async function run(args: string[]): Promise<number> {
  let p;
  try {
    p = parseArgs(args, { options: ['model'], flags: ['json'] });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  if (p.positional.length > 1) {
    process.stderr.write(USAGE);
    return 1;
  }
  const cwd = process.cwd();
  const gemini = repoGeminiClient(cwd);
  const scope = resolveScope(cwd, p.positional[0]);
  const out: { sessionId: string; notes: TurnNote[] }[] = [];
  for (const { session, turns } of scope.sessions) {
    const id = session.meta.sessionId;
    const m = await sessionMap(cwd, id, turns, { gemini, model: p.options.model, onProgress: (s) => process.stderr.write(s + '\n') });
    out.push({ sessionId: id, notes: turns.flatMap((t) => m.notes.get(t.index) ?? []) });
  }
  if (p.flags.has('json')) {
    process.stdout.write(JSON.stringify({ target: scope.label, sessions: out }, null, 2) + '\n');
    return 0;
  }
  for (const s of out) {
    process.stdout.write(`${s.sessionId.slice(0, 8)}\n`);
    for (const n of s.notes) {
      process.stdout.write(`  turn ${n.turn}: ${n.did}\n`);
      for (const d of n.decided) process.stdout.write(`    decided: ${d}\n`);
      for (const d of n.deferred) process.stdout.write(`    deferred: ${d}\n`);
    }
  }
  return 0;
}
