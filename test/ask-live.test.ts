// Live demo test: asks real Claude (haiku) the same question at turn 1 and turn 2 of demo session A.
// Turn 1 built a single, un-keyed cache against the API's default base; turn 2 (after the human pushed back) keyed
// the cache by ?base=. Different answers prove the conversation and repo state are loaded as of each turn.
// Costs a few cents. Run with: PL_LIVE=1 node --no-warnings --test test/ask-live.test.ts
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { ask, listAsks } from '../src/ask/index.ts';
import { cloneDemo, demoIds } from './helpers.ts';

const LIVE = process.env.PL_LIVE === '1';
const QUESTION = 'Is the base currency hardcoded, and is the cache keyed by base currency?';

test('live: the same question answered at turn 1 vs turn 2 differs', { skip: LIVE ? false : 'set PL_LIVE=1 to run (calls claude)', timeout: 10 * 60_000 }, async () => {
  const repo = cloneDemo();
  try {
    const { sessionA } = demoIds();
    const [t1, t2] = await Promise.all([1, 2].map((turn) => ask({ cwd: repo, sessionId: sessionA, turn, question: QUESTION, model: 'haiku' })));
    process.stdout.write(`\n--- turn 1 ($${t1!.costUsd?.toFixed(4)})\n${t1!.answer}\n\n--- turn 2 ($${t2!.costUsd?.toFixed(4)})\n${t2!.answer}\n\n`);

    assert.notEqual(t1!.answer, t2!.answer);
    // Turn 1: one un-keyed cache. Turn 2: a Map keyed by base.
    assert.match(t1!.answer, /\b(no|not|isn't|doesn't|single|one)\b/i);
    assert.match(t2!.answer, /Map|keyed by|per[- ]base|\bbase\b.*\bkey/i);
    // Both persisted (concurrently) to the asks ref.
    assert.deepEqual(listAsks(repo, sessionA).map((a) => a.turn).sort(), [1, 2]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
