// "At a glance" + code search + the viewer's new layout, with fake models (no network).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { isCommandPrompt } from '../src/core/transcript.ts';
import type { AskResult, Glance } from '../src/core/types.ts';
import { git } from '../src/core/git.ts';
import { loadSession } from '../src/core/store.ts';
import {
  addedLines,
  basicGlance,
  buildGlance,
  diffSpots,
  diffWindow,
  displayPrompt,
  findLeftovers,
  grepAt,
  quickAsk,
  removedNames,
  sanitizePatterns,
  type Gemini,
  type GeminiRequest,
  type Jev,
} from '../src/quick/index.ts';
import type { QuickModule } from '../src/viewer/integrations.ts';
import { buildReviewModel, buildSessionModel, sessionDiff } from '../src/viewer/model.ts';
import { renderReviewPage, renderSessionPage } from '../src/viewer/render.ts';
import { startServer, type RunningServer } from '../src/viewer/server.ts';
import type { Features } from '../src/viewer/types.ts';
import { cloneDemo, demoIds } from './helpers.ts';

const { sessionA: A, sessionB: B } = demoIds();
const repo = cloneDemo();
after(() => rmSync(repo, { recursive: true, force: true }));

const DIFF = `diff --git a/app.mjs b/app.mjs
index 1111111..2222222 100644
--- a/app.mjs
+++ b/app.mjs
@@ -10,4 +10,6 @@ import x from 'y';
 const a = 1;
-const url = 'https://api.typesafe.ai/v1/systemone';
+const jev = (env) => ({ endpoint: env.JEV_ENDPOINT ?? 'https://dopp.sh/v1/systemone' });
+
 export default a;
@@ -80,3 +82,3 @@ function ask() {
-  return createJevClient({ apiKey: env.TYPESAFE_API_KEY });
+  return createJevClient(jev(env));
 }
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-too
`;

