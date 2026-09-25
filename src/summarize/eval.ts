// `npm run eval`: run the summarizer on fixture reviews and grade coverage of what a strong reviewer would
// notice (fixtures/evals/*.json) with a small LLM judge. Prints a score per expected item.
//
//   npm run eval -- [--model sonnet] [--judge haiku] [--runs 1] [--refresh] [fixtures/evals/x.json …]
//
// Summaries are cached like any other (key includes the prompt hash), so re-running after a prompt edit
// re-summarizes and re-running without one only re-judges. --refresh forces fresh samples.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleReview, parseRange } from '../core/review.ts';
import type { Review, ReviewSummary } from '../core/types.ts';
import { summarizeReviewDetailed } from './index.ts';
import { renderSummaryMarkdown } from './markdown.ts';
import { loadPromptTemplate } from './prompt.ts';
import { sessionLabels } from './render.ts';
import { runStructured } from './run.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface EvalSpec {
  name: string;
  description?: string;
  fixture: { bundle: string; checkout: string; branches?: string[] };
  range: string;
  judgeContext?: string;
  expected: { id: string; weight: number; turn?: string; expect: string }[];
  mustNot?: { id: string; claim: string }[];
  checks?: { pushbackTurns?: string[]; minPlanVsDiff?: number; minRiskFlags?: number };
}

const VERDICT_SCORE = { covered: 1, partial: 0.5, missed: 0 } as const;
type Verdict = keyof typeof VERDICT_SCORE;

interface JudgeOutput {
  items: { id: string; verdict: Verdict; quote: string }[];
  falseClaims: { id: string; asserted: boolean; quote: string }[];
}

/** Clone a fixture bundle (with refs/promptlog/*) once into a stable temp dir, so summary caches survive reruns. */
export function materializeFixture(spec: EvalSpec): string {
  const bundle = join(ROOT, spec.fixture.bundle);
  const digest = createHash('sha256').update(readFileSync(bundle)).digest('hex').slice(0, 10);
  const dir = join(tmpdir(), 'promptlog-evals', `${spec.name}-${digest}`);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(join(tmpdir(), 'promptlog-evals'), { recursive: true });
  const run = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  run(['clone', '-q', bundle, dir], tmpdir());
  run(['fetch', '-q', 'origin', '+refs/promptlog/*:refs/promptlog/*']);
  run(['checkout', '-q', spec.fixture.checkout]);
  for (const b of spec.fixture.branches ?? []) if (b !== spec.fixture.checkout) run(['branch', '-q', '-f', b, `origin/${b}`]);
  return dir;
}

export function structuralChecks(spec: EvalSpec, review: Review, s: ReviewSummary): { name: string; pass: boolean; detail: string }[] {
  const labels = sessionLabels(review);
  const refOf = (sessionId: string, turn: number) => `${labels.get(sessionId) ?? '?'}${turn}`;
  const out: { name: string; pass: boolean; detail: string }[] = [];
  const c = spec.checks ?? {};
  for (const want of c.pushbackTurns ?? []) {
    const got = s.pushbacks.map((p) => refOf(p.sessionId, p.turn));
    out.push({ name: `pushback at ${want}`, pass: got.includes(want), detail: got.join(', ') || 'none' });
  }
  if (c.minPlanVsDiff) out.push({ name: `planVsDiff >= ${c.minPlanVsDiff}`, pass: s.planVsDiff.length >= c.minPlanVsDiff, detail: String(s.planVsDiff.length) });
  if (c.minRiskFlags) out.push({ name: `riskFlags >= ${c.minRiskFlags}`, pass: s.riskFlags.length >= c.minRiskFlags, detail: String(s.riskFlags.length) });
  const turnsOk = s.timeline.length > 0 && s.timeline.every((t) => review.sessions[t.sessionId]?.turns.some((x) => x.index === t.turn));
  out.push({ name: 'timeline turns resolve', pass: turnsOk, detail: `${s.timeline.length} entries` });
  return out;
}

