// "What changed, and why" (src/quick/overview.ts) with fake models: the model's grouping is parsed, then checked
// against the PR and its conversation (quotes verbatim, turns and files real, who said it from the data), cached, and
// rendered at the top of the PR page, written or waiting.
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { assembleReview } from '../src/core/review.ts';
import { buildOverview, cachedOverview, findVerbatim, overviewCachePath, overviewKey, verifyOverview, type Gemini, type GeminiRequest, type OverviewInput } from '../src/quick/index.ts';
import type { QuickModule } from '../src/viewer/integrations.ts';
import { buildPrModel, overviewInput } from '../src/viewer/model.ts';
import { renderPrPage } from '../src/viewer/pr.ts';
import { startServer, type RunningServer } from '../src/viewer/server.ts';
import { cloneDemo, demoIds } from './helpers.ts';

const { sessionA: A, sessionB: B } = demoIds();
const a8 = A.slice(0, 8);
const b8 = B.slice(0, 8);
const repo = cloneDemo();
after(() => rmSync(repo, { recursive: true, force: true }));

const inputFor = (): OverviewInput => overviewInput(repo, assembleReview(repo, 'main', 'feature/rates'), 'feature/rates')!;

/** What the fake model "writes": one real change with good and bad references, one with a made-up quote, one ghost. */
const REPLY = {
  pieces: [{ turn: `${a8}#1`, did: ['cached /rates endpoint'] }],
  summary: 'Rates come from a cached <b>/rates</b> endpoint, with tests.',
  changes: [
    {
      title: 'A cached /rates endpoint.',
      what: 'Serves exchange rates and keeps them for a while.',
      why: { turn: `${a8}#1`, from: 'ask', quote: "Cache the upstream response so we don't hit the API on every request." },
      alsoWhy: [
        // Turn "1" is in both sessions, so it can't be resolved; the quote is only in A's turn 2, so it moves there.
        { turn: '1', from: 'ask', quote: "make the TTL configurable via env, don't hardcode USD" },
        // Said by Claude, not asked: `from` comes from where the words are. The model dropped the markdown marks.
        { turn: `${a8}#1`, from: 'ask', quote: "Added a /rates endpoint that uses Node's built-in fetch" },
      ],
      tried: [],
      turns: [`${a8}#1`, `turn ${a8}#2`, `${a8}#9`],
      files: ['src/server.js', 'nope.js'],
    },
    {
      title: 'Tests',
      what: 'Adds tests for the rates handler.',
      why: { turn: `${b8}#1`, from: 'ask', quote: 'the model made these words up entirely' },
      alsoWhy: [],
      tried: [],
      turns: [`${b8}#1`],
      files: ['rates.test.js'],
    },
    { title: 'Ghost', what: 'Nothing real.', why: { turn: '99', from: 'ask', quote: 'the' }, alsoWhy: [], tried: [], turns: ['99'], files: ['ghost.js'] },
  ],
};

