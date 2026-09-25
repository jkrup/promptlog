import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assembleReview } from '../src/core/review.ts';
import type { AskResult, Session } from '../src/core/types.ts';
import { mockSummary } from '../src/viewer/mock.ts';
import { buildIndexModel, buildReviewModel, buildSessionModel, computeExtras, turnDiff } from '../src/viewer/model.ts';
import {
  anchorId,
  CLIENT_SCRIPT,
  renderIndexPage,
  renderReviewPage,
  renderSessionPage,
  renderSummary,
  reviewCtx,
  segments,
  summaryAnnotations,
  toolLabel,
} from '../src/viewer/render.ts';
import { turnKey, type Features } from '../src/viewer/types.ts';
import { cloneDemo, demoIds, ROOT } from './helpers.ts';

const dir = cloneDemo();
const { sessionA: A, sessionB: B } = demoIds();
const OFF: Features = { ask: { available: false, reason: 'not here' }, summary: { available: false, reason: 'The summarizer is off.' } };
const ON: Features = { ask: { available: true }, summary: { available: true } };

const review = () => assembleReview(dir, 'main', 'feature/rates');
const count = (s: string, needle: string | RegExp) => (typeof needle === 'string' ? s.split(needle).length - 1 : (s.match(needle) ?? []).length);

test('review page: header, sessions, commits, all five turns in time order', () => {
  const r = review();
  assert.equal(r.slices.length, 2);
  const html = renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: r }));
  assert.match(html, /<!doctype html>/);
  assert.match(html, /2 sessions → this PR/);
  assert.match(html, /Add \/rates endpoint with caching/);
  assert.match(html, /Rates handler test file/);
  assert.equal(count(html, '<article class="turn'), 5);
  const order = [anchorId(A, 1), anchorId(A, 2), anchorId(A, 3), anchorId(A, 4), anchorId(B, 1)].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((p) => p > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'turns render in time order');
  // Commits with subjects, each linked to the turn that made it.
  for (const c of r.commits) assert.ok(html.includes(c.sha.slice(0, 7)) && html.includes(c.subject.replace(/&/g, '&amp;')));
  assert.match(html, new RegExp(`href="#${anchorId(A, 3)}">A·3</a>`));
  assert.match(html, new RegExp(`href="#${anchorId(B, 1)}">B·1</a>`));
});

test('review page: turn anatomy (prompt, tool strip, chips, lazy panels, ask box)', () => {
  const html = renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: review() }));
  assert.match(html, /we run ~20 instances behind a load balancer/, 'A·2 pushback prompt is shown in full');
  assert.match(html, /<b>Read<\/b> <span class="targ">server\.js<\/span>/);
  assert.match(html, /<b>Bash<\/b> <span class="targ">git commit<\/span>/);
  // Paths inside tool details are shown repo-relative (the fixture recorded absolute paths).
  assert.match(html, /<span class="tname">Edit<\/span> <span class="targ">src\/server\.js<\/span>/);
  assert.match(html, /<span class="fname">src\/server\.js<\/span><span class="num"><span class="plus">\+35<\/span>/);
  assert.match(html, /<span class="fname">test\/rates\.test\.js<\/span>/);
  assert.match(html, /<code>aca106e<\/code> <span class="csub">Add \/rates endpoint/);
  assert.equal(count(html, 'Raw log</button>'), 5);
  assert.equal(count(html, /data-src="\/api\/turn-diff\?session=[^"]+format=html"/g), 3, 'diff button only on turns that changed files');
  assert.equal(count(html, '<form class="ask" data-ask'), 5);
  assert.match(html, /data-src="\/api\/summary\?base=main&amp;head=feature%2Frates"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /<tr class="add">/, 'code diff tab is rendered');
  assert.match(html, /test\/rates\.test\.js/);
});

test('review page: unavailable features degrade to explicit states', () => {
  const html = renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: OFF, review: review() }));
  assert.match(html, /Summary not available yet/);
  assert.match(html, /The summarizer is off\./);
  assert.match(html, /mockSummary=1/);
  assert.doesNotMatch(html, /data-src="\/api\/summary/);
  assert.equal(count(html, 'class="ask ask-off"'), 5);
  assert.equal(count(html, '<form class="ask"'), 0);
});

test('mock summary: every item links to a turn; pushback lands on A·2', () => {
  const r = review();
  const m = buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: r });
  m.summary = { data: mockSummary(r), mock: true };
  const html = renderReviewPage(m);
  assert.match(html, /Mock data\./);
  assert.doesNotMatch(html, /data-src="\/api\/summary/);
  const pushSection = html.slice(html.indexOf('Pushbacks'), html.indexOf('Risk flags'));
  assert.match(pushSection, new RegExp(`href="#${anchorId(A, 2)}">A·2</a>`));
  for (const st of ['done', 'missing', 'partial']) assert.match(html, new RegExp(`class="pvd-st pvd-${st}"`));
  assert.match(html, /class="sev sev-high"/);
  // Summary annotations appear in the A·2 turn header.
  const a2 = html.slice(html.indexOf(`id="${anchorId(A, 2)}"`));
  assert.match(a2.slice(0, 1500), /class="badge b-push"[^>]*>Pushback</);
  assert.match(a2.slice(0, 1500), /class="gist"/);
});