function judgePrompt(spec: EvalSpec, markdown: string): string {
  const items = spec.expected.map((e) => `- id: ${e.id}\n  expectation: ${e.expect}`).join('\n');
  const falses = (spec.mustNot ?? []).map((m) => `- id: ${m.id}\n  claim: ${m.claim}`).join('\n');
  return `You grade a code-review summary against a checklist written by an expert reviewer of the same change.

<facts_about_the_change>
${spec.judgeContext ?? '(none)'}
</facts_about_the_change>

<summary_under_review>
${markdown}
</summary_under_review>

<checklist>
${items}
</checklist>

<false_claims>
${falses || '(none)'}
</false_claims>

For each checklist item, decide how well the summary conveys it, wherever in the summary it appears:
- "covered": the summary makes the item's specific point: the mechanism and why it matters, in any wording.
- "partial": the summary touches the topic but misses the key specific or the consequence the item names.
- "missed": absent, or only a generic remark (e.g. "consider error handling", "add more tests").
Quote the part of the summary your verdict rests on (short, verbatim; empty when missed).
For each false claim, say whether the summary asserts it (true only if it clearly does), with a quote.`;
}

function judgeSchema(spec: EvalSpec): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'falseClaims'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict', 'quote'],
          properties: { id: { type: 'string', enum: spec.expected.map((e) => e.id) }, verdict: { type: 'string', enum: ['covered', 'partial', 'missed'] }, quote: { type: 'string' } },
        },
      },
      falseClaims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'asserted', 'quote'],
          properties: { id: { type: 'string', enum: (spec.mustNot ?? []).map((m) => m.id).concat(['none']) }, asserted: { type: 'boolean' }, quote: { type: 'string' } },
        },
      },
    },
  };
}

export async function judge(spec: EvalSpec, summary: ReviewSummary, model: string): Promise<{ out: JudgeOutput; costUsd?: number }> {
  const res = await runStructured({
    prompt: judgePrompt(spec, renderSummaryMarkdown(summary)),
    schema: judgeSchema(spec),
    model,
    system: 'You are a strict, fair grader. Judge only what the summary text says.',
  });
  return { out: res.output as JudgeOutput, costUsd: res.costUsd };
}

