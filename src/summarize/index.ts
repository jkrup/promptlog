// The taste layer: a review summary that tells a reviewer what matters about how this code came to be.
//
//   summarizeReview(cwd, review, { model?, refresh? }) -> ReviewSummary   (cached per range/sessions/prompt/model)
//   renderSummaryMarkdown(summary)                                          (for the CLI, PR comments)
//
// Pipeline: collectGitContext (read-only git) -> renderReviewForModel (budgeted text) -> prompt.md ->
// headless claude with --json-schema (no tools, no hooks) -> toReviewSummary -> cache.
import { git } from '../core/git.ts';
import type { Review, ReviewSummary } from '../core/types.ts';
import { cachePath, readCache, sessionCommits, summaryCacheKey, writeCache } from './cache.ts';
import { collectGitContext } from './gitctx.ts';
import { buildPrompt, loadPromptTemplate, SYSTEM_PROMPT } from './prompt.ts';
import { DEFAULT_BUDGET, RENDER_VERSION, renderReviewForModel, type RenderBudget } from './render.ts';
import { runStructured } from './run.ts';
import { outputSchema, toReviewSummary } from './schema.ts';

export { renderSummaryMarkdown, type MarkdownOptions } from './markdown.ts';
export { renderReviewForModel, DEFAULT_BUDGET, type RenderBudget } from './render.ts';
export { collectGitContext } from './gitctx.ts';

/** Default summarizer model. Summaries are frequent; sonnet is the price/quality point the eval targets. */
export const DEFAULT_MODEL = 'sonnet';

export interface SummarizeOptions {
  /** Model alias or id passed to `claude --model`. Default: sonnet. */
  model?: string;
  /** Ignore the cache and regenerate (the new result is cached). */
  refresh?: boolean;
  budget?: Partial<RenderBudget>;
  timeoutMs?: number;
}

export interface SummarizeResult {
  summary: ReviewSummary;
  cached: boolean;
  cacheFile: string;
  key: string;
  /** Cost of the run that produced the summary (also reported for cache hits: it's what the cached run cost). */
  costUsd?: number;
  durationMs?: number;
  /** Detail level the renderer settled on (0 = full) and the estimated input tokens. */
  renderLevel?: number;
  inputTokens?: number;
}

export interface PreparedSummary {
  key: string;
  prompt: string;
  schema: object;
  labels: Map<string, string>;
  renderLevel: number;
  inputTokens: number;
}

function keyFor(cwd: string, review: Review, model: string, budget: RenderBudget): string {
  const tpl = loadPromptTemplate();
  return summaryCacheKey({
    mergeBase: review.mergeBase,
    head: git(['rev-parse', review.head], { cwd }),
    sessions: sessionCommits(cwd, review),
    promptVersion: tpl.version,
    promptHash: tpl.hash,
    renderVersion: RENDER_VERSION,
    budget,
    model,
  });
}

/** Everything short of calling the model: useful for `pl summarize --show-input` and tests. */
export function prepareSummary(cwd: string, review: Review, opts: SummarizeOptions = {}): PreparedSummary {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const model = opts.model ?? DEFAULT_MODEL;
  const rendered = renderReviewForModel(review, collectGitContext(cwd, review), budget);
  return {
    key: keyFor(cwd, review, model, budget),
    prompt: buildPrompt(rendered.text),
    schema: outputSchema([...rendered.labels.values()]),
    labels: rendered.labels,
    renderLevel: rendered.level,
    inputTokens: rendered.tokens,
  };
}

const inflight = new Map<string, Promise<SummarizeResult>>();

export async function summarizeReviewDetailed(cwd: string, review: Review, opts: SummarizeOptions = {}): Promise<SummarizeResult> {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const model = opts.model ?? DEFAULT_MODEL;
  const key = keyFor(cwd, review, model, budget);
  const file = cachePath(cwd, key);
  if (!opts.refresh) {
    const hit = readCache(cwd, key);
    if (hit) return { summary: hit.summary, cached: true, cacheFile: file, key, costUsd: hit.run?.costUsd, durationMs: hit.run?.durationMs, renderLevel: hit.run?.renderLevel, inputTokens: hit.run?.inputTokens };
  }
  // Two viewers asking for the same summary share one model call.
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async (): Promise<SummarizeResult> => {
    const prep = prepareSummary(cwd, review, opts);
    const res = await runStructured({ prompt: prep.prompt, schema: prep.schema, model, system: SYSTEM_PROMPT, timeoutMs: opts.timeoutMs });
    const summary = toReviewSummary(res.output, {
      sessions: new Map([...prep.labels].map(([id, label]) => [label, id])),
      turns: new Map(review.slices.map((sl) => [sl.sessionId, (review.sessions[sl.sessionId]?.turns ?? []).map((t) => t.index).filter((i) => i >= sl.fromTurn && i <= sl.toTurn)])),
      generatedAt: new Date().toISOString(),
      model: res.model ?? model,
      promptVersion: loadPromptTemplate().version,
    });
    const run = { costUsd: res.costUsd, durationMs: res.durationMs, renderLevel: prep.renderLevel, inputTokens: prep.inputTokens, usage: res.usage };
    writeCache(cwd, { key, createdAt: summary.generatedAt, summary, run });
    return { summary, cached: false, cacheFile: file, key, ...run };
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** Summarize a review (cached). The viewer calls this from its HTTP handler; it doesn't block the event loop. */
export async function summarizeReview(cwd: string, review: Review, opts: SummarizeOptions = {}): Promise<ReviewSummary> {
  return (await summarizeReviewDetailed(cwd, review, opts)).summary;
}
