// The lease table's rules, shared by the local file and the Cloudflare Durable Object; Clef's gray zone; and the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksFor, outline } from '../src/capture/blocks.ts';
import { claimJudged, clefRequest, readVerdict, type Judge, type TableStore } from '../src/capture/lease-judge.ts';
import { applyOp, claimIn, describeDecision, MAX_DECISIONS, parseOp, type BlockClaim, type ClaimResult, type Decision, type Holder, type Lease, type LeaseOp, type Table } from '../src/capture/lease-table.ts';
import { renderLeasesPage } from '../src/viewer/leases-page.ts';

const A = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', branch: 'feature/rates', ask: 'add a cache to getRates' };
const B = { sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', branch: 'feature/health', ask: 'format rates with two decimals' };
const MIN = 60_000;
const T0 = Date.parse('2026-10-13T20:00:00Z');

const table = (): Table => ({ leases: [], decisions: [] });
const run = (t: Table, op: LeaseOp, now = T0) => applyOp(t, op, now, 15 * MIN);

test('claim, refuse, renew, release: the same rules as the local file', () => {
  const t = table();
  assert.deepEqual(run(t, { op: 'claim', holder: A, paths: ['a.js', 'a.js'] }).reply, { refused: [], claimed: ['a.js'] });
  const r = run(t, { op: 'claim', holder: B, paths: ['a.js', 'b.js'] }, T0 + MIN).reply as ClaimResult;
  assert.deepEqual(r.claimed, ['b.js']);
  assert.equal(r.refused[0]!.sessionId, A.sessionId);
  assert.equal(r.refused[0]!.ask, 'add a cache to getRates');
  // Force (end of a turn: the change already happened) takes it anyway.
  assert.deepEqual((run(t, { op: 'claim', holder: B, paths: ['a.js'], force: true }).reply as ClaimResult).claimed, ['a.js']);
  assert.deepEqual(run(t, { op: 'release', sessionId: B.sessionId, paths: ['a.js'] }).reply, { released: 1 });
  // Freshest first.
  assert.deepEqual((run(t, { op: 'list' }).reply as { leases: Lease[] }).leases.map((l) => l.path), ['b.js', 'a.js']);
  assert.deepEqual(run(t, { op: 'release', sessionId: null }).reply, { released: 2 });
});

test('leases expire after the quiet period unless renewed', () => {
  const t = table();
  run(t, { op: 'claim', holder: A, paths: ['a.js'] });
  run(t, { op: 'claim', holder: B, paths: ['b.js'] });
  assert.deepEqual(run(t, { op: 'renew', sessionId: A.sessionId }, T0 + 10 * MIN), { reply: { renewed: 1 }, changed: true });
  const later = run(t, { op: 'list' }, T0 + 20 * MIN);
  assert.equal(later.changed, true, 'the expired lease is dropped and saved');
  assert.deepEqual((later.reply as { leases: Lease[] }).leases.map((l) => l.sessionId), [A.sessionId]);
  assert.deepEqual(run(t, { op: 'claim', holder: B, paths: ['a.js'] }, T0 + 26 * MIN).reply, { refused: [], claimed: ['a.js'] });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const SERVER = `import express from 'express';

const app = express();

export function getRates(cur) {
  return RATES[cur];
}
export function formatRates(rates) {
  return rates.map(String).join(', ');
}

export function health() {
  return { ok: true };
}

export function parseCurrency(s) {
  return s.trim().toUpperCase();
}

app.listen(3000);
`;

/** The claim an Edit of `old` in `text` makes (what leases.ts editClaims builds from the file). */
function edit(old: string, text = SERVER, path = 'src/server.js'): { paths: string[]; blocks: BlockClaim[]; texts: Record<string, string> } {
  const at = text.indexOf(old);
  assert.ok(at >= 0, old);
  const line = text.slice(0, at).split('\n').length;
  const blocks = blocksFor(path, text, line, line + old.split('\n').length - 1, outline(path, text)).map((block) => ({ path, block, change: { old, new: `${old} // changed` } }));
  return { paths: [], blocks, texts: { [path]: text } };
}
const claimOf = (t: Table, h: Holder, req: ReturnType<typeof edit>, now = T0, opts = {}) => claimIn(t, h, req, now, opts);

test('blocks: different functions of one file both proceed; the same function is refused, with its name', () => {
  const t = table();
  assert.deepEqual(claimOf(t, A, edit('return RATES[cur];')), { refused: [], claimed: ['src/server.js'] });
  assert.deepEqual(claimOf(t, B, edit('return s.trim()')), { refused: [], claimed: ['src/server.js'] }, 'parseCurrency() is far from getRates()');
  assert.deepEqual(t.leases.map((l) => `${l.sessionId.slice(0, 1)} ${l.block?.name}`), ['a getRates()', 'b parseCurrency()']);
  const r = claimOf(t, B, edit('export function getRates(cur) {'), T0 + MIN);
  assert.deepEqual(r.claimed, []);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0]!.sessionId, A.sessionId);
  assert.equal(r.refused[0]!.block!.name, 'getRates()');
  assert.equal(r.refused[0]!.wanted!.name, 'getRates()');
  // The holder itself keeps editing its block (and its lease follows the block as it grows).
  assert.deepEqual(claimOf(t, A, edit('return r;', SERVER.replace('return RATES[cur];', 'const r = RATES[cur];\n  return r;'))).refused, []);
  assert.deepEqual(t.leases.filter((l) => l.sessionId === A.sessionId).map((l) => [l.block!.start, l.block!.end]), [[5, 8]]);
});

test('blocks and whole files: a whole file held by another refuses every block, and a block refuses a whole-file write', () => {
  const t = table();
  claimIn(t, A, { paths: ['src/server.js'] }, T0);
  assert.equal(claimOf(t, B, edit('return s.trim()')).refused[0]!.block, undefined, 'refused by the whole-file lease');
  const t2 = table();
  claimOf(t2, A, edit('return RATES[cur];'));
  const r = claimIn(t2, B, { paths: ['src/server.js'] }, T0);
  assert.equal(r.refused[0]!.block!.name, 'getRates()');
  // A session's own whole-file claim replaces its blocks; at the end of a turn (force + keepBlocks) blocks are kept.
  claimOf(t2, B, edit('return s.trim()'));
  claimIn(t2, B, { paths: ['src/server.js'] }, T0, { force: true, keepBlocks: true });
  assert.deepEqual(t2.leases.map((l) => l.block?.name ?? 'whole'), ['getRates()', 'parseCurrency()']);
  claimIn(t2, A, { paths: ['src/server.js'] }, T0, { force: true });
  assert.deepEqual(t2.leases.map((l) => `${l.sessionId.slice(0, 1)} ${l.block?.name ?? 'whole'}`), ['b parseCurrency()', 'a whole']);
});

test('drift: another agent\'s block is found again by its anchor in the claimant\'s copy of the file', () => {
  const t = table();
  claimOf(t, A, edit('return RATES[cur];'));
  // B's copy has 20 new lines on top: getRates() is at lines 25-27 there, where A's lease says 5-7.
  const shifted = `${'// license\n'.repeat(20)}${SERVER}`;
  assert.deepEqual(claimOf(t, B, edit('return s.trim()', shifted)).refused, [], 'parseCurrency() (now lines 36-38) is free');
  const r = claimOf(t, B, edit('return RATES[cur];', shifted));
  assert.equal(r.refused[0]!.block!.name, 'getRates()');
  assert.deepEqual([r.refused[0]!.block!.start, r.refused[0]!.block!.end], [25, 27], 'reported where it is in B\'s copy');
  // Without the text, lines 25-27 of B's copy look free of A's block (lines 5-7): the anchor is what makes it right.
  const blind = edit('return RATES[cur];', shifted);
  assert.deepEqual(claimIn({ leases: structuredClone(t.leases), decisions: [] }, B, { paths: [], blocks: blind.blocks }, T0).refused, []);
});

// ---------------------------------------------------------------------------
// The gray zone, Clef, and the verdict log
// ---------------------------------------------------------------------------

/** A fake Clef: the same answer every time (or never), counting its calls. */
function fakeClef(choice: string, p: number, opts: { hang?: boolean; seen?: unknown[] } = {}): Judge & { calls: number } {
  const j = (async (req, signal) => {
    j.calls++;
    opts.seen?.push(req);
    if (opts.hang) return new Promise((_, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))));
    const rest = (1 - p) / 2;
    return { model: '@cf/cloudflare/clef-flash', answers: { verdict: { type: 'choice', choice, probabilities: { independent: rest, conflicting: rest, unsure: rest, [choice]: p }, confidence: p } } };
  }) as Judge & { calls: number };
  j.calls = 0;
  return j;
}

