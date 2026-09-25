// Live summarizer test: calls headless claude. Skipped unless PL_LIVE=1.
//   PL_LIVE=1 node --no-warnings --test test/summarize.live.test.ts      (PL_LIVE_MODEL=haiku for a cheaper run)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleReview } from '../src/core/review.ts';
import { renderSummaryMarkdown, summarizeReviewDetailed } from '../src/summarize/index.ts';
import { cloneDemo, demoIds } from './helpers.ts';

const live = process.env.PL_LIVE === '1';

test('summarizes the demo PR with turn-linked pushbacks, plan-vs-diff and risks', { skip: !live && 'set PL_LIVE=1 to call claude', timeout: 15 * 60_000 }, async () => {
  const dir = cloneDemo();
  const ids = demoIds();
  const review = assembleReview(dir, 'main', 'feature/rates');
  const res = await summarizeReviewDetailed(dir, review, { model: process.env.PL_LIVE_MODEL ?? 'sonnet', refresh: true });
  const s = res.summary;
  assert.equal(res.cached, false);
  assert.ok(s.intent.length > 10);
  assert.ok(s.pushbacks.some((p) => p.sessionId === ids.sessionA && p.turn === 2), 'pushback at session A turn 2');
  assert.ok(s.planVsDiff.length >= 3);
  assert.ok(s.riskFlags.length >= 2);
  const valid = (id: string, t: number) => review.sessions[id]?.turns.some((x) => x.index === t);
  for (const x of [...s.timeline, ...s.pushbacks, ...s.openLoops, ...s.planVsDiff, ...s.decisions]) assert.ok(valid(x.sessionId, x.turn), `${x.sessionId}#${x.turn}`);
  const again = await summarizeReviewDetailed(dir, review, { model: process.env.PL_LIVE_MODEL ?? 'sonnet' });
  assert.equal(again.cached, true);
  assert.match(renderSummaryMarkdown(s), /### Pushbacks/);
});
