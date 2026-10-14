// The lease table's rules, shared by the local file and the Cloudflare Durable Object; and the page that shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, parseOp, type Lease, type LeaseOp } from '../src/capture/lease-table.ts';
import { renderLeasesPage } from '../src/viewer/leases-page.ts';

const A = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', branch: 'feature/rates', ask: 'add a cache to getRates' };
const B = { sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', branch: 'feature/health' };
const MIN = 60_000;
const T0 = Date.parse('2026-10-13T20:00:00Z');

const run = (t: Lease[], op: LeaseOp, now = T0) => applyOp(t, op, now, 15 * MIN);

test('claim, refuse, renew, release: the same rules as the local file', () => {
  const t: Lease[] = [];
  assert.deepEqual(run(t, { op: 'claim', holder: A, paths: ['a.js', 'a.js'] }).reply, { refused: [], claimed: ['a.js'] });
  const r = run(t, { op: 'claim', holder: B, paths: ['a.js', 'b.js'] }, T0 + MIN).reply as { refused: Lease[]; claimed: string[] };
  assert.deepEqual(r.claimed, ['b.js']);
  assert.equal(r.refused[0]!.sessionId, A.sessionId);
  assert.equal(r.refused[0]!.ask, 'add a cache to getRates');
  // Force (end of a turn: the change already happened) takes it anyway.
  assert.deepEqual((run(t, { op: 'claim', holder: B, paths: ['a.js'], force: true }).reply as { claimed: string[] }).claimed, ['a.js']);
  assert.deepEqual(run(t, { op: 'release', sessionId: B.sessionId, paths: ['a.js'] }).reply, { released: 1 });
  // Freshest first.
  assert.deepEqual((run(t, { op: 'list' }).reply as { leases: Lease[] }).leases.map((l) => l.path), ['b.js', 'a.js']);
  assert.deepEqual(run(t, { op: 'release', sessionId: null }).reply, { released: 2 });
});

test('leases expire after the quiet period unless renewed', () => {
  const t: Lease[] = [];
  run(t, { op: 'claim', holder: A, paths: ['a.js'] });
  run(t, { op: 'claim', holder: B, paths: ['b.js'] });
  assert.deepEqual(run(t, { op: 'renew', sessionId: A.sessionId }, T0 + 10 * MIN), { reply: { renewed: 1 }, changed: true });
  const later = run(t, { op: 'list' }, T0 + 20 * MIN);
  assert.equal(later.changed, true, 'the expired lease is dropped and saved');
  assert.deepEqual((later.reply as { leases: Lease[] }).leases.map((l) => l.sessionId), [A.sessionId]);
  assert.deepEqual(run(t, { op: 'claim', holder: B, paths: ['a.js'] }, T0 + 26 * MIN).reply, { refused: [], claimed: ['a.js'] });
});

test('requests from the network are checked before they reach the table', () => {
  assert.deepEqual(parseOp('claim', { holder: { sessionId: A.sessionId, ask: 'x'.repeat(1000), extra: 1 }, paths: ['a'] }), {
    op: 'claim',
    holder: { sessionId: A.sessionId, ask: 'x'.repeat(300) },
    paths: ['a'],
  });
  assert.equal(typeof parseOp('claim', { holder: { sessionId: '../etc' }, paths: ['a'] }), 'string');
  assert.equal(typeof parseOp('claim', { holder: A, paths: 'a' }), 'string');
  assert.equal(typeof parseOp('claim', { holder: A, paths: Array(501).fill('a') }), 'string');
  assert.equal(typeof parseOp('renew', {}), 'string');
  assert.deepEqual(parseOp('release', { sessionId: null, paths: ['a'] }), { op: 'release', sessionId: null, paths: ['a'] });
  assert.equal(typeof parseOp('release', {}), 'string', 'releasing everyone\'s leases needs an explicit null');
  assert.equal(typeof parseOp('drop', {}), 'string');
  assert.deepEqual(parseOp('list', null), { op: 'list' });
});

test('who is working on what: one card per session, linked to its page, text escaped', () => {
  const t: Lease[] = [];
  run(t, { op: 'claim', holder: { ...A, ask: 'fix <script>alert(1)</script>' }, paths: ['src/server.js', 'src/rates.js'] });
  run(t, { op: 'claim', holder: B, paths: ['src/health.js'] }, T0 + 3 * MIN);
  const leases = (run(t, { op: 'list' }, T0 + 5 * MIN).reply as { leases: Lease[] }).leases;
  const page = renderLeasesPage({ repo: 'demo', leases, now: T0 + 5 * MIN, ttlMin: 15 });
  assert.match(page, /2 agent sessions holding 3 files/);
  assert.match(page, new RegExp(`href="/session/${A.sessionId}"`));
  assert.match(page, /active 5 min ago[\s\S]*src\/server\.js[\s\S]*src\/rates\.js/);
  assert.match(page, /on <code>feature\/health<\/code>/);
  assert.ok(!page.includes('<script>alert'), 'the ask is escaped');
  assert.ok(!page.includes('Add agents on another machine'), 'no connect command without the key');
  const withJoin = renderLeasesPage({ repo: 'demo', leases: [], now: T0, ttlMin: 15, join: { command: 'promptlog connect --leases https://x/__leases/demo --leases-key k' } });
  assert.match(withJoin, /No agent is holding a file right now/);
  assert.match(withJoin, /promptlog connect --leases https:\/\/x\/__leases\/demo --leases-key k/);
});