describe('model-free glance', () => {
  test('diffSpots: each hunk shows its replacement as a removed/added pair, in hunk order', () => {
    const spots = diffSpots(DIFF);
    assert.deepEqual(spots.get('app.mjs')?.spots.map((s) => [s.kind, s.line]), [['del', 11], ['add', 11], ['del', 80], ['add', 82]]);
    assert.match(spots.get('app.mjs')!.spots[0]!.text, /api\.typesafe\.ai/, 'the removed line reads first');
    assert.match(spots.get('app.mjs')!.spots[1]!.text, /dopp\.sh/);
    assert.equal(spots.get('app.mjs')!.total, 5);
    assert.deepEqual(spots.get('old.txt')?.spots.map((s) => [s.kind, s.line, s.text]), [['del', 1, 'gone'], ['del', 2, 'too']]);
  });

  test('diffWindow trims long replaced lines to the part that differs', () => {
    const pre = 'x'.repeat(200);
    const [a, b] = diffWindow(`${pre}api.typesafe.ai${pre}`, `${pre}dopp.sh${pre}`);
    assert.match(a, /^…x+api\.typesafe\.aix+…$/);
    assert.match(b, /^…x+dopp\.shx+…$/);
    assert.ok(a.length <= 142 && b.length <= 142);
    assert.deepEqual(diffWindow('short a', 'short b'), ['short a', 'short b']);
  });

  test('files list code before docs, bigger changes first', () => {
    const d = (path: string, n: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${n} @@\n${Array.from({ length: n }, (_, i) => `-old ${i}\n+new ${i}`).join('\n')}\n`;
    const g = basicGlance({ items: [], diff: d('README.md', 9) + d('a.ts', 1) + d('b.ts', 3) });
    assert.deepEqual(g.files.map((f) => f.path), ['b.ts', 'a.ts', 'README.md']);
  });

  test('terminal commands are minor turns and never the headline', () => {
    assert.ok(isCommandPrompt('!ls'));
    assert.ok(isCommandPrompt('<bash-input>promptlog install</bash-input><bash-stdout>ok</bash-stdout>'));
    assert.ok(isCommandPrompt('/compact now'));
    assert.ok(!isCommandPrompt('Swap the URL for dopp.sh'));
    assert.equal(displayPrompt('<bash-input>promptlog install</bash-input><bash-stdout>x</bash-stdout>'), '$ promptlog install');
    const turn = (index: number, prompt: string, finalResponse: string) => ({ index, prompt, finalResponse, items: [] });
    const g = basicGlance({ items: [{ sessionId: 's', turns: [turn(1, '!ls', 'Here are the files.'), turn(2, 'Swap the TypeSafe URL for dopp.sh\nmore detail', 'Done. I also updated the README.')] }], diff: DIFF, title: '!ls' });
    assert.equal(g.headline, 'Swap the TypeSafe URL for dopp.sh');
    assert.equal(basicGlance({ items: [{ sessionId: 's', turns: [turn(1, 'Use Dopp for calls. Endpoint: POST https://x/y. More.', '')] }], diff: '' }).headline, 'Use Dopp for calls.');
    assert.deepEqual(g.turns.map((t) => [t.turn, t.minor, t.asked, t.did]), [[1, true, '$ ls', 'Here are the files.'], [2, false, 'Swap the TypeSafe URL for dopp.sh', 'Done.']]);
    assert.deepEqual(g.files.map((f) => [f.path, f.why]), [['app.mjs', ''], ['old.txt', '']], 'code files, bigger first');
  });
});

/** Gemini fake: layer-1 notes for map calls, file reasons for the glance call, patterns for code search. */
function fakeGemini(): { gemini: Gemini; calls: GeminiRequest[] } {
  const calls: GeminiRequest[] = [];
  const gemini: Gemini = async (req) => {
    calls.push(req);
    const schema = JSON.stringify(req.jsonSchema ?? {});
    let text = 'The cache is keyed by base currency; RATES_CACHE_TTL_MS sets the TTL (src/server.js).';
    if (schema.includes('"asked"')) {
      const turns = [...req.prompt.matchAll(/^## Turn (\d+)$/gm)].map((m) => Number(m[1]));
      text = JSON.stringify({ turns: turns.map((t) => ({ turn: t, asked: `ask ${t}`, did: `did ${t}`, beyond: t === 2 ? ['serves stale data on upstream failure (worse data beats no data)'] : [], decided: [], deferred: [], minor: t === 3 })) });
    } else if (schema.includes('"headline"')) {
      const paths = [...req.prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      text = JSON.stringify({
        headline: 'Add a cached /rates endpoint',
        beyond: [
          { change: 'serves stale rates when the upstream fails', paths: ['src/server.js', 'not/in/diff.js'], reason: 'worse data beats no data', mentioned: true },
          { change: 'dropped the 404 handler', paths: ['src/server.js'], reason: '', mentioned: false },
          { change: '', paths: [], reason: '', mentioned: true },
        ],
        files: paths.map((p) => ({ path: p, why: `why ${p}` })),
      });
    } else if (schema.includes('"patterns"')) {
      text = JSON.stringify({ patterns: [{ text: 'RATES_CACHE_TTL_MS', regex: false }, { text: 'x', regex: false }, { text: '([', regex: true }] });
    }
    return { text, model: 'gemini-fake', usage: { inputTokens: 100, outputTokens: 10 } };
  };
  return { gemini, calls };
}

describe('glance layers', () => {
  test('turn lines come from layer-1 notes; file reasons and the headline from one cached call over notes + diffs', async () => {
    const session = loadSession(repo, A)!;
    const diff = sessionDiff(repo, session).text;
    const { gemini, calls } = fakeGemini();
    const g = await buildGlance(repo, { items: [{ sessionId: A, turns: session.turns }], diff }, { gemini });
    assert.equal(g.source, 'gemini');
    assert.equal(g.headline, 'Add a cached /rates endpoint');
    assert.deepEqual(g.turns.map((t) => [t.turn, t.asked, t.minor]), [[1, 'ask 1', false], [2, 'ask 2', false], [3, 'ask 3', true], [4, 'ask 4', false]]);
    assert.deepEqual(g.files.map((f) => [f.path, f.why]), [['src/server.js', 'why src/server.js']]);
    assert.deepEqual(g.beyond, [
      { change: 'serves stale rates when the upstream fails', paths: ['src/server.js'], reason: 'worse data beats no data', mentioned: true },
      { change: 'dropped the 404 handler', paths: ['src/server.js'], reason: '', mentioned: false },
    ], 'paths outside the diff and empty items are dropped');
    assert.ok(g.files[0]!.spots.length > 0, 'spots come from the diff');
    const glanceCall = calls.find((c) => JSON.stringify(c.jsonSchema).includes('"headline"'))!;
    assert.match(glanceCall.prompt, /turn 2: asked: ask 2 \| did: did 2\n  beyond the request: serves stale data on upstream failure/, 'layer 2/3 reads the notes');
    assert.doesNotMatch(glanceCall.prompt, /we run ~20 instances behind a load balancer/, 'not the raw chat');
    const n = calls.length;
    await buildGlance(repo, { items: [{ sessionId: A, turns: session.turns }], diff }, { gemini });
    assert.equal(calls.length, n, 'second build is fully cached');
  });
});

describe('code search', () => {
  test('sanitizePatterns drops short, duplicate and invalid patterns; grepAt reads a commit without touching the worktree', () => {
    assert.deepEqual(sanitizePatterns({ patterns: [{ text: 'ab', regex: false }, { text: 'abc', regex: false }, { text: 'abc', regex: false }, { text: '([', regex: true }, { text: 'a|b+c', regex: true }] }), [
      { text: 'abc', regex: false },
      { text: 'a|b+c', regex: true },
    ]);
    const r = grepAt(repo, 'feature/rates', { text: 'RATES_CACHE_TTL_MS', regex: false });
    assert.ok(r.total >= 1);
    assert.equal(r.hits[0]!.path, 'src/server.js');
    assert.ok(r.hits[0]!.line > 0);
    assert.equal(grepAt(repo, 'main', { text: 'RATES_CACHE_TTL_MS', regex: false }).total, 0, 'not on main');
  });

  test('a completeness question searches the code at the PR head and the answer sees the hits', async () => {
    const { gemini, calls } = fakeGemini();
    const jev: Jev = async (req) => ({
      model: 'jev-1.13.0',
      answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: 'noul' as const, noul: id === 'needs_code' || id === 'relevant' || id === 'evidence' ? 0.9 : 0.1 }])),
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const res = await quickAsk({ cwd: repo, question: 'Is the TTL configurable everywhere?', target: 'main..feature/rates', jev, gemini, save: false });
    const cs = res.quick.codeSearch!;
    assert.match(cs.where, /^feature\/rates \([0-9a-f]{8}\)$/);
    assert.deepEqual(cs.patterns.map((p) => p.text), ['RATES_CACHE_TTL_MS'], 'bad patterns were dropped');
    assert.ok(cs.patterns[0]!.matches >= 1);
    const answer = calls.find((c) => !c.jsonSchema)!;
    assert.match(answer.prompt, /Code search in feature\/rates .*\n- text `RATES_CACHE_TTL_MS`: \d+ match/);
    assert.match(answer.prompt, /src\/server\.js:\d+:/);
  });
});

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const ON: Features = { ask: { available: true }, summary: { available: true }, quick: { available: true }, glance: { available: true } };
const NOKEYS: Features = { ask: { available: true }, summary: { available: true }, quick: { available: false, reason: 'needs keys' }, glance: { available: false, reason: 'add a Gemini key' } };
const count = (s: string, needle: string | RegExp) => (typeof needle === 'string' ? s.split(needle).length - 1 : (s.match(needle) ?? []).length);

describe('viewer layout', () => {
  test('session page leads with the glance, the ask box and files; the conversation is collapsed', () => {
    const html = renderSessionPage(buildSessionModel(repo, A, { features: ON })!);
    const at = (s: string) => html.indexOf(s);
    assert.ok(at('id="glance"') > 0 && at('id="glance"') < at('id="ask"') && at('id="ask"') < at('id="files"') && at('id="files"') < at('<details class="full"'));
    assert.equal(count(html, 'class="gt '), 4, 'one glance row per turn');
    assert.match(html, /<form class="qask" data-qask data-target="[0-9a-f-]{36}"/);
    assert.match(html, /Uses Jev \+ Gemini Flash, not your Claude plan/);
    assert.match(html, /<details class="fw" id="f-src-server-js">[\s\S]*?<code class="fw-path">src\/server\.js<\/code>/);
    assert.match(html, /class="fw-spots"/);
    assert.match(html, /<details class="full" id="full"><summary><span class="full-title">Full conversation<\/span>/);
    assert.equal(count(html, '<article class="turn'), 4, 'turns are still there, inside the details');
    assert.match(html, /placeholder="Deep ask at Turn 1: Claude Code reopens the repo as it was then \(your Claude plan, ~1 min\)"/);
  });

  test('without keys the page still has the rough glance and says what is missing', () => {
    const html = renderSessionPage(buildSessionModel(repo, A, { features: NOKEYS })!);
    assert.match(html, /rough outline from the prompts · add a Gemini key/);
    assert.doesNotMatch(html, /data-src="\/api\/glance/);
    assert.match(html, /class="qask qask-off"[\s\S]*?needs keys/);
  });

  test('review page: the deep review waits for a click instead of running on load', () => {
    const html = renderReviewPage(buildReviewModel(repo, 'main', 'feature/rates', { features: ON }));
    assert.match(html, /data-summary-run>Run deep review<\/button>/);
    assert.doesNotMatch(html, /data-autoload/);
    assert.match(html, /Uses your Claude plan and takes about a minute/);
    assert.equal(count(html, 'class="gt '), 5);
    assert.match(html, /data-target="main\.\.feature\/rates"/);
    assert.match(html, /<details class="full" id="full">[\s\S]*role="tablist"/);
  });

  test('quick asks show at the top of the page, deep asks stay on their turn', () => {
    const quick = { sessionId: A, turn: 2, question: 'Did it add Redis?', answer: 'No.', askedAt: '2026-09-27T01:00:00Z', quick: { target: 'x', used: [{ sessionId: A, turn: 2 }], scores: [], verdict: { label: 'no', confidence: 0.98 }, usage: { jevRequests: 1, jevInputTokens: 1, geminiInputTokens: 1, geminiOutputTokens: 1 }, models: { jev: 'jev-1.13.0', gemini: 'gemini-3.8-flash' } } };
    const deep = { sessionId: A, turn: 2, question: 'Deep one?', answer: 'Deep answer.', askedAt: '2026-09-27T00:00:00Z' };
    const html = renderSessionPage(buildSessionModel(repo, A, { features: ON, asks: new Map([[A, [quick as AskResult, deep]]]) })!);
    const qsec = html.slice(html.indexOf('id="ask"'), html.indexOf('id="files"'));
    assert.match(qsec, /Did it add Redis\?/);
    assert.match(qsec, /class="qa-verdict v-no"><strong>No<\/strong><span class="muted"> · Jev agrees, 98% sure/);
    assert.doesNotMatch(qsec, /Deep one\?/);
    assert.match(html.slice(html.indexOf('<details class="full"')), /Deep one\?/);
  });
});

describe('viewer server', () => {
  let srv: RunningServer;
  const glanceCalls: string[] = [];
  const asked: { question: string; target?: string }[] = [];
  const quick: QuickModule = {
    repoGeminiClient: () => (async () => ({ text: '', model: 'x', usage: { inputTokens: 0, outputTokens: 0 } })) as Gemini,
    decisionClient: () => ({}),
    async buildGlance(_cwd, input) {
      glanceCalls.push(input.items.map((i) => i.sessionId).join(','));
      return { ...basicGlance(input), headline: 'Gemini <b>headline</b>', source: 'gemini', model: 'gemini-fake' } satisfies Glance;
    },
    async quickAsk({ question, target }) {
      asked.push({ question, target });
      return { sessionId: A, turn: 2, question, answer: `Quick answer to <i>${question}</i>`, askedAt: '2026-09-27T01:00:00Z' };
    },
  };
  before(async () => {
    srv = await startServer({ cwd: repo, port: 0, modules: { ask: null, summarize: null, quick } });
  });
  after(() => srv.close());

  test('pages point at /api/glance, which returns the Gemini glance and files as escaped HTML', async () => {
    const page = await (await fetch(`${srv.url}/session/${A}`)).text();
    assert.match(page, new RegExp(`data-src="/api/glance\\?session=${A}"`));
    const res = await fetch(`${srv.url}/api/glance?session=${A}`);
    const data = (await res.json()) as { ok: boolean; glance: string; files: string; headline: string };
    assert.equal(res.status, 200);
    assert.equal(data.headline, 'Gemini <b>headline</b>', 'session pages put the headline in the h1 (set as text by the client)');
    assert.doesNotMatch(data.glance, /glance-headline/);
    assert.match(data.glance, /written by gemini-fake/);
    assert.match(data.files, /id="files"/);
    const review = (await (await fetch(`${srv.url}/api/glance?base=main&head=feature%2Frates`)).json()) as { ok: boolean; glance: string };
    assert.equal(review.ok, true);
    assert.match(review.glance, /<p class="glance-headline">Gemini &lt;b&gt;headline&lt;\/b&gt;<\/p>/, 'model text is escaped');
    assert.deepEqual(glanceCalls, [A, `${A},${B}`]);
  });

  test('POST /api/quick-ask validates the target and returns the rendered answer', async () => {
    const post = (body: unknown) => fetch(`${srv.url}/api/quick-ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await post({ target: 'main..feature/rates', question: 'Did it get every URL?' });
    const data = (await ok.json()) as { ok: boolean; html: string };
    assert.equal(ok.status, 200);
    assert.match(data.html, /Quick answer to &lt;i&gt;Did it get every URL\?&lt;\/i&gt;|Quick answer to <em>|Quick answer to/);
    assert.equal((await post({ target: '--upload-pack=x..y', question: 'q' })).status, 400);
    assert.equal((await post({ target: A.slice(0, 8), question: '' })).status, 400);
    const bySession = await post({ target: A.slice(0, 8), question: 'Hi?' });
    assert.equal(bySession.status, 200);
    assert.deepEqual(asked, [{ question: 'Did it get every URL?', target: 'main..feature/rates' }, { question: 'Hi?', target: A }]);
  });
});

test('verdict chip follows the written answer and shows whether Jev agreed', async () => {
  const { renderQuickAskResult } = await import('../src/viewer/render.ts');
  const base = { sessionId: A, turn: 3, question: 'Anything still calling TypeSafe?', answer: 'No, only a default.', askedAt: '2026-09-27T01:00:00Z' };
  const info = (lead: 'yes' | 'no' | undefined, label: 'yes' | 'no' | 'unclear', confidence: number) => ({ target: 'x', used: [], scores: [], verdict: { label, confidence }, ...(lead ? { lead } : {}), usage: { jevRequests: 1, jevInputTokens: 1, geminiInputTokens: 1, geminiOutputTokens: 1 }, models: { jev: 'j', gemini: 'g' } });
  const chip = (q: object) => /class="qa-verdict[^"]*">([\s\S]*?)<\/div>/.exec(renderQuickAskResult({ ...base, quick: q } as AskResult).__html)![1]!.replace(/<[^>]+>/g, '');
  assert.equal(chip(info('no', 'yes', 0.64)), 'No · Jev leaned yes (64%)');
  assert.equal(chip(info('no', 'no', 0.9)), 'No · Jev agrees, 90% sure');
  assert.equal(chip(info('yes', 'unclear', 0.5)), 'Yes · Jev unsure');
  assert.equal(chip(info(undefined, 'yes', 0.64)), 'No · Jev leaned yes (64%)', 'older asks: lead read from the answer');
  const noLead = /class="qa-verdict[^"]*">([\s\S]*?)<\/div>/.exec(renderQuickAskResult({ ...base, answer: 'It depends.', quick: info(undefined, 'no', 0.8) } as AskResult).__html)![1]!.replace(/<[^>]+>/g, '');
  assert.equal(noLead, 'No · Jev, 80% sure');
});