const memStore = (t: Table, clock = () => T0): TableStore => ({ update: async (fn) => fn(t, clock()) });

test('gray zone: neighbouring functions wait for a verdict; nothing is claimed until then', () => {
  const t = table();
  claimOf(t, A, edit('return RATES[cur];'));
  const r = claimOf(t, B, edit('return rates.map'));
  assert.deepEqual(r.claimed, []);
  assert.deepEqual(r.refused, []);
  assert.equal(r.gray!.length, 1);
  assert.equal(r.gray![0]!.why, 'near');
  assert.equal(r.gray![0]!.held.block!.name, 'getRates()');
  assert.equal(t.leases.length, 1);
  // The question is narrow: both asks, both blocks' code, and the edit.
  const q = clefRequest(r.gray![0]!);
  const state = q.state as { agent_a: Record<string, string>; agent_b: Record<string, unknown> };
  assert.equal(state.agent_a.asked_to, 'add a cache to getRates');
  assert.match(state.agent_a.code!, /^export function getRates\(cur\) \{\n  return RATES\[cur\];\n\}$/);
  assert.equal(state.agent_b.about_to_edit, 'formatRates()');
  assert.match(String(state.agent_b.code), /formatRates/);
  assert.deepEqual(state.agent_b.edit, { replaces: 'return rates.map', with: 'return rates.map // changed' });
  assert.deepEqual(Object.keys(q.questions.verdict!.criteria), ['independent', 'conflicting', 'unsure']);
});