/** Map calls get notes; overview calls get `reply` (a function of the call number, for retries). */
function fakeGemini(reply: (n: number) => string = () => JSON.stringify(REPLY)): { gemini: Gemini; calls: GeminiRequest[]; overviewCalls: () => number } {
  const calls: GeminiRequest[] = [];
  let n = 0;
  const gemini: Gemini = async (req) => {
    calls.push(req);
    const schema = JSON.stringify(req.jsonSchema ?? {});
    if (schema.includes('"asked"')) {
      const turns = [...req.prompt.matchAll(/^## Turn (\d+)$/gm)].map((m) => Number(m[1]));
      return { text: JSON.stringify({ turns: turns.map((t) => ({ turn: t, asked: `ask ${t}`, did: `did ${t}`, beyond: [], decided: [], deferred: [], minor: false })) }), model: 'gemini-fake', usage: { inputTokens: 10, outputTokens: 5 } };
    }
    return { text: reply(n++), model: 'gemini-fake', usage: { inputTokens: 100, outputTokens: 50 } };
  };
  return { gemini, calls, overviewCalls: () => n };
}

describe('quotes are looked up in the real text', () => {
  test('a quote from a message that arrived mid-turn is credited to whoever sent it', () => {
    const input = inputFor();
    const turn = input.items.find((i) => i.sessionId === A)!.turns.find((t) => t.index === 2)!;
    turn.items.push({ kind: 'event', subtype: 'midturn', text: 'also please add a stop button for runs', from: 'Blog SEO audit' });
    turn.items.push({ kind: 'event', subtype: 'midturn', text: 'and bump the versions while you are at it' });
    const reply = {
      summary: 'Stop button.',
      changes: [
        { title: 'A stop button', what: 'Adds one.', why: { turn: `${a8}#2`, from: 'ask', quote: 'please add a stop button for runs' }, alsoWhy: [{ turn: `${a8}#2`, from: 'ask', quote: 'bump the versions while you are at it' }], tried: [], turns: [`${a8}#2`], files: ['src/server.js'] },
      ],
    };
    const v = verifyOverview(JSON.stringify(reply), input);
    assert.equal(v.changes.length, 1);
    assert.deepEqual([v.changes[0]!.why!.who, v.changes[0]!.why!.kind], ['Blog SEO audit', 'agent']);
    assert.equal(v.changes[0]!.alsoWhy[0]!.kind, 'person');
  });

  test('findVerbatim returns the exact span, allowing only whitespace, markdown marks and quote-mark differences', () => {
    const src = 'Added a `/rates` endpoint that uses **Node\'s** built-in `fetch`\n(no packages added).';
    assert.equal(findVerbatim(src, 'uses **Node\'s** built-in'), 'uses **Node\'s** built-in');
    assert.equal(findVerbatim(src, '"Added a /rates endpoint that uses Node’s built-in fetch (no packages added)."'), src.slice(0, src.length));
    assert.equal(findVerbatim(src, '...built-in fetch (no packages…'), 'built-in `fetch`\n(no packages');
    assert.equal(findVerbatim(src, 'uses Deno instead'), null);
    assert.equal(findVerbatim(src, 'that uses Node\'s built-in fetch'), 'that uses **Node\'s** built-in `fetch`', 'marks around the span are taken in');
    assert.equal(findVerbatim('[image]\nwtf!?  i thought we did this', '[image]\nwtf!?  i thought we did this'), 'wtf!?  i thought we did this', '[image] is not anyone\'s words');
  });
});

describe('verifyOverview', () => {
  test('keeps the grouping, drops what does not check out, and takes who said it from the data', () => {
    const v = verifyOverview(JSON.stringify(REPLY), inputFor());
    assert.equal(v.summary, 'Rates come from a cached <b>/rates</b> endpoint, with tests.');
    assert.equal(v.changes.length, 2, 'the ghost change has nothing real to point at');
    const [rates, tests] = v.changes;
    assert.equal(rates!.title, 'A cached /rates endpoint', 'no trailing period');
    assert.deepEqual(rates!.why, { sessionId: A, turn: 1, from: 'ask', quote: "Cache the upstream response so we don't hit the API on every request.", who: 'Dana Dev', kind: 'person' });
    assert.deepEqual(
      rates!.alsoWhy.map((q) => [q.turn, q.from, q.who, q.kind, q.quote]),
      [
        [2, 'ask', 'Dana Dev', 'person', "make the TTL configurable via env, don't hardcode USD"],
        [1, 'reply', 'Claude', 'claude', "Added a `/rates` endpoint that uses Node's built-in `fetch`"],
      ],
    );
    assert.deepEqual(rates!.turns, [{ sessionId: A, turn: 1 }, { sessionId: A, turn: 2 }], 'turn 9 does not exist');
    assert.deepEqual(rates!.files, ['src/server.js']);
    assert.equal(tests!.why, undefined, 'a made-up quote is dropped, the change stays');
    assert.deepEqual(tests!.turns, [{ sessionId: B, turn: 1 }]);
    assert.deepEqual(tests!.files, ['test/rates.test.js'], 'a bare file name resolves to the one PR path ending with it');
    assert.deepEqual(v.dropped, { quotes: 2, turns: 2, files: 2, changes: 1 });
  });

  test('not JSON is an error, not an empty overview', () => {
    assert.throws(() => verifyOverview('Sorry, I cannot help with that.', inputFor()), /not JSON/);
  });
});

describe('buildOverview', () => {
  test('one call over the turn notes and the turns, cached by range and session commits', async () => {
    const input = inputFor();
    rmSync(overviewCachePath(repo, overviewKey(input)), { force: true });
    const { gemini, calls, overviewCalls } = fakeGemini();
    const o = await buildOverview(repo, input, { gemini });
    assert.equal(overviewCalls(), 1);
    const call = calls.find((c) => JSON.stringify(c.jsonSchema).includes('"pieces"'))!;
    assert.match(call.prompt, new RegExp(`## Turn ${a8}#2\\nFrom: Dana Dev\\nWrote in this PR: src/server\\.js \\(\\+\\d+ -\\d+\\)`));
    assert.match(call.prompt, /Note \(model-written, not quotable\): did: did 2/, 'reads the layer-1 notes');
    assert.match(call.prompt, /Request, word for word:\n"""\nHmm, we run ~20 instances behind a load balancer/, 'and the requests verbatim');
    assert.match(call.prompt, /Commits, oldest first:\n- /);
    assert.equal(o.changes.length, 2);
    assert.equal(o.model, 'gemini-fake');
    assert.ok(existsSync(overviewCachePath(repo, o.key)));

    const n = calls.length;
    const again = await buildOverview(repo, inputFor(), { gemini });
    assert.equal(calls.length, n, 'a cache hit makes no model call');
    assert.deepEqual(again, o);
    assert.deepEqual(cachedOverview(repo, inputFor()), o, 'the page can read it without a model');
    await buildOverview(repo, inputFor(), { gemini, refresh: true });
    assert.equal(overviewCalls(), 2, 'refresh writes it again');
  });

  test('a reply that is not JSON gets one more try; an overview with nothing real in it is not cached', async () => {
    const input = inputFor();
    rmSync(overviewCachePath(repo, overviewKey(input)), { force: true });
    const flaky = fakeGemini((n) => (n === 0 ? '{"summary": "cut sh' : JSON.stringify(REPLY)));
    await buildOverview(repo, input, { gemini: flaky.gemini });
    assert.equal(flaky.overviewCalls(), 2);

    rmSync(overviewCachePath(repo, overviewKey(input)), { force: true });
    const ghost = fakeGemini(() => JSON.stringify({ pieces: [], summary: 'x', changes: [REPLY.changes[2]] }));
    await assert.rejects(buildOverview(repo, input, { gemini: ghost.gemini }), /did not check out/);
    assert.equal(cachedOverview(repo, input), null);
  });
});

describe('PR page', () => {
  test('written: the overview leads the page, model text escaped and marked, quotes with who said them', async () => {
    const input = inputFor();
    await buildOverview(repo, input, { gemini: fakeGemini().gemini });
    const html = renderPrPage(buildPrModel(repo, 'main', 'feature/rates', assembleReview(repo, 'main', 'feature/rates')));
    const at = (s: string) => html.indexOf(s);
    assert.ok(at('id="overview"') > 0 && at('id="overview"') < at('id="conversation"'), 'above the conversation');
    assert.doesNotMatch(html, /data-src="\/api\/overview/, 'server-rendered from the cache');
    assert.match(html, /<p class="ov-sum ov-model">Rates come from a cached &lt;b&gt;\/rates&lt;\/b&gt; endpoint, with tests\.<\/p>/);
    assert.match(html, /summary written by a model from the conversation/);
    assert.match(html, new RegExp(`<blockquote class="ov-q k-person"><span class="ov-who">Dana Dev</span> <q>Cache the upstream response so we don&#39;t hit the API on every request\\.</q> <a class="ov-turn" href="#t-${a8}-1">turn 1</a></blockquote>`));
    assert.match(html, /<blockquote class="ov-q k-claude"><span class="ov-who">Claude<\/span> <q>Added a \/rates endpoint that uses Node&#39;s built-in fetch<\/q>/, 'markdown marks dropped for reading');
    assert.match(html, /<a class="ov-chip f" href="#file-\d+" title="test\/rates\.test\.js">rates\.test\.js/);
    assert.match(html, /<details class="pr-file" id="file-\d+">/, 'file chips land on the Files section');
    assert.match(html, /Who drove the code: <b>100%<\/b> answering <span class="ov-name k-person">Dana Dev<\/span>/);
  });

  test('not written yet: the same frame with room reserved, filled from /api/overview', () => {
    rmSync(overviewCachePath(repo, overviewKey(inputFor())), { force: true });
    const m = buildPrModel(repo, 'main', 'feature/rates', assembleReview(repo, 'main', 'feature/rates'));
    assert.equal(m.overview?.data, undefined);
    m.overview!.src = '/api/overview?base=main&head=feature%2Frates';
    const html = renderPrPage(m);
    assert.match(html, /<section id="overview" class="ov" data-src="\/api\/overview\?base=main&amp;head=feature%2Frates" aria-busy="true">/);
    assert.match(html, /Writing the overview from the conversation/);
    assert.equal(html.split('class="ov-skel"').length - 1, m.overview!.expect, 'reserved room');
    assert.match(html, /Who drove the code: <b>100%<\/b>/, 'the facts need no model');
  });
});

describe('viewer server', () => {
  let srv: RunningServer;
  let off: RunningServer;
  const fake = fakeGemini();
  const quick: QuickModule = {
    repoGeminiClient: () => fake.gemini,
    decisionClient: () => ({}),
    buildGlance: async () => {
      throw new Error('not used here');
    },
    buildOverview: (cwd, input, opts) => buildOverview(cwd, input, opts),
    quickAsk: async () => {
      throw new Error('not used here');
    },
  };
  before(async () => {
    rmSync(overviewCachePath(repo, overviewKey(inputFor())), { force: true });
    srv = await startServer({ cwd: repo, port: 0, modules: { ask: null, summarize: null, quick } });
    off = await startServer({ cwd: repo, port: 0, modules: { ask: null, summarize: null, quick: null } });
  });
  after(async () => {
    await srv.close();
    await off.close();
  });

  test('the page waits, /api/overview writes it once, and later pages render it straight away', async () => {
    const page = await (await fetch(`${srv.url}/review?base=main&head=feature%2Frates`)).text();
    assert.match(page, /data-src="\/api\/overview\?base=main&amp;head=feature%2Frates"/);
    const res = await fetch(`${srv.url}/api/overview?base=main&head=feature%2Frates`);
    const data = (await res.json()) as { ok: boolean; html: string };
    assert.equal(res.status, 200);
    assert.match(data.html, /^<section id="overview" class="ov">/);
    assert.match(data.html, /class="ov-chg"/);
    const n = fake.overviewCalls();
    const again = await (await fetch(`${srv.url}/review?base=main&head=feature%2Frates`)).text();
    assert.doesNotMatch(again, /data-src="\/api\/overview/);
    assert.match(again, /A cached \/rates endpoint/);
    assert.equal(fake.overviewCalls(), n);
  });

  test('without a text model the page says so and keeps the facts', async () => {
    rmSync(overviewCachePath(repo, overviewKey(inputFor())), { force: true });
    const page = await (await fetch(`${off.url}/review?base=main&head=feature%2Frates`)).text();
    assert.match(page, /No written overview here: /);
    assert.match(page, /Who drove the code/);
    assert.doesNotMatch(page, /data-src="\/api\/overview/);
    assert.equal((await fetch(`${off.url}/api/overview?base=main&head=feature%2Frates`)).status, 501);
  });
});
