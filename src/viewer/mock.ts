// A mock ReviewSummary for previewing the summary panel (`/review?...&mockSummary=1`) before
// src/summarize is available. Pure. Items point at real turns of the review so every link resolves;
// the prose is sample text and the page labels it as mock data.
import type { Review, ReviewSummary } from '../core/types.ts';
import { plainPreview } from './markdown.ts';

export function mockSummary(review: Review): ReviewSummary {
  const turns = review.slices.flatMap((sl) =>
    (review.sessions[sl.sessionId]?.turns ?? []).filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn).map((t) => ({ sessionId: sl.sessionId, turn: t.index, prompt: t.prompt })),
  );
  const at = (i: number) => turns[Math.min(Math.max(i, 0), Math.max(turns.length - 1, 0))] ?? { sessionId: '', turn: 1, prompt: '' };
  const first = at(0);
  const second = at(1);
  const last = at(turns.length - 1);
  const ref = (t: { sessionId: string; turn: number }) => ({ sessionId: t.sessionId, turn: t.turn });
  return {
    intent: 'Add a cached /rates endpoint that proxies an upstream exchange-rate API, then cover it with offline tests.',
    approach: 'Node built-in fetch with a per-base in-memory Map cache and a configurable TTL; serve stale data when upstream fails. Tests stub global fetch with node:test mocks.',
    timeline: turns.map((t) => ({ ...ref(t), gist: plainPreview(t.prompt, 110) })),
    decisions: [
      { ...ref(first), decision: 'Keep the cache in-process for now', rationale: 'No new dependencies; the human asked to defer Redis.', alternatives: ['Redis shared cache', 'HTTP cache headers only'] },
      { ...ref(second), decision: 'Serve stale cache when upstream is down', rationale: 'Worse data beats no data for display-only rates.' },
    ],
    pushbacks: [
      {
        ...ref(second),
        humanSaid: '20 instances behind a load balancer means 20x upstream calls. Make TTL configurable, accept ?base=, leave a TODO.',
        aiChanged: 'Added RATES_CACHE_TTL_MS, a Map keyed by base currency, and a TODO about a shared cache.',
      },
    ],
    openLoops: [
      { ...ref(second), item: 'Shared cache across instances is deferred to a TODO; no ticket or owner.' },
      { ...ref(last), item: 'No test for concurrent requests hitting a cold cache (thundering herd).' },
    ],
    assumptions: ['Upstream rates are safe to serve stale for an unbounded time when the API is down.', 'The ?base= value can be passed upstream without validation.'],
    planVsDiff: [
      { ...ref(first), claim: 'Dependency-free, using built-in fetch', status: 'done', evidence: 'No package.json dependency changes.' },
      { ...ref(second), claim: 'TTL configurable via env', status: 'done', evidence: 'RATES_CACHE_TTL_MS read at startup.' },
      { ...ref(second), claim: 'Validate the base currency', status: 'missing', evidence: 'base is interpolated into the upstream URL as-is.' },
      { ...ref(last), claim: 'Tests cover the HTTP handler paths', status: 'partial', evidence: 'Handler covered; stale-cache expiry timing not exercised.' },
    ],
    riskFlags: [
      { severity: 'high', note: 'Unvalidated ?base= is concatenated into the upstream URL.', ...ref(second) },
      { severity: 'medium', note: 'Stale entries are served indefinitely on upstream failure; no max-stale bound.', ...ref(second) },
      { severity: 'low', note: 'server.listen() is now guarded by an import.meta check; confirm the start script still works.', ...ref(last) },
    ],
    generatedAt: review.commits[review.commits.length - 1]?.date ?? new Date(0).toISOString(),
    model: 'mock',
    promptVersion: 'mock',
  };
}