test('gray zone: Clef says independent (>= 70%) -> both proceed, with a heads-up and a logged verdict', async () => {
  const t = table();
  claimOf(t, A, edit('return RATES[cur];'));
  const clef = fakeClef('independent', 0.84);
  const r = await claimJudged(memStore(t), B, edit('return rates.map'), { judge: clef });
  assert.deepEqual(r.claimed, ['src/server.js']);
  assert.equal(r.headsUp![0]!.lease.block!.name, 'getRates()');
  assert.equal(r.headsUp![0]!.decision.choice, 'independent');
  assert.deepEqual(t.leases.map((l) => l.block!.name), ['getRates()', 'formatRates()']);
  const d = t.decisions[0]!;
  assert.equal(describeDecision(d), 'Clef: getRates() and formatRates() are independent (84%) → both agents kept working');
  assert.match(d.question, /change formatRates\(\) while another works on getRates\(\) next to it in src\/server\.js/);
  assert.equal(d.outcome, 'allowed');
  assert.equal(d.asker.ask, B.ask);
  assert.equal(d.holder.ask, A.ask);
  // The verdict is reused for the same two blocks, from either side: Clef isn't asked again.
  assert.equal((await claimJudged(memStore(t), A, edit('return RATES[cur];'), { judge: clef })).headsUp!.length, 1);
  assert.equal((await claimJudged(memStore(t), B, edit('return rates.map'), { judge: clef })).refused.length, 0);
  assert.equal(clef.calls, 1);
  assert.equal(t.decisions.length, 1);
});