interface RunResult {
  summary: ReviewSummary;
  cached: boolean;
  summaryCost?: number;
  judgeCost?: number;
  scores: Record<string, { verdict: Verdict; quote: string }>;
  falseClaims: { id: string; quote: string }[];
  checks: { name: string; pass: boolean; detail: string }[];
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

async function evalOne(spec: EvalSpec, opts: { model: string; judge: string; runs: number; refresh: boolean }): Promise<{ score: number; runs: RunResult[] }> {
  const dir = materializeFixture(spec);
  const { base, head } = parseRange(dir, spec.range);
  const review = assembleReview(dir, base, head);
  const runs: RunResult[] = [];
  for (let r = 0; r < opts.runs; r++) {
    const res = await summarizeReviewDetailed(dir, review, { model: opts.model, refresh: opts.refresh || r > 0 });
    const j = await judge(spec, res.summary, opts.judge);
    const scores: RunResult['scores'] = {};
    for (const it of j.out.items ?? []) scores[it.id] = { verdict: it.verdict, quote: it.quote };
    runs.push({
      summary: res.summary,
      cached: res.cached,
      summaryCost: res.costUsd,
      judgeCost: j.costUsd,
      scores,
      falseClaims: (j.out.falseClaims ?? []).filter((f) => f.asserted && f.id !== 'none').map((f) => ({ id: f.id, quote: f.quote })),
      checks: structuralChecks(spec, review, res.summary),
    });
  }

  const totalWeight = spec.expected.reduce((n, e) => n + e.weight, 0);
  const itemScore = (id: string) => runs.reduce((n, r) => n + VERDICT_SCORE[r.scores[id]?.verdict ?? 'missed'], 0) / runs.length;
  const score = spec.expected.reduce((n, e) => n + e.weight * itemScore(e.id), 0) / totalWeight;

  const w = Math.max(...spec.expected.map((e) => e.id.length));
  process.stdout.write(`\n== ${spec.name}  (${spec.range}, prompt v${loadPromptTemplate().version}, ${opts.model} summaries, ${opts.judge} judge, ${runs.length} run(s))\n\n`);
  process.stdout.write(`${pad('item', w)}  wt  score  verdicts   evidence (last run)\n`);
  for (const e of spec.expected) {
    const verdicts = runs.map((r) => (r.scores[e.id]?.verdict ?? 'missed')[0]).join('');
    const last = runs[runs.length - 1]!.scores[e.id];
    const quote = last?.quote ? `"${last.quote.replace(/\s+/g, ' ').slice(0, 90)}${last.quote.length > 90 ? '…' : ''}"` : '';
    process.stdout.write(`${pad(e.id, w)}  ${pad(String(e.weight), 2)}  ${itemScore(e.id).toFixed(2)}   ${pad(verdicts, 8)}  ${quote}\n`);
  }
  process.stdout.write(`\nweighted coverage: ${(score * 100).toFixed(1)}%\n`);
  const falses = runs.flatMap((r) => r.falseClaims);
  process.stdout.write(`false claims: ${falses.length ? falses.map((f) => `${f.id} ("${f.quote.slice(0, 80)}")`).join('; ') : 'none'}\n`);
  const checks = runs[runs.length - 1]!.checks;
  process.stdout.write(`checks: ${checks.map((c) => `${c.pass ? 'ok' : 'FAIL'} ${c.name} [${c.detail}]`).join('; ')}\n`);
  const cost = runs.reduce((n, r) => n + (r.cached ? 0 : (r.summaryCost ?? 0)) + (r.judgeCost ?? 0), 0);
  const perSummary = runs.map((r) => r.summaryCost).filter((c): c is number => c !== undefined);
  process.stdout.write(
    `cost this eval: $${cost.toFixed(4)}${perSummary.length ? `; per summary: $${(perSummary.reduce((a, b) => a + b, 0) / perSummary.length).toFixed(4)}` : ''}${runs.some((r) => r.cached) ? ' (some summaries from cache)' : ''}\n`,
  );
  return { score, runs };
}

async function main(argv: string[]): Promise<number> {
  const valueOf = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  const withValue = new Set(['--model', '--judge', '--runs']);
  const files = argv.filter((a, i) => !a.startsWith('-') && !withValue.has(argv[i - 1] ?? ''));
  const dir = join(ROOT, 'fixtures/evals');
  const specs = (files.length ? files.map((f) => resolve(f)) : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))).map(
    (f) => JSON.parse(readFileSync(f, 'utf8')) as EvalSpec,
  );
  const opts = { model: valueOf('--model', 'sonnet'), judge: valueOf('--judge', 'haiku'), runs: Math.max(1, Number(valueOf('--runs', '1'))), refresh: argv.includes('--refresh') };
  const outDir = join(tmpdir(), 'promptlog-evals', 'results');
  mkdirSync(outDir, { recursive: true });
  const all: { name: string; score: number }[] = [];
  for (const spec of specs) {
    const { score, runs } = await evalOne(spec, opts);
    all.push({ name: spec.name, score });
    const file = join(outDir, `${spec.name}-v${loadPromptTemplate().version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ spec: spec.name, promptVersion: loadPromptTemplate().version, opts, score, runs }, null, 2));
    process.stdout.write(`results: ${file}\n`);
  }
  if (all.length > 1) process.stdout.write(`\nmean weighted coverage: ${((all.reduce((n, a) => n + a.score, 0) / all.length) * 100).toFixed(1)}%\n`);
  return 0;
}

// Entry-point check that survives symlinks and URL-encoded paths (spaces etc.).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
