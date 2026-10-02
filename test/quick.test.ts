// Deterministic tests for src/quick (no network): Jev/Gemini clients against a fake fetch, the per-turn map cache,
// turn picking and verdicts, and quickAsk end to end on the demo repo with fake models.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { listAsks } from '../src/ask/index.ts';
import { loadSession } from '../src/core/store.ts';
import {
  decisionClient,
  directVerdict,
  geminiClient,
  jevClient,
  loadQuickConfig,
  mapCachePath,
  repoGeminiClient,
  userConfigPath,
  parseJsonLoose,
  parseNotes,
  pickTurns,
  quickAsk,
  resolveScope,
  sessionMap,
  verdictFor,
  type Gemini,
  type GeminiRequest,
  type Jev,
  type JevRequest,
  type TurnScore,
} from '../src/quick/index.ts';
import { PL } from './capture-helpers.ts';
import { cloneDemo, demoIds, tempRepo } from './helpers.ts';

const { sessionA, sessionB } = demoIds();
const repo = cloneDemo();
after(() => rmSync(repo, { recursive: true, force: true }));

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetch that records calls and replies from a queue of [status, body] pairs. */
function fakeFetch(replies: [number, unknown][]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const [status, body] = replies.shift() ?? [500, { error: 'no more replies' }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
const noSleep = async () => {};

function withoutEnv<T>(names: string[], fn: () => T): T {
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) delete process.env[n];
  try {
    return fn();
  } finally {
    for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
  }
}

describe('jev client', () => {
  test('posts state + typed questions with a bearer key and returns answers', async () => {
    const { fetch, calls } = fakeFetch([[200, { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 42, output_tokens: 3 } }]]);
    const jev = jevClient({ apiKey: 'k1', fetch, sleep: noSleep });
    const res = await jev({ state: { question: 'x' }, questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0]!.headers.authorization, 'Bearer k1');
    assert.equal(calls[0]!.body.model, 'jev-latest');
    assert.deepEqual(calls[0]!.body.questions.q, { type: 'noul', instructions: 'Is it?' });
    assert.equal(res.model, 'jev-1.13.0');
    assert.equal(res.usage.input_tokens, 42);
  });

  test('retries rate limits and overloads, then gives up with the status', async () => {
    const ok = { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
    const a = fakeFetch([[429, {}], [529, {}], [200, ok]]);
    await jevClient({ apiKey: 'k', fetch: a.fetch, sleep: noSleep })({ state: 's', questions: {} });
    assert.equal(a.calls.length, 3);
    const b = fakeFetch([[401, { detail: 'bad key' }]]);
    await assert.rejects(jevClient({ apiKey: 'k', fetch: b.fetch, sleep: noSleep })({ state: 's', questions: {} }), /Jev failed: HTTP 401.*bad key/);
    assert.equal(b.calls.length, 1, 'no retry on 401');
  });

  test('without a key, says which env var to set', () => {
    withoutEnv(['TYPESAFE_API_KEY'], () => assert.throws(() => jevClient(), /TYPESAFE_API_KEY/));
  });
});

describe('decision endpoint config', () => {
  const cfgRepo = tempRepo();
  after(() => rmSync(cfgRepo, { recursive: true, force: true }));
  const writeCfg = (body: string) => {
    mkdirSync(join(cfgRepo, '.promptlog'), { recursive: true });
    writeFileSync(join(cfgRepo, '.promptlog/config.local.json'), body);
  };

  test('loadQuickConfig: missing is empty, bad JSON and non-https URLs are errors', () => {
    assert.deepEqual(loadQuickConfig(cfgRepo), {});
    writeCfg('{nope');
    assert.throws(() => loadQuickConfig(cfgRepo), /config\.local\.json: not valid JSON/);
    writeCfg(JSON.stringify({ decision: { url: 'http://example.com/v1/systemone', apiKey: 'k' } }));
    assert.throws(() => loadQuickConfig(cfgRepo), /must start with https/);
  });

  test('decisionClient posts to the configured endpoint (e.g. Dopp) with its bearer key', async () => {
    writeCfg(JSON.stringify({ decision: { url: 'https://dopp.example/v1/systemone', apiKey: 'us_test' } }));
    const { fetch, calls } = fakeFetch([
      [200, { model: 'understudy/ab12-v3', answers: { q: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 9, output_tokens: 0 }, understudy: { served: 'model' } }],
      [402, { error: 'allowance used up' }],
    ]);
    const jev = withoutEnv(['TYPESAFE_API_KEY'], () => decisionClient(cfgRepo, { fetch, sleep: noSleep }));
    const res = await jev({ state: 's', questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    assert.equal(calls[0]!.url, 'https://dopp.example/v1/systemone');
    assert.equal(calls[0]!.headers.authorization, 'Bearer us_test');
    assert.equal(calls[0]!.body.model, 'jev-latest', 'same request shape as TypeSafe');
    assert.equal(res.model, 'understudy/ab12-v3');
    await assert.rejects(jev({ state: 's', questions: {} }), /Decision API \(dopp\.example\) failed: HTTP 402/);
  });

  test('repoGeminiClient takes its key and model from the config', async () => {
    writeCfg(JSON.stringify({ gemini: { apiKey: 'g-cfg', model: 'gemini-test-flash' } }));
    const { fetch, calls } = fakeFetch([[200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]]);
    const gemini = withoutEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY'], () => repoGeminiClient(cfgRepo, { fetch, sleep: noSleep }));
    assert.equal((await gemini({ prompt: 'hi' })).text, 'ok');
    assert.equal(calls[0]!.headers['x-goog-api-key'], 'g-cfg');
    assert.match(calls[0]!.url, /models\/gemini-test-flash:generateContent$/);
  });

  test('keys in ~/.config/promptlog/config.json work in every repo; a repo file overrides them field by field', () => {
    const home = userConfigPath();
    mkdirSync(dirname(home), { recursive: true });
    writeFileSync(home, JSON.stringify({ decision: { url: 'https://dopp.example/v1/systemone', apiKey: 'us_home' }, gemini: { apiKey: 'g-home' } }));
    try {
      assert.match(home, /pl-xdg-.*\/promptlog\/config\.json$/, 'tests use a temp XDG_CONFIG_HOME, never the real one');
      rmSync(join(cfgRepo, '.promptlog'), { recursive: true, force: true });
      assert.deepEqual(loadQuickConfig(cfgRepo), { decision: { url: 'https://dopp.example/v1/systemone', apiKey: 'us_home' }, gemini: { apiKey: 'g-home' } });
      writeCfg(JSON.stringify({ decision: { apiKey: 'us_repo' }, gemini: { model: 'gemini-x' } }));
      assert.deepEqual(loadQuickConfig(cfgRepo), { decision: { url: 'https://dopp.example/v1/systemone', apiKey: 'us_repo' }, gemini: { apiKey: 'g-home', model: 'gemini-x' } });
      writeFileSync(home, '{oops');
      assert.throws(() => loadQuickConfig(cfgRepo), /~\/\.config\/promptlog\/config\.json: not valid JSON/);
    } finally {
      rmSync(home, { force: true });
    }
  });

  test('a configured URL without a key says where to put it', () => {
    writeCfg(JSON.stringify({ decision: { url: 'https://dopp.example/v1/systemone' } }));
    withoutEnv(['TYPESAFE_API_KEY'], () => assert.throws(() => decisionClient(cfgRepo), /add decision\.apiKey to ~\/\.config\/promptlog\/config\.json/));
  });
});

describe('gemini client', () => {
  test('generateContent request: model in the URL, key header, system prompt, JSON schema', async () => {
    const { fetch, calls } = fakeFetch([
      [200, { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 7 }, modelVersion: 'gemini-3.8-flash-001' }],
    ]);
    const res = await geminiClient({ apiKey: 'g1', fetch, sleep: noSleep })({ system: 'sys', prompt: 'hi', jsonSchema: { type: 'object' }, thinkingLevel: 'LOW' });
    assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(calls[0]!.headers['x-goog-api-key'], 'g1');
    assert.deepEqual(calls[0]!.body.systemInstruction, { parts: [{ text: 'sys' }] });
    assert.deepEqual(calls[0]!.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.equal(calls[0]!.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(calls[0]!.body.generationConfig.responseJsonSchema, { type: 'object' });
    assert.deepEqual(calls[0]!.body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.equal(res.text, '{"a":1}', 'thought parts are dropped');
    assert.deepEqual(res.usage, { inputTokens: 100, outputTokens: 12 });
    assert.equal(res.model, 'gemini-3.8-flash-001');
  });

  test('a blocked or empty reply is an error; a missing key names GEMINI_API_KEY', async () => {
    const { fetch } = fakeFetch([[200, { promptFeedback: { blockReason: 'SAFETY' } }]]);
    await assert.rejects(geminiClient({ apiKey: 'g', fetch, sleep: noSleep })({ prompt: 'x' }), /SAFETY/);
    withoutEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY'], () => assert.throws(() => geminiClient(), /GEMINI_API_KEY/));
  });

  test('parseJsonLoose tolerates fences and surrounding prose', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"x":1}\n```'), { x: 1 });
    assert.deepEqual(parseJsonLoose('Here you go: {"x":2} hope that helps'), { x: 2 });
    assert.throws(() => parseJsonLoose('nope'));
  });
});

// ---------------------------------------------------------------------------
// Fakes for the pipeline
// ---------------------------------------------------------------------------

/** Gemini fake: map calls get "did <N>" notes for every "## Turn N"; answer calls get a fixed reply. */
function fakeGemini(): { gemini: Gemini; calls: GeminiRequest[] } {
  const calls: GeminiRequest[] = [];
  const gemini: Gemini = async (req) => {
    calls.push(req);
    if (req.jsonSchema) {
      const turns = [...req.prompt.matchAll(/^## Turn (\d+)$/gm)].map((m) => Number(m[1]));
      const text = JSON.stringify({ turns: turns.map((t) => ({ turn: t, did: `did ${t}`, decided: [], deferred: t === 2 ? ['shared cache (Redis)'] : [] })) });
      return { text, model: 'gemini-fake', usage: { inputTokens: 1000, outputTokens: 100 } };
    }
    return { text: 'No. Redis was deferred in turn 2; the cache is per process.', model: 'gemini-fake', usage: { inputTokens: 5000, outputTokens: 50 } };
  };
  return { gemini, calls };
}

/** Jev fake: a turn is about Redis if its card mentions it; turn 2 of the demo defers it with a TODO. */
function fakeJev(): { jev: Jev; calls: JevRequest[] } {
  const calls: JevRequest[] = [];
  const jev: Jev = async (req) => {
    calls.push(req);
    const text = JSON.stringify((req.state as { turn?: unknown }).turn ?? '');
    const about = /redis/i.test(text);
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const id of Object.keys(req.questions)) {
      const p =
        id === 'is_check' || id === 'answerable' ? 0.9
        : id === 'answer' ? 0.1
        : id === 'relevant' || id === 'evidence' ? (about ? 0.9 : 0.05)
        : id === 'not_handled' ? (about && /TODO|Don't build Redis/i.test(text) ? 0.85 : 0.05)
        : 0.05;
      answers[id] = { type: 'noul', noul: p };
    }
    return { model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 10 } };
  };
  return { jev, calls };
}

const score = (turn: number, relevant: number, evidence: number, handled = 0, notHandled = 0): TurnScore => ({ sessionId: 's', turn, relevant, evidence, handled, notHandled });

describe('picking turns and verdicts', () => {
  test('pickTurns: best strong matches in conversation order, else two weak ones, else none', () => {
    const strong = [score(1, 0.9, 0.2), score(2, 0.8, 0.9), score(3, 0.95, 0.95), score(4, 0.6, 0.7)];
    assert.deepEqual(pickTurns(strong, 2).map((s) => s.turn), [2, 3]);
    const weak = [score(1, 0.3, 0.1), score(2, 0.4, 0.4), score(3, 0.25, 0.3), score(4, 0.1, 0.9)];
    assert.deepEqual(pickTurns(weak, 4).map((s) => s.turn), [2, 3]);
    assert.deepEqual(pickTurns([score(1, 0.1, 0.1)], 4), []);
  });

  test('directVerdict: Jev\'s yes/no to the question; unsure or unanswerable is "unclear"', () => {
    assert.deepEqual(directVerdict(0.9, 0.9), { label: 'yes', confidence: 0.9 });
    assert.deepEqual(directVerdict(0.1, 0.9, { label: 'no', confidence: 1, sessionId: 's', turn: 3 }), { label: 'no', confidence: 0.9, sessionId: 's', turn: 3 });
    assert.equal(directVerdict(0.5, 0.9).label, 'unclear');
    assert.equal(directVerdict(0.95, 0.2).label, 'unclear');
  });

  test('verdictFor: the latest decisive turn wins', () => {
    assert.equal(verdictFor([score(1, 0.1, 0.1)]).label, 'not discussed');
    const deferredThenDone = verdictFor([score(1, 0.9, 0.9, 0.1, 0.9), score(2, 0.9, 0.9, 0.8, 0.1), score(3, 0.2, 0.2, 0, 0)]);
    assert.deepEqual(deferredThenDone, { label: 'yes', confidence: 0.8, sessionId: 's', turn: 2 });
    assert.equal(verdictFor([score(1, 0.9, 0.9, 0.9, 0.1), score(2, 0.9, 0.9, 0.1, 0.7)]).label, 'no');
    assert.equal(verdictFor([score(1, 0.9, 0.9, 0.7, 0.7)]).label, 'partly');
    assert.equal(verdictFor([score(1, 0.9, 0.9, 0.3, 0.2)]).label, 'unclear');
  });
});

describe('scope', () => {
  test('a session prefix is the whole session; a range is the slices behind it', () => {
    const s = resolveScope(repo, sessionA.slice(0, 6));
    assert.equal(s.label, `session ${sessionA.slice(0, 8)}`);
    assert.deepEqual(s.sessions.map((x) => x.turns.map((t) => t.index)), [[1, 2, 3, 4]]);
    const r = resolveScope(repo, 'main..feature/rates');
    assert.deepEqual(r.sessions.map((x) => [x.session.meta.sessionId, x.turns.map((t) => t.index)]), [[sessionA, [1, 2, 3, 4]], [sessionB, [1]]]);
    assert.throws(() => resolveScope(repo, 'main..main'), /no captured conversations/);
  });
});

describe('map', () => {
  test('parseNotes keeps only asked-for turns and cleans the arrays', () => {
    const text = JSON.stringify({ turns: [{ turn: 1, asked: ' fix it ', did: ' a ', decided: ['x', 3, ''], deferred: 'nope', minor: true }, { turn: 9, did: 'b' }, { turn: 1, did: 'dup' }] });
    assert.deepEqual(parseNotes(text, new Set([1, 2])), [{ turn: 1, asked: 'fix it', did: 'a', beyond: [], decided: ['x'], deferred: [], minor: true }]);
  });

  test('notes are cached per turn: the second run sends nothing', async () => {
    const session = loadSession(repo, sessionA)!;
    const { gemini, calls } = fakeGemini();
    const first = await sessionMap(repo, sessionA, session.turns, { gemini });
    assert.equal(first.built, 4);
    assert.equal(calls.length, 1, 'one Gemini call for a small session');
    assert.equal(first.notes.get(2)?.deferred[0], 'shared cache (Redis)');
    assert.ok(existsSync(mapCachePath(repo, sessionA)));
    const second = await sessionMap(repo, sessionA, session.turns, { gemini });
    assert.equal(second.built, 0);
    assert.equal(calls.length, 1);
    assert.equal(second.notes.size, 4);
  });

  test('big sessions are split across calls', async () => {
    const session = loadSession(repo, sessionA)!;
    rmSync(mapCachePath(repo, sessionA), { force: true });
    const { gemini, calls } = fakeGemini();
    const res = await sessionMap(repo, sessionA, session.turns, { gemini, maxTurnsPerCall: 3 });
    assert.equal(calls.length, 2);
    assert.equal(res.notes.size, 4);
  });
});

describe('quickAsk', () => {
  test('scores every turn, answers from the relevant one with its diff, gives a verdict, saves the ask', async () => {
    const g = fakeGemini();
    const j = fakeJev();
    const res = await quickAsk({ cwd: repo, question: 'Did it add a shared cache like Redis?', target: 'main..feature/rates', jev: j.jev, gemini: g.gemini, askedBy: 'Rita <rita@example.com>' });

    assert.equal(j.calls.length, 5 + 1 + 1, 'one Jev request per turn, one on the question, one to answer it');
    assert.equal(res.quick.scores.length, 5);
    assert.deepEqual(res.quick.used, [{ sessionId: sessionA, turn: 2 }]);
    assert.deepEqual(res.quick.verdict, { label: 'no', confidence: 0.9, sessionId: sessionA, turn: 2 });
    const direct = j.calls.find((c) => 'answer' in c.questions)!;
    assert.deepEqual(direct.questions.answer, { type: 'noul', instructions: 'Did it add a shared cache like Redis?' }, 'Jev answers the question as asked');
    assert.ok(JSON.stringify(direct.state).includes('Redis'), 'from the notes and the picked turns');
    assert.equal(res.sessionId, sessionA);
    assert.equal(res.turn, 2);
    assert.match(res.answer, /deferred in turn 2/);
    assert.equal(res.quick.lead, 'no', 'the answer starts with "No."');
    assert.equal(res.model, 'jev-1.13.0 + gemini-fake');
    assert.equal(res.quick.usage.jevRequests, 7);

    const answerCall = g.calls.find((c) => !c.jsonSchema)!;
    assert.match(answerCall.prompt, /Reviewer's question: Did it add a shared cache like Redis\?/);
    assert.match(answerCall.prompt, new RegExp(`### ${sessionA.slice(0, 8)} turn 2`), 'multi-session labels');
    assert.match(answerCall.prompt, /```diff[\s\S]*RATES_CACHE_TTL_MS/, "the turn's code diff is included");
    assert.match(answerCall.prompt, /Jev\) answered the question directly .*"no" \(90% sure/);
    assert.doesNotMatch(answerCall.prompt, new RegExp(`### ${sessionB.slice(0, 8)} turn 1`), 'irrelevant turns only appear in the outline');

    const saved = listAsks(repo, sessionA, { turn: 2 }).find((a) => a.id === res.id)!;
    assert.equal(saved.quick?.verdict?.label, 'no');
    assert.equal(saved.askedBy, 'Rita <rita@example.com>');
  });

  test('no verdict for open questions; nothing relevant still gets an honest answer', async () => {
    const g = fakeGemini();
    const jev: Jev = async (req) => ({
      model: 'jev-1.13.0',
      answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: 'noul' as const, noul: 0.02 }])),
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const res = await quickAsk({ cwd: repo, question: 'What database does it use?', target: sessionB.slice(0, 8), jev, gemini: g.gemini, save: false });
    assert.equal(res.quick.verdict, undefined);
    assert.deepEqual(res.quick.used, []);
    assert.match(g.calls.find((c) => !c.jsonSchema)!.prompt, /No turn looked relevant/);
    assert.equal(listAsks(repo, sessionB).length, 0, 'save: false');
  });
});

describe('quickAsk resilience', () => {
  test('a failing map step is reported and the ask still answers', async () => {
    const g = fakeGemini();
    const flaky: Gemini = async (req) => {
      if (req.jsonSchema) throw new Error('Gemini failed: HTTP 500');
      return g.gemini(req);
    };
    const msgs: string[] = [];
    rmSync(mapCachePath(repo, sessionA), { force: true });
    const res = await quickAsk({ cwd: repo, question: 'Did it add Redis?', target: sessionA, jev: fakeJev().jev, gemini: flaky, save: false, onProgress: (m) => msgs.push(m) });
    assert.ok(msgs.some((m) => /map for .* failed, continuing without it/.test(m)));
    assert.ok(res.answer.length > 0);
    assert.deepEqual(res.quick.used, [{ sessionId: sessionA, turn: 2 }]);
  });
});

describe('cli', () => {
  test('`promptlog ask "q"` without keys fails fast and says what to set', () => {
    const env = { ...process.env };
    for (const k of ['TYPESAFE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete env[k];
    const r = spawnSync(PL, ['ask', 'main..feature/rates', 'did it add Redis?'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TYPESAFE_API_KEY/);
    const keep = spawnSync(PL, ['ask', '--keep', 'did it add Redis?'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(keep.status, 1);
    assert.match(keep.stderr, /--keep only applies with --at/);
  });
});