test('gray zone: conflicting, unsure, or independent under 70% -> refused with the verdict', async () => {
  for (const [choice, p, words] of [
    ['conflicting', 0.8, 'Clef: getRates() and formatRates() conflict (80%) → the second agent waited'],
    ['unsure', 0.6, 'Clef: not sure getRates() and formatRates() are independent (unsure 60%, independent 20%) → the second agent waited, to be safe'],
    ['independent', 0.65, 'Clef: not sure getRates() and formatRates() are independent (independent 65%, under 70%) → the second agent waited, to be safe'],
  ] as const) {
    const t = table();
    claimOf(t, A, edit('return RATES[cur];'));
    const r = await claimJudged(memStore(t), B, edit('return rates.map'), { judge: fakeClef(choice, p) });
    assert.deepEqual(r.claimed, [], choice);
    assert.equal(r.refused[0]!.decision!.outcome, 'refused');
    assert.equal(describeDecision(r.refused[0]!.decision!), words);
    assert.equal(t.leases.length, 1, 'B holds nothing');
  }
});

test('gray zone: Clef too slow, failing, or not set up -> the safe default (refused), within the budget', async () => {
  const t = table();
  claimOf(t, A, edit('return RATES[cur];'));
  const t0 = Date.now();
  const slow = await claimJudged(memStore(t), B, edit('return rates.map'), { judge: fakeClef('independent', 0.9, { hang: true }), budgetMs: 200 });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(describeDecision(slow.refused[0]!.decision!), 'No verdict on getRates() and formatRates() (Clef took longer than 0.2 s) → the second agent waited, to be safe');
  const failing: Judge = async () => {
    throw new Error('HTTP 500');
  };
  assert.equal((await claimJudged(memStore(t), B, edit('return rates.map'), { judge: failing })).refused[0]!.decision!.note, 'Clef failed: HTTP 500');
  const none = await claimJudged(memStore(t), B, edit('return rates.map'), { judge: null, noJudge: 'no decision model is set up' });
  assert.equal(none.refused[0]!.decision!.note, 'no decision model is set up');
  assert.equal(t.decisions.length, 1, 'repeats of the same outcome for the same two blocks update one entry');
  assert.equal(t.decisions[0]!.note, 'no decision model is set up');
  assert.equal(readVerdict({ answers: {} }), null);
});

test('gray zone: the same function, left quiet by its holder for 5 minutes, goes to Clef instead of a flat refusal', async () => {
  const t = table();
  claimOf(t, A, edit('return RATES[cur];'));
  assert.equal(claimOf(t, B, edit('return RATES[cur];'), T0 + 4 * MIN).refused.length, 1, 'still fresh: refused');
  const seen: unknown[] = [];
  const r = await claimJudged(memStore(t, () => T0 + 6 * MIN), B, edit('return RATES[cur];'), { judge: fakeClef('independent', 0.75, { seen }) });
  assert.deepEqual(r.claimed, ['src/server.js']);
  assert.equal(r.headsUp![0]!.decision.why, 'stale');
  assert.match((seen[0] as { state: { situation: string } }).state.situation, /edited getRates\(\) in src\/server\.js 6 min ago and has not touched it since/);
  assert.equal(describeDecision(t.decisions[0]!), 'Clef: two changes to getRates() are independent (75%) → both agents kept working');
  // Both hold it now; the first agent coming back is let through by the same verdict, not locked out.
  assert.deepEqual(claimOf(t, A, edit('return RATES[cur];'), T0 + 7 * MIN).refused, []);
});

