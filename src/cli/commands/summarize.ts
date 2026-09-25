// pl summarize [base..head] [--model m] [--refresh] [--json] [--show-input] [--budget tokens]
import { assembleReview, parseRange } from '../../core/review.ts';
import { DEFAULT_MODEL, prepareSummary, renderSummaryMarkdown, summarizeReviewDetailed } from '../../summarize/index.ts';

const USAGE = `usage: pl summarize [<base>..<head>] [--model <m>] [--refresh] [--json] [--show-input] [--budget <tokens>]

  Summarize the conversations behind a commit range for a reviewer: intent, pushbacks, open loops,
  plan-vs-diff and risk flags, each pointing at its turn. Cached in <git-dir>/promptlog/cache.

  --model <m>       claude model alias or id (default: ${DEFAULT_MODEL})
  --refresh         ignore the cache and regenerate
  --json            print the ReviewSummary JSON instead of Markdown
  --show-input      print the rendered model input and exit (no model call)
  --budget <tokens> input token budget for the rendered material (default: 60000)
`;

export async function run(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const valueOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const withValue = new Set(['--model', '--budget']);
  const positional = args.filter((a, i) => !a.startsWith('-') && !withValue.has(args[i - 1] ?? ''));
  const cwd = process.cwd();
  const { base, head } = parseRange(cwd, positional[0]);
  const review = assembleReview(cwd, base, head);
  if (!review.slices.length) {
    process.stderr.write(`no captured conversations behind ${base}..${head} (${review.commits.length} commits)\n`);
    return 1;
  }
  const budgetArg = valueOf('--budget');
  const opts = {
    model: valueOf('--model'),
    refresh: args.includes('--refresh'),
    budget: budgetArg ? { totalTokens: Number(budgetArg) } : undefined,
  };

  if (args.includes('--show-input')) {
    const prep = prepareSummary(cwd, review, opts);
    process.stdout.write(prep.prompt + '\n');
    process.stderr.write(`~${prep.inputTokens} tokens of material, detail level ${prep.renderLevel}, cache key ${prep.key}\n`);
    return 0;
  }

  const turns = review.slices.reduce((n, s) => n + s.toTurn - s.fromTurn + 1, 0);
  process.stderr.write(`summarizing ${base}..${head}: ${review.commits.length} commits, ${review.slices.length} session(s), ${turns} turns…\n`);
  const res = await summarizeReviewDetailed(cwd, review, opts);
  const titles = Object.fromEntries(Object.values(review.sessions).map((s) => [s.meta.sessionId, s.meta.title ?? '']));
  process.stdout.write(args.includes('--json') ? JSON.stringify(res.summary, null, 2) + '\n' : renderSummaryMarkdown(res.summary, { title: `Review summary: ${base}..${head}`, sessionTitles: titles }));
  const cost = res.costUsd !== undefined ? `$${res.costUsd.toFixed(4)}` : 'cost unknown';
  const secs = res.durationMs !== undefined ? `, ${(res.durationMs / 1000).toFixed(0)}s` : '';
  process.stderr.write(
    res.cached
      ? `(cached: ${res.cacheFile}; original run ${cost}${secs}. --refresh to regenerate)\n`
      : `(${cost}${secs}, ~${res.inputTokens} input tokens, detail level ${res.renderLevel}; cached at ${res.cacheFile})\n`,
  );
  return 0;
}
