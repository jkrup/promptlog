// Deterministic tests for src/summarize: rendering, truncation, cache keying, output conversion, markdown.
// No network and no claude calls (the live test is test/summarize.live.test.ts, behind PL_LIVE=1).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { assembleReview } from '../src/core/review.ts';
import type { Review, ReviewSummary, Session, Turn, TurnItem } from '../src/core/types.ts';
import { readCache, summaryCacheKey, writeCache, type CacheKeyInput } from '../src/summarize/cache.ts';
import { collectGitContext, deriveRootPrefixes } from '../src/summarize/gitctx.ts';
import { prepareSummary, renderSummaryMarkdown, summarizeReviewDetailed } from '../src/summarize/index.ts';
import { loadPromptTemplate, parsePromptTemplate } from '../src/summarize/prompt.ts';
import {
  clipMiddle,
  emptyGitContext,
  estimateTokens,
  looksLikePushback,
  makeStripper,
  renderReviewForModel,
  sessionLabels,
  splitDiff,
  toolSummary,
  truncateDiff,
} from '../src/summarize/render.ts';
import { extractJson, outputSchema, toReviewSummary } from '../src/summarize/schema.ts';
import { cloneDemo, demoIds, tempRepo } from './helpers.ts';

// ---------------------------------------------------------------------------
// Synthetic review builders
// ---------------------------------------------------------------------------

const tool = (name: string, input: unknown, result = 'ok', isError = false): TurnItem => ({ kind: 'tool', id: Math.random().toString(36), name, input, result, isError });
const text = (t: string): TurnItem => ({ kind: 'text', text: t });

function turn(index: number, prompt: string, items: TurnItem[], extra: Partial<Turn> = {}): Turn {
  return { index, prompt, items, timestamp: `2026-01-01T10:${String(index).padStart(2, '0')}:00Z`, ...extra };
}