test('the verdict log keeps the last 50; the table round-trips it through list', async () => {
  const t = table();
  for (let i = 0; i < MAX_DECISIONS + 5; i++) {
    const h = { sessionId: `s${i}`, ask: `task ${i}` };
    claimOf(t, h, edit('return RATES[cur];'));
    await claimJudged(memStore(t), { sessionId: `x${i}` }, edit('return rates.map'), { judge: fakeClef('conflicting', 0.9) });
    t.leases.length = 0;
  }
  assert.equal(t.decisions.length, MAX_DECISIONS);
  assert.equal(t.decisions[0]!.holder.ask, 'task 5');
  const listed = (run(t, { op: 'list' }).reply as { decisions: Decision[] }).decisions;
  assert.equal(listed[0]!.holder.ask, `task ${MAX_DECISIONS + 4}`, 'newest first');
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
  // Blocks and file text: bounded and typed.
  const block = { name: 'getRates()', start: 5, end: 7, anchor: 'export function getRates(cur) {', anchorLine: 5 };
  assert.deepEqual(parseOp('claim', { holder: A, blocks: [{ path: 'a.js', block: { ...block, extra: 1 }, change: { old: 'x', new: 'y'.repeat(5000) } }], texts: { 'a.js': 'code' } }), {
    op: 'claim',
    holder: A,
    paths: [],
    blocks: [{ path: 'a.js', block, change: { old: 'x', new: 'y'.repeat(2000) } }],
    texts: { 'a.js': 'code' },
  });
  assert.equal(typeof parseOp('claim', { holder: A, blocks: [{ path: 'a.js', block: { ...block, end: 2 } }] }), 'string', 'end before start');
  assert.equal(typeof parseOp('claim', { holder: A, blocks: [{ path: 'a.js', block: { ...block, start: 1.5 } }] }), 'string');
  assert.equal(typeof parseOp('claim', { holder: A, blocks: [], texts: { 'a.js': 'x'.repeat(200_001) } }), 'string');
});

test('who is working on what: one card per session with its files and blocks, and Clef\'s decisions in plain words', async () => {
  const t = table();
  claimOf(t, { ...A, ask: 'fix <script>alert(1)</script>' }, edit('return RATES[cur];'));
  claimIn(t, A, { paths: ['src/rates.js'] }, T0);
  await claimJudged(memStore(t, () => T0 + 3 * MIN), B, edit('return rates.map'), { judge: fakeClef('independent', 0.84) });
  const { leases, decisions } = run(t, { op: 'list' }, T0 + 5 * MIN).reply as { leases: Lease[]; decisions: Decision[] };
  const page = renderLeasesPage({ repo: 'demo', leases, decisions, now: T0 + 5 * MIN, ttlMin: 15 });
  assert.match(page, /2 agent sessions working in 2 files/);
  assert.match(page, new RegExp(`href="/session/${A.sessionId}"`));
  assert.match(page, /<code>src\/server\.js<\/code>: <code>getRates\(\)<\/code>/);
  assert.match(page, /<code>src\/rates\.js<\/code> <span class="small">\(whole file\)<\/span>/);
  assert.match(page, /on <code>feature\/health<\/code>/);
  assert.match(page, /<h2>Decisions<\/h2>/);
  assert.match(page, /Clef: getRates\(\) and formatRates\(\) are independent \(84%\) → both agents kept working/);
  assert.match(page, /2 min ago · session <code>aaaaaaaa<\/code>/);
  assert.ok(!page.includes('<script>alert'), 'the ask is escaped');
  assert.ok(!page.includes('Add agents on another machine'), 'no connect command without the key');
  const withJoin = renderLeasesPage({ repo: 'demo', leases: [], now: T0, ttlMin: 15, join: { command: 'promptlog connect --leases https://x/__leases/demo --leases-key k' } });
  assert.match(withJoin, /No agent is holding a file right now/);
  assert.ok(!withJoin.includes('<h2>Decisions</h2>'));
  assert.match(withJoin, /promptlog connect --leases https:\/\/x\/__leases\/demo --leases-key k/);
});