test('glance shows key turns, folds minor ones, and lists changes beyond the ask with their reasons', () => {
  const m = buildSessionModel(repo, A, { features: ON })!;
  const g = m.glance!.glance;
  m.glance!.glance = {
    ...g,
    turns: g.turns.map((t) => ({ ...t, minor: t.turn === 3 })),
    beyond: [
      { change: 'serves stale rates when upstream fails', paths: ['src/server.js'], reason: 'worse data beats no data', mentioned: true },
      { change: 'removed the <b>404</b> handler', paths: [], reason: '', mentioned: false },
    ],
  };
  const html = renderSessionPage(m);
  const glance = html.slice(html.indexOf('id="glance"'), html.indexOf('id="ask"'));
  assert.equal(count(glance, 'class="gt c'), 3, 'three key turns');
  assert.match(glance, /class="gt gt-fold"><span class="gt-fold-k">Also<\/span><a class="tref" href="#[^"]+">Turn 3<\/a>/);
  assert.match(glance, /Beyond what was asked <span class="count">2<\/span>/);
  assert.match(glance, /serves stale rates when upstream fails <span class="bw-where"><a href="#f-src-server-js"><code>src\/server\.js<\/code><\/a><\/span>/);
  assert.match(glance, /Claude's reason:<\/span> worse data beats no data/);
  assert.match(glance, /removed the &lt;b&gt;404&lt;\/b&gt; handler/);
  assert.match(glance, /class="bw-reason none">Never mentioned in the conversation\. Only the diff shows it\./);
});

describe('leftovers (did it change it everywhere?)', () => {
  const diff = [
    'diff --git a/app.mjs b/app.mjs',
    '--- a/app.mjs',
    '+++ b/app.mjs',
    "-  if (!env.TYPESAFE_API_KEY) return fail();",
    "-  const url = 'https://api.typesafe.ai/v1/systemone';",
    "+  const url = env.JEV_ENDPOINT || 'https://dopp.sh/v1/systemone';",
    'diff --git a/client.mjs b/client.mjs',
    '--- a/client.mjs',
    '+++ b/client.mjs',
    "-  typesafe: ({ apiKey }) => ({ endpoint: 'https://api.typesafe.ai/v1/systemone' }),",
    "+  typesafe: ({ apiKey, endpoint = 'https://api.typesafe.ai/v1/systemone' }) => ({ endpoint }),",
    '-  const KEEP_ME = 1;',
    '+  const KEEP_ME = 2;',
  ].join('\n');

  test('removedNames: env vars and URL hosts used less after the change, with the files they left', () => {
    assert.deepEqual(removedNames(diff), [
      { name: 'api.typesafe.ai', removedFrom: ['app.mjs', 'client.mjs'] },
      { name: 'TYPESAFE_API_KEY', removedFrom: ['app.mjs'] },
    ]);
  });

  test('addedLines: new-side line numbers of added lines', () => {
    const d = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -3,3 +3,4 @@', ' keep', '-old', '+new1', '+new2', ' keep'].join('\n');
    assert.deepEqual([...(addedLines(d).get('a.js') ?? [])], [4, 5]);
  });

  test('findLeftovers: git grep at the given rev; nothing without a rev', () => {
    const head = git(['rev-parse', 'HEAD'], { cwd: repo });
    const d = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n-const NOT_IN_REPO_ANYWHERE = 1;\n';
    assert.deepEqual(findLeftovers(repo, d, head), [{ name: 'NOT_IN_REPO_ANYWHERE', removedFrom: ['x'], stillIn: [], more: 0 }]);
    assert.deepEqual(findLeftovers(repo, d, undefined), []);
  });
});