test('summary annotations aggregate repeated kinds per turn', () => {
  const r = review();
  const ctx = reviewCtx({ review: r, features: ON });
  const s = mockSummary(r);
  s.openLoops.push({ sessionId: A, turn: 2, item: 'another' });
  const ann = summaryAnnotations(ctx, s).get(anchorId(A, 2));
  assert.ok(ann);
  assert.match(ann.badges.__html, /2 Open loops/);
  assert.equal(count(renderSummary(ctx, s).__html, 'class="sum-card'), 4);
});

test('human edits between turns: before(N) vs after(N-1) marker', () => {
  const r = review();
  const sA = structuredClone(r.sessions[A]!) as Session;
  // Pretend the human rolled src/server.js back by hand after turn 2: before(3) = after(1).
  sA.turns[2]!.meta!.stateBefore = sA.turns[0]!.meta!.stateAfter;
  const extras = computeExtras(dir, [{ session: sA, from: 1, to: 4 }]);
  const edits = extras[turnKey(A, 3)]?.humanEdits;
  assert.ok(edits?.length, 'marker computed with diffTrees');
  assert.equal(edits[0]!.path, 'src/server.js');
  assert.equal(extras[turnKey(A, 2)]?.humanEdits, undefined, 'unchanged boundary has no marker');
  const m = buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: { ...r, sessions: { ...r.sessions, [A]: sA } } });
  m.extras = { ...m.extras, ...extras };
  const html = renderReviewPage(m);
  assert.match(html, /Dana Dev edited 1 file<\/strong> by hand before A·3/);
  assert.match(html, /span=human/);
  // Unmodified fixture: no human edits anywhere.
  assert.doesNotMatch(renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: r })), /class="human-edit"/);
});

test('turn diffs come from the stored snapshots', () => {
  const d = turnDiff(dir, A, 2);
  assert.ok(d);
  assert.match(d.text, /^diff --git a\/src\/server\.js b\/src\/server\.js/);
  assert.match(d.text, /RATES_CACHE_TTL_MS/);
  assert.equal(turnDiff(dir, A, 4)?.text, '', 'a talk-only turn has an empty diff');
  assert.equal(turnDiff(dir, A, 99), null);
});

test('past asks render on their turn', () => {
  const ask: AskResult = { sessionId: A, turn: 4, question: 'Is the cache bounded?', answer: 'No: `Map` grows with every **base**.', askedAt: '2026-09-25T19:00:00Z', askedBy: 'rev@example.com' };
  const html = renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: review(), asks: new Map([[A, [ask]]]) }));
  const a4 = html.slice(html.indexOf(`id="${anchorId(A, 4)}"`), html.indexOf(`id="${anchorId(B, 1)}"`));
  assert.match(a4, /Is the cache bounded\?/);
  assert.match(a4, /<code>Map<\/code> grows with every <strong>base<\/strong>/);
});

test('session and index pages', () => {
  const s = buildSessionModel(dir, A, { features: OFF });
  assert.ok(s);
  const html = renderSessionPage(s);
  assert.equal(count(html, '<article class="turn'), 4);
  assert.match(html, /Turn 2/);
  assert.match(html, /Commits made in this session/);

  const idx = renderIndexPage(buildIndexModel(dir));
  assert.match(idx, /href="\/review\?base=main&amp;head=feature%2Frates"/);
  assert.match(idx, /href="\/review\?base=main&amp;head=feature%2Fhealth"/);
  assert.equal(count(idx, 'href="/session/'), 3 + 3, 'each session in its branch card and in the table');
});

test('segments: consecutive tool calls form one strip; last text is the answer', () => {
  const segs = segments([
    { kind: 'text', text: 'plan' },
    { kind: 'tool', id: '1', name: 'Read', input: { file_path: '/x/a.ts' } },
    { kind: 'tool', id: '2', name: 'Edit', input: { file_path: '/x/a.ts' } },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'text', text: 'done' },
  ]);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['text', 'tools', 'thinking', 'text'],
  );
  assert.equal(segs[0]!.kind === 'text' && segs[0]!.final, false);
  assert.equal(segs[3]!.kind === 'text' && segs[3]!.final, true);
  assert.deepEqual(toolLabel({ kind: 'tool', id: '3', name: 'Bash', input: { command: 'git add x && git commit -m "y"' } }), { name: 'Bash', arg: 'git commit' });
});

test('thinking is hidden behind a page toggle', () => {
  const r = review();
  const sA = structuredClone(r.sessions[A]!) as Session;
  sA.turns[0]!.items.unshift({ kind: 'thinking', text: 'Consider a Map cache' });
  const html = renderReviewPage(buildReviewModel(dir, 'main', 'feature/rates', { features: ON, review: { ...r, sessions: { ...r.sessions, [A]: sA } } }));
  assert.match(html, /id="show-thinking"/);
  assert.match(html, /<details class="thinking">/);
  assert.match(html, /body:has\(#show-thinking:checked\) \.thinking/);
});

test('render layer is pure: no Node APIs, only pure imports', () => {
  for (const f of ['render.ts', 'html.ts', 'markdown.ts', 'diff.ts', 'styles.ts', 'client.ts', 'mock.ts', 'types.ts']) {
    const src = readFileSync(join(ROOT, 'src/viewer', f), 'utf8');
    assert.doesNotMatch(src, /from 'node:|require\(|process\./, f);
    for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)) assert.ok(m[1]!.startsWith('./') || m[1] === '../core/types.ts', `${f} imports ${m[1]}`);
  }
  assert.doesNotThrow(() => new Function(CLIENT_SCRIPT), 'client island is valid JS after type stripping');
});
