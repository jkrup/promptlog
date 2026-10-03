import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import type { AskResult, ReviewSummary } from '../src/core/types.ts';
import type { AskModule, SummarizeModule } from '../src/viewer/integrations.ts';
import { mockSummary } from '../src/viewer/mock.ts';
import { startServer, type RunningServer } from '../src/viewer/server.ts';
import { cloneDemo, demoIds } from './helpers.ts';

const dir = cloneDemo();
const { sessionA: A } = demoIds();
let srv: RunningServer;
let off: RunningServer;
let summarizeCalls = 0;
const asked: { question: string; turn: number }[] = [];

const summarize: SummarizeModule = {
  async summarizeReview(_cwd, review) {
    summarizeCalls++;
    return { ...mockSummary(review), intent: 'Ship <b>rates</b>', model: 'fake' } satisfies ReviewSummary;
  },
};
const ask: AskModule = {
  async ask({ sessionId, turn, question }) {
    asked.push({ question, turn });
    return { sessionId, turn, question, answer: `Answer to <i>${question}</i>`, askedAt: '2026-09-25T19:00:00Z' } satisfies AskResult;
  },
  listAsks: (_cwd, sessionId) => (sessionId === A ? [{ sessionId, turn: 2, question: 'Earlier question?', answer: 'Earlier answer.', askedAt: '2026-09-25T18:59:00Z' }] : []),
};

before(async () => {
  srv = await startServer({ cwd: dir, port: 0, modules: { ask, summarize } });
  off = await startServer({ cwd: dir, port: 0, modules: { ask: null, summarize: null } });
});
after(async () => {
  await srv.close();
  await off.close();
});

const get = (path: string, s = srv) => fetch(s.url + path);
const postAsk = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(srv.url + '/api/ask', { method: 'POST', headers, body: JSON.stringify(body) });

test('binds to 127.0.0.1 on an ephemeral port', () => {
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(srv.port, 0);
});

test('GET / lists branches with review links and all sessions', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'sha256-/);
  const body = await res.text();
  assert.match(body, /\/review\?base=main&amp;head=feature%2Frates/);
  assert.match(body, /Add \/rates endpoint with caching/);
});

test('GET /review-old renders the old page with past asks', async () => {
  const res = await get('/review-old?base=main&head=feature%2Frates');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body.split('<article class="turn').length - 1, 5);
  assert.match(body, /Earlier question\?/);
  assert.match(body, /data-src="\/api\/summary/);
  assert.match(await (await get('/review-old?base=main&head=feature%2Frates&mockSummary=1')).text(), /Mock data\./);
});

test('GET /review: each turn with the code it wrote', async () => {
  const res = await get('/review?base=main&head=feature%2Frates');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /changed lines traced to the turn that wrote them/);
  // Turn 1 and 2 of session A wrote the /rates code; each card lists its files.
  assert.ok(body.split('<article class="pr-turn').length - 1 >= 2, 'work turns render as cards');
  assert.match(body, /src\/server\.js/);
  assert.match(body, /href="\/review-old\?base=main&amp;head=feature%2Frates"/);
});

test('bad input is rejected, not passed to git', async () => {
  assert.equal((await get('/review?base=--output%3D%2Ftmp%2Fx&head=feature%2Frates')).status, 400);
  assert.equal((await get('/review?base=main&head=no-such-branch')).status, 404);
  assert.equal((await get('/session/nope')).status, 404);
  assert.equal((await get('/session/..%2F..')).status, 400);
  assert.equal((await get('/api/turn-diff?session=' + A + '&turn=0')).status, 400);
  assert.equal((await get('/nope')).status, 404);
});

test('GET /session/<id> accepts a unique prefix', async () => {
  const res = await get('/session/' + A.slice(0, 8));
  assert.equal(res.status, 200);
  assert.equal((await res.text()).split('<article class="turn').length - 1, 4);
});

test('turn diff and raw log APIs', async () => {
  const diff = await (await get(`/api/turn-diff?session=${A}&turn=2`)).text();
  assert.match(diff, /^diff --git a\/src\/server\.js/);
  assert.match(await (await get(`/api/turn-diff?session=${A}&turn=2&format=html`)).text(), /class="diff-table"/);
  assert.match(await (await get(`/api/turn-diff?session=${A}&turn=3&span=human&format=html`)).text(), /No edits between these turns/);
  const raw = await (await get(`/api/turn-raw?session=${A}&turn=1`)).text();
  assert.ok(raw.split('\n').filter(Boolean).every((l) => JSON.parse(l)));
  assert.match(await (await get(`/api/turn-raw?session=${A}&turn=1&format=html`)).text(), /class="raw-entry"/);
});

test('GET /api/summary wraps summarizeReview, caches, and returns annotations', async () => {
  const res = await get('/api/summary?base=main&head=feature%2Frates');
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; html: string; annotations: Record<string, { badges: string }> };
  assert.equal(data.ok, true);
  assert.match(data.html, /Ship <strong>rates<\/strong>|Ship &lt;b&gt;rates&lt;\/b&gt;/);
  assert.doesNotMatch(data.html, /<b>rates<\/b>/);
  assert.match(data.annotations[`t-${A}-2`]!.badges, /Pushback/);
  await get('/api/summary?base=main&head=feature%2Frates');
  assert.equal(summarizeCalls, 1, 'second request served from cache');
  await get('/api/summary?base=main&head=feature%2Frates&refresh=1');
  assert.equal(summarizeCalls, 2);
});

test('POST /api/ask wraps ask() and guards the endpoint', async () => {
  const res = await postAsk({ sessionId: A, turn: 2, question: 'Why a Map?' });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { ok: boolean; html: string };
  assert.equal(data.ok, true);
  assert.match(data.html, /Answer to <em>Why a Map\?<\/em>|Answer to &lt;i&gt;/);
  assert.doesNotMatch(data.html, /<i>/);
  assert.deepEqual(asked, [{ question: 'Why a Map?', turn: 2 }]);

  assert.equal((await postAsk({ sessionId: A, turn: 2, question: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await postAsk({ sessionId: A, turn: 2, question: 'x' }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await postAsk({ sessionId: A, turn: 99, question: 'x' })).status, 404);
  assert.equal((await postAsk({ sessionId: A, turn: 2, question: '' })).status, 400);
  assert.equal((await fetch(srv.url + '/api/ask')).status, 405);
  assert.equal(asked.length, 1);
});

test('missing modules give a clear "not available yet" state', async () => {
  const s = await get('/api/summary?base=main&head=feature%2Frates', off);
  assert.equal(s.status, 501);
  const sd = (await s.json()) as { unavailable: boolean; html: string };
  assert.equal(sd.unavailable, true);
  assert.match(sd.html, /Summary not available yet/);
  const a = await fetch(off.url + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: A, turn: 1, question: 'q' }) });
  assert.equal(a.status, 501);
  const page = await (await get('/review-old?base=main&head=feature%2Frates', off)).text();
  assert.match(page, /Summary not available yet/);
  assert.match(page, /not available yet/);
});

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path: '/', headers: { host: 'evil.example:80' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
