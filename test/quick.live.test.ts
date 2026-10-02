// Live quick-ask test: calls the decision endpoint (this repo's .promptlog/config.local.json, e.g. Dopp, else TypeSafe
// with TYPESAFE_API_KEY) and Gemini Flash. Skipped unless PL_LIVE=1 and both are set up.
//   PL_LIVE=1 GEMINI_API_KEY=… node --no-warnings --test test/quick.live.test.ts
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { decisionClient, loadQuickConfig, quickAsk, repoGeminiClient } from '../src/quick/index.ts';
import { cloneDemo, demoIds, ROOT } from './helpers.ts';

const decision = !!loadQuickConfig(ROOT).decision?.apiKey || !!process.env.TYPESAFE_API_KEY;
const gemini = !!loadQuickConfig(ROOT).gemini?.apiKey || !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const skip = process.env.PL_LIVE !== '1' ? 'set PL_LIVE=1 to call the decision API and Gemini' : !decision || !gemini ? 'needs a decision endpoint (config or TYPESAFE_API_KEY) and GEMINI_API_KEY' : false;

test('quick ask on the demo PR finds the Redis pushback and says it was deferred', { skip, timeout: 5 * 60_000 }, async () => {
  const dir = cloneDemo();
  const { sessionA } = demoIds();
  try {
    // The demo clone has no config of its own: use this repo's decision endpoint and Gemini key.
    const res = await quickAsk({ cwd: dir, question: 'Did it add a shared cache like Redis for the 20 instances?', target: 'main..feature/rates', jev: decisionClient(ROOT), gemini: repoGeminiClient(ROOT), save: false });
    console.log(JSON.stringify({ answer: res.answer, verdict: res.quick.verdict, used: res.quick.used, usage: res.quick.usage, models: res.quick.models }, null, 2));
    assert.ok(res.quick.used.some((u) => u.sessionId === sessionA && u.turn === 2), 'session A turn 2 (the pushback) is used');
    assert.ok(res.quick.verdict, 'a "was X handled?" question gets a verdict');
    assert.notEqual(res.quick.verdict!.label, 'yes');
    assert.match(res.answer, /turn 2/);
    assert.match(res.answer, /redis/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
