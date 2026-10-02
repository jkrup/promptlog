// promptlog ask [<session> | <base>..<head>] [--model m] [--no-save] [--json] "question"
//   quick: Jev + Gemini Flash over the whole conversation (src/quick). Needs TYPESAFE_API_KEY and GEMINI_API_KEY.
// promptlog ask <session> --at <turn> [--model m] [--keep] [--no-save] [--json] "question"
//   full: Claude Code resumed at that turn, in a worktree with the repo as it was (src/ask).
import { ask, resolveSessionId } from '../../ask/index.ts';
import { parseArgs, parseTurn, type ParsedArgs } from '../../ask/cli.ts';
import { gitMaybe } from '../../core/git.ts';
import { isSessionTarget, quickAsk, type QuickAskRun } from '../../quick/index.ts';

const USAGE = `usage: promptlog ask [<session> | <base>..<head>] [--model m] [--no-save] [--json] "question"
         quick answer from the whole conversation behind a session or a PR (Jev + Gemini Flash;
         keys in ~/.config/promptlog/config.json, see docs/quick-ask.md). Default target: HEAD against main.
       promptlog ask <session-prefix> --at <turn> [--model m] [--keep] [--no-save] [--json] "question"
         full answer at one turn: Claude Code with the repo exactly as it was then
`;

export async function run(args: string[]): Promise<number> {
  let p;
  try {
    p = parseArgs(args, { options: ['at', 'model'], flags: ['keep', 'no-save', 'json'] });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  if (!p.options.at) return runQuick(p);
  const [session, ...words] = p.positional;
  const question = words.join(' ').trim();
  if (!session || !question) {
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

/** A first word that names a session, a range or a commit is the target; otherwise it's part of the question. */
function looksLikeTarget(cwd: string, word: string): boolean {
  return word.includes('..') || isSessionTarget(cwd, word) || gitMaybe(['rev-parse', '--verify', '-q', `${word}^{commit}`], { cwd }) !== null;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function runQuick(p: ParsedArgs): Promise<number> {
  if (p.flags.has('keep')) {
    process.stderr.write('--keep only applies with --at\n');
    return 1;
  }
  const cwd = process.cwd();
  const [first, ...rest] = p.positional;
  const hasTarget = rest.length > 0 && !!first && looksLikeTarget(cwd, first);
  const target = hasTarget ? first : undefined;
  const question = (hasTarget ? rest : p.positional).join(' ').trim();
  if (!question) {
    process.stderr.write(USAGE);
    return 1;
  }
  const res: QuickAskRun = await quickAsk({
    cwd,
    question,
    target,
    geminiModel: p.options.model,
    save: !p.flags.has('no-save'),
    onProgress: (m) => process.stderr.write(m + '\n'),
  });
  if (p.flags.has('json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return 0;
  }
  const q = res.quick;
  const multi = new Set(q.scores.map((s) => s.sessionId)).size > 1;
  const at = (s: { sessionId: string; turn: number }) => (multi ? `${s.sessionId.slice(0, 8)} turn ${s.turn}` : `turn ${s.turn}`);
  process.stdout.write('\n');
  if (q.verdict) {
    const v = q.verdict;
    process.stdout.write(`Verdict: ${v.label} (Jev, ${Math.round(v.confidence * 100)}% sure${v.turn ? `, from ${at({ sessionId: v.sessionId!, turn: v.turn })}` : ''})\n\n`);
  }
  process.stdout.write(res.answer.trimEnd() + '\n');
  const meta = [
    `${q.target}: looked at ${q.scores.length} turn${q.scores.length === 1 ? '' : 's'}`,
    q.used.length ? `used ${q.used.map(at).join(', ')}` : 'no relevant turns',
    `${q.models.jev} ${k(q.usage.jevInputTokens)} tokens`,
    `${q.models.gemini} ${k(q.usage.geminiInputTokens)} in / ${k(q.usage.geminiOutputTokens)} out`,
    p.flags.has('no-save') ? 'not saved' : `saved to refs/promptlog/asks/${res.sessionId.slice(0, 8)}…`,
  ];
  process.stderr.write(`\n(${meta.join(' · ')})\n`);
  return 0;
}