function session(id: string, turns: Turn[], title = 'work'): Session {
  return { meta: { schema: 1, sessionId: id, agent: 'claude-code', cwd: '', startedAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T11:00:00Z', title, branch: 'feat' }, turns };
}

function review(sessions: Session[]): Review {
  return {
    base: 'main',
    head: 'feat',
    mergeBase: 'a'.repeat(40),
    commits: [{ sha: 'c'.repeat(40), subject: 'Add thing', author: 'Dana', date: '2026-01-01', trailers: [] }],
    slices: sessions.map((s) => ({ sessionId: s.meta.sessionId, fromTurn: 1, toTurn: s.turns.length, committingTurns: [1] })),
    sessions: Object.fromEntries(sessions.map((s) => [s.meta.sessionId, s])),
  };
}

const ROOTP = '/home/dana/src/app/';

function smallReview(): Review {
  const a = session('aaaaaaaa-1111', [
    turn(1, 'Add a /rates endpoint with a cache.', [
      tool('Read', { file_path: `${ROOTP}src/server.js` }, '1\timport http'),
      text('Approach: in-memory cache with a TTL.'),
      tool('Edit', { file_path: `${ROOTP}src/server.js`, old_string: 'x', new_string: 'y' }),
      tool('Bash', { command: `cd ${ROOTP.slice(0, -1)} && npm test` }, 'FAIL: 1 test failed\nAssertionError: expected 200', true),
      text('Added the endpoint.'),
    ], { meta: { schema: 1, index: 1, commits: ['c'.repeat(40)], filesChanged: [{ path: 'src/server.js', status: 'M', additions: 30, deletions: 1 }] } }),
    turn(2, "Hmm, don't hardcode USD. Accept ?base=.", [text('Now accepts ?base=.')]),
  ]);
  const b = session('bbbbbbbb-2222', [turn(1, 'Write tests.', [tool('Write', { file_path: `${ROOTP}test/a.test.js`, content: 'a\nb\nc\n' }), text('Wrote 3 tests.')])]);
  return review([a, b]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('text helpers', () => {
  test('clipMiddle keeps head and tail and never exceeds max', () => {
    const s = 'HEAD' + 'x'.repeat(5000) + 'TAIL';
    const c = clipMiddle(s, 300);
    assert.ok(c.length <= 300, `length ${c.length}`);
    assert.ok(c.startsWith('HEAD'));
    assert.ok(c.endsWith('TAIL'));
    assert.match(c, /chars omitted/);
    assert.equal(clipMiddle('short', 300), 'short');
    assert.equal(clipMiddle('anything', 0), '');
  });

  test('looksLikePushback flags corrections, not approvals', () => {
    assert.ok(looksLikePushback("Hmm, we run 20 instances. Don't build Redis."));
    assert.ok(looksLikePushback('No, use the existing helper instead'));
    assert.ok(!looksLikePushback('Looks good. Commit this.'));
  });

  test('sessionLabels: A, B, … in slice order', () => {
    const labels = sessionLabels(smallReview());
    assert.deepEqual([...labels.values()], ['A', 'B']);
    const many = { slices: Array.from({ length: 28 }, (_, i) => ({ sessionId: `s${i}`, fromTurn: 1, toTurn: 1, committingTurns: [] })) };
    assert.deepEqual([...sessionLabels(many).values()].slice(25), ['Z', 'AA', 'AB']);
  });
});

describe('tool one-liners', () => {
  test('summarize common tools without their payloads', () => {
    assert.equal(toolSummary('Read', { file_path: '/r/src/a.ts' }), 'Read /r/src/a.ts');
    assert.equal(toolSummary('Edit', { file_path: 'a.ts', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW' }), 'Edit a.ts');
    assert.equal(toolSummary('Write', { file_path: 'a.ts', content: '1\n2\n3\n' }), 'Write a.ts (3 lines)');
    assert.equal(toolSummary('Bash', { command: 'npm test\n  && echo done' }), 'Bash: npm test ⏎ && echo done');
    assert.match(toolSummary('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }), /\[x\] a · \[ \] b/);
    assert.match(toolSummary('ExitPlanMode', { plan: 'Step 1\nStep 2' }), /proposed plan[\s\S]*Step 2/);
    assert.match(toolSummary('mcp__x__y', { q: 1 }), /^mcp__x__y \{"q":1\}$/);
  });

  test('checkout roots are derived from file paths and stripped', () => {
    const prefixes = deriveRootPrefixes([`${ROOTP}src/server.js`, '/etc/hosts'], new Set(['src/server.js']));
    assert.deepEqual(prefixes, [ROOTP]);
    const strip = makeStripper(prefixes);
    assert.equal(strip(`Read ${ROOTP}src/server.js`), 'Read src/server.js');
    assert.equal(strip(`cd ${ROOTP.slice(0, -1)} && ls`), 'cd . && ls');
  });
});

describe('diff truncation', () => {
  const file = (path: string, lines: number) =>
    `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n` + Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`).join('\n') + '\n';

  test('under budget: unchanged', () => {
    const p = file('a.ts', 5) + file('b.ts', 5);
    assert.equal(truncateDiff(p, 10_000), p);
    assert.equal(splitDiff(p).length, 2);
  });

  test('over budget: every file keeps its header, big files are cut, small ones stay whole', () => {
    const p = file('small.ts', 3) + file('big.ts', 2000) + file('other.ts', 400);
    const out = truncateDiff(p, 1500);
    assert.ok(estimateTokens(out) <= 1500 * 1.15, `~${estimateTokens(out)} tokens`);
    for (const f of ['small.ts', 'big.ts', 'other.ts']) assert.match(out, new RegExp(`diff --git a/${f}`));
    assert.match(out, /line 2 of small\.ts/);
    assert.match(out, /more diff lines in big\.ts omitted/);
  });

  test('lock files collapse to their header; zero budget drops the patch', () => {
    const out = truncateDiff(file('package-lock.json', 500) + file('src/a.ts', 2), 10_000);
    assert.match(out, /generated or lock file/);
    assert.doesNotMatch(out, /line 7 of package-lock/);
    assert.match(out, /line 1 of src\/a\.ts/);
    assert.equal(truncateDiff(file('a.ts', 3), 0), '');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderReviewForModel', () => {
  test('includes prompts, replies, tool one-liners with errors, files and commits', () => {
    const git = { ...emptyGitContext(), rootPrefixes: [ROOTP] };
    const { text: out, level, labels } = renderReviewForModel(smallReview(), git);
    assert.equal(level, 0);
    assert.deepEqual([...labels.values()], ['A', 'B']);
    assert.match(out, /<turn id="A1" session="A" turn="1"/);
    assert.match(out, /<human>\nAdd a \/rates endpoint with a cache\.\n<\/human>/);
    assert.match(out, /Hmm, don't hardcode USD/);
    assert.match(out, /▸ Read src\/server\.js/);
    assert.match(out, /▸ Edit src\/server\.js\n/, 'edit payloads stay out');
    assert.doesNotMatch(out, /old_string/);
    assert.match(out, /▸ Bash: cd \. && npm test {2}✗ ERROR\n\s+⎿ FAIL: 1 test failed/);
    assert.match(out, /AI \(final reply\): Added the endpoint\./);
    assert.match(out, /<files_changed_this_turn>M src\/server\.js \+30\/-1<\/files_changed_this_turn>/);
    assert.match(out, /<commits_this_turn>ccccccc Add thing<\/commits_this_turn>/);
    assert.match(out, /- ccccccc \[A1\] Add thing/);
    assert.match(out, /<turn id="B1"/);
    assert.doesNotMatch(out, /\/home\/dana/);
  });

  test('long sessions: fits the budget, keeps every human prompt, sheds tool noise first', () => {
    const turns: Turn[] = [];
    for (let i = 1; i <= 80; i++) {
      const prompt = i === 41 ? "No, that's wrong: don't retry forever, cap it at 3 attempts. PUSHBACK-41" : `Prompt number ${i}: do step ${i}.`;
      turns.push(
        turn(i, prompt, [
          text(`Thinking out loud about step ${i}. `.repeat(20)),
          ...Array.from({ length: 6 }, (_, k) => tool('Bash', { command: `run ${i}.${k}` }, `NOISY-OUTPUT ${'z'.repeat(1500)}`)),
          text(i === 40 ? `REPLY-40 I will retry failed requests forever with backoff. ${'detail '.repeat(150)}END-40` : `Done with step ${i}. ${'more '.repeat(80)}`),
        ]),
      );
    }
    const r = review([session('long-session', turns)]);
    const full = renderReviewForModel(r, emptyGitContext(), { totalTokens: 1_000_000 });
    assert.equal(full.level, 0);
    const small = renderReviewForModel(r, emptyGitContext(), { totalTokens: 12_000 });
    assert.ok(small.tokens <= 12_000, `tokens ${small.tokens}`);
    assert.ok(small.level > 0);
    for (let i = 1; i <= 80; i++) assert.ok(small.text.includes(i === 41 ? 'PUSHBACK-41' : `Prompt number ${i}:`), `prompt ${i} kept`);
    assert.doesNotMatch(small.text, /NOISY-OUTPUT/);
    // The reply the human pushed back on is kept whole even when other replies are clipped.
    assert.match(small.text, /REPLY-40[\s\S]*END-40/);
  });

  test('pathological input is hard-clipped to the budget', () => {
    const r = review([session('x', [turn(1, 'p'.repeat(200_000), [])])]);
    const out = renderReviewForModel(r, emptyGitContext(), { totalTokens: 2_000 });
    assert.ok(out.tokens <= 2_000);
  });
});

describe('demo fixture rendering (offline git)', () => {
  const dir = cloneDemo();
  const ids = demoIds();
  const r = assembleReview(dir, 'main', 'feature/rates');

  test('git context: final diff, per-turn diffs, commit bodies, checkout root', () => {
    const git = collectGitContext(dir, r);
    assert.match(git.finalDiff, /diff --git a\/src\/server\.js/);
    assert.deepEqual(git.finalFiles.map((f) => f.path).sort(), ['src/server.js', 'test/rates.test.js']);
    assert.match(git.turnDiffs[`${ids.sessionA}#2`] ?? '', /RATES_CACHE_TTL_MS/);
    assert.equal(git.turnDiffs[`${ids.sessionA}#4`], undefined, 'question turn changed nothing');
    assert.ok(Object.values(git.commitBodies).some((b) => /Falls back to stale cached data/.test(b)));
    assert.ok(Object.values(git.commitBodies).every((b) => !/Co-Authored-By/i.test(b)));
    assert.equal(git.rootPrefixes.length, 1);
  });

  test('rendering: both sessions, pushback prompt, final diff, relative paths', () => {
    const { text: out, level, labels } = renderReviewForModel(r, collectGitContext(dir, r));
    assert.equal(level, 0);
    assert.equal(labels.get(ids.sessionA), 'A');
    assert.equal(labels.get(ids.sessionB), 'B');
    assert.match(out, /<turn id="A2"[\s\S]*we run ~20 instances behind a load balancer/);
    assert.match(out, /- aca106e \[A3\] Add \/rates endpoint/);
    assert.match(out, /- d5fd4df \[B1\] Add node:test coverage/);
    assert.match(out, /▸ Bash: find \. -type f[\s\S]*\.\/\.env/, 'file listing that reveals .env is kept');
    assert.match(out, /<final_diff[\s\S]*import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/);
    assert.match(out, /<turn_diff note="what the agent changed during A1">/);
    assert.doesNotMatch(out, /scratchpad|\/tmp\/claude/);
  });

  test('prepareSummary: prompt embeds material, schema enumerates labels, key is stable', () => {
    const p1 = prepareSummary(dir, r);
    const p2 = prepareSummary(dir, r);
    assert.equal(p1.key, p2.key);
    assert.ok(p1.prompt.includes('<turn id="A2"'));
    assert.ok(!p1.prompt.includes('{{MATERIAL}}'));
    const sessionEnum = (p1.schema as { properties: { timeline: { items: { properties: { session: { enum: string[] } } } } } }).properties.timeline.items.properties.session.enum;
    assert.deepEqual(sessionEnum, ['A', 'B']);
    assert.notEqual(prepareSummary(dir, r, { model: 'opus' }).key, p1.key);
  });

  test('summarizeReview serves a cached summary without calling claude', async () => {
    const { key } = prepareSummary(dir, r);
    const fake: ReviewSummary = { ...minimalSummary(), intent: 'FROM-CACHE' };
    writeCache(dir, { key, createdAt: fake.generatedAt, summary: fake, run: { costUsd: 0.1 } });
    const res = await summarizeReviewDetailed(dir, r);
    assert.equal(res.cached, true);
    assert.equal(res.summary.intent, 'FROM-CACHE');
    assert.equal(res.costUsd, 0.1);
    assert.match(res.cacheFile, /promptlog\/cache\/summary-[0-9a-f]{32}\.json$/);
  });
});

// ---------------------------------------------------------------------------
// Cache keying
// ---------------------------------------------------------------------------

describe('cache', () => {
  const base: CacheKeyInput = {
    mergeBase: 'm'.repeat(40),
    head: 'h'.repeat(40),
    sessions: [
      { sessionId: 's1', commit: 'c1', fromTurn: 1, toTurn: 4 },
      { sessionId: 's2', commit: 'c2', fromTurn: 1, toTurn: 1 },
    ],
    promptVersion: '1',
    promptHash: 'abc',
    renderVersion: 1,
    budget: { totalTokens: 60_000, finalDiffTokens: 20_000 },
    model: 'sonnet',
  };

  test('key is stable under session order and budget key order', () => {
    const k = summaryCacheKey(base);
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.equal(summaryCacheKey({ ...base, sessions: [...base.sessions].reverse() }), k);
    assert.equal(summaryCacheKey({ ...base, budget: { finalDiffTokens: 20_000, totalTokens: 60_000 } }), k);
  });

  test('key changes with every input that changes the output', () => {
    const k = summaryCacheKey(base);
    const variants: Partial<CacheKeyInput>[] = [
      { head: 'x'.repeat(40) },
      { mergeBase: 'y'.repeat(40) },
      { sessions: [{ ...base.sessions[0]!, commit: 'c1-new-turn' }, base.sessions[1]!] },
      { sessions: [{ ...base.sessions[0]!, toTurn: 5 }, base.sessions[1]!] },
      { sessions: [base.sessions[0]!] },
      { promptVersion: '2' },
      { promptHash: 'def' },
      { renderVersion: 2 },
      { budget: { totalTokens: 10_000, finalDiffTokens: 20_000 } },
      { model: 'opus' },
    ];
    const keys = new Set(variants.map((v) => summaryCacheKey({ ...base, ...v })));
    assert.equal(keys.size, variants.length);
    assert.ok(!keys.has(k));
  });

  test('write/read roundtrip under <git-dir>/promptlog/cache; wrong key misses', () => {
    const repo = tempRepo();
    const s = minimalSummary();
    const file = writeCache(repo, { key: 'k1', createdAt: s.generatedAt, summary: s });
    assert.match(file, /\.git\/promptlog\/cache\/summary-k1\.json$/);
    assert.deepEqual(readCache(repo, 'k1')?.summary, s);
    assert.equal(readCache(repo, 'k2'), null);
  });
});

// ---------------------------------------------------------------------------
// Model output -> ReviewSummary, prompt, markdown
// ---------------------------------------------------------------------------

function minimalSummary(): ReviewSummary {
  return { intent: '', approach: '', timeline: [], decisions: [], pushbacks: [], openLoops: [], assumptions: [], planVsDiff: [], riskFlags: [], generatedAt: '2026-01-01T00:00:00.000Z', promptVersion: '1' };
}

describe('toReviewSummary', () => {
  const meta = {
    sessions: new Map([
      ['A', 'sess-a'],
      ['B', 'sess-b'],
    ]),
    turns: new Map([
      ['sess-a', [1, 2, 3, 4]],
      ['sess-b', [1]],
    ]),
    generatedAt: '2026-01-01T00:00:00.000Z',
    model: 'claude-x',
    promptVersion: '7',
  };

  test('maps labels, snaps bad turns, drops malformed items, orders risks', () => {
    const s = toReviewSummary(
      {
        intent: ' Build /rates ',
        approach: 'cache',
        timeline: [
          { session: 'B', turn: 1, gist: 'tests' },
          { session: 'A', turn: 2, gist: 'pushback' },
          { session: 'A', turn: 1, gist: 'build' },
          { session: 'Z', turn: 1, gist: 'unknown session' },
          { session: 'A', turn: 1 },
        ],
        pushbacks: [{ session: 'A', turn: 9, humanSaid: '20 instances', aiChanged: 'TODO' }],
        planVsDiff: [{ session: 'A', turn: 2, claim: 'TTL env', status: 'bogus', evidence: 'x' }],
        riskFlags: [
          { severity: 'low', note: 'route prefix' },
          { severity: 'high', note: 'stale forever', session: 'A', turn: 2 },
          { severity: 'high' },
        ],
        decisions: [{ session: 'A', turn: 1, decision: 'in-memory cache', alternatives: ['redis', ''] }],
        openLoops: 'not an array',
        assumptions: ['upstream is free', ''],
      },
      meta,
    );
    assert.equal(s.intent, 'Build /rates');
    assert.deepEqual(s.timeline.map((t) => `${t.sessionId}#${t.turn}`), ['sess-a#1', 'sess-a#2', 'sess-b#1']);
    assert.deepEqual(s.pushbacks[0], { sessionId: 'sess-a', turn: 4, humanSaid: '20 instances', aiChanged: 'TODO' });
    assert.equal(s.planVsDiff[0]!.status, 'unclear');
    assert.deepEqual(s.riskFlags.map((r) => r.severity), ['high', 'low']);
    assert.equal(s.riskFlags[0]!.sessionId, 'sess-a');
    assert.equal(s.riskFlags[1]!.sessionId, undefined);
    assert.deepEqual(s.decisions[0]!.alternatives, ['redis']);
    assert.deepEqual(s.openLoops, []);
    assert.deepEqual(s.assumptions, ['upstream is free']);
    assert.equal(s.model, 'claude-x');
    assert.equal(s.promptVersion, '7');
  });

  test('garbage in, empty summary out', () => {
    const s = toReviewSummary(null, meta);
    assert.equal(s.timeline.length, 0);
    assert.equal(s.intent, '');
  });

  test('extractJson handles bare, fenced and wrapped JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('noise {"a":3} trailing'), { a: 3 });
    assert.equal(extractJson('nope'), null);
  });

  test('schema requires every ReviewSummary field the model fills', () => {
    const sch = outputSchema(['A']) as { required: string[] };
    assert.deepEqual(sch.required.sort(), ['approach', 'assumptions', 'decisions', 'intent', 'openLoops', 'planVsDiff', 'pushbacks', 'riskFlags', 'timeline']);
  });
});

describe('prompt template', () => {
  test('version header is parsed and stripped; placeholder is required', () => {
    const t = parsePromptTemplate('<!-- promptVersion: 3 -->\nHello {{MATERIAL}}');
    assert.equal(t.version, '3');
    assert.equal(t.body, 'Hello {{MATERIAL}}');
    assert.throws(() => parsePromptTemplate('no placeholder'));
  });

  test('shipped prompt.md loads', () => {
    const t = loadPromptTemplate();
    assert.match(t.version, /^\d+/);
    assert.ok(t.body.includes('{{MATERIAL}}'));
  });
});

describe('renderSummaryMarkdown', () => {
  test('signal first, turn refs, legend', () => {
    const s: ReviewSummary = {
      ...minimalSummary(),
      intent: 'Add /rates.',
      approach: 'Per-process cache.',
      timeline: [
        { sessionId: 'sess-aaaaaaaa', turn: 1, gist: 'build' },
        { sessionId: 'sess-bbbbbbbb', turn: 1, gist: 'tests' },
      ],
      pushbacks: [{ sessionId: 'sess-aaaaaaaa', turn: 2, humanSaid: '20 instances', aiChanged: 'added TODO' }],
      openLoops: [{ sessionId: 'sess-aaaaaaaa', turn: 2, item: 'shared cache' }],
      planVsDiff: [
        { sessionId: 'sess-aaaaaaaa', turn: 2, claim: 'TTL env', status: 'done', evidence: 'RATES_CACHE_TTL_MS' },
        { sessionId: 'sess-bbbbbbbb', turn: 1, claim: 'covers expiry', status: 'missing', evidence: 'no test' },
      ],
      riskFlags: [{ severity: 'high', note: 'stale forever', sessionId: 'sess-aaaaaaaa', turn: 2 }],
      model: 'claude-sonnet-x',
    };
    const md = renderSummaryMarkdown(s, { sessionTitles: { 'sess-aaaaaaaa': 'Rates' } });
    const order = ['Risk flags', 'Pushbacks', 'Open loops', 'Plan vs diff', 'Timeline'].map((h) => md.indexOf(`### ${h}`));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), 'sections in signal order');
    assert.match(md, /\*\*HIGH\*\* stale forever \(\*\*A2\*\*\)/);
    assert.match(md, /- \*\*A2\*\* Human: 20 instances\n {2}AI changed: added TODO/);
    assert.ok(md.indexOf('`missing`') < md.indexOf('`done`'), 'misses before confirmations');
    assert.match(md, /A = session sess-aaa "Rates" · B = session sess-bbb/);
    assert.doesNotMatch(md, /### Decisions/, 'empty sections are omitted');
  });
});

test('temp dirs are not leaked into the render (sanity for path stripping on macOS-style roots)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pl-root-')) + '/';
  const strip = makeStripper(deriveRootPrefixes([`${root}a/b.ts`], new Set(['a/b.ts'])));
  assert.equal(strip(`${root}a/b.ts and ${root}c.ts`), 'a/b.ts and c.ts');
});
