// Leases: two agent sessions on one repo, editing the same file (whole files, and blocks of one file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Judge } from '../src/capture/lease-judge.ts';
import { bashWriteTargets, claim, claimEdit, editClaims, headsUpMessage, listLeases, listTable, release, toolTargets, type Holder } from '../src/capture/leases.ts';
import { tempRepo } from './helpers.ts';
import { gitc, leaseServer, pl, Session } from './capture-helpers.ts';

const A = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', branch: 'feature/rates', ask: 'add a cache to getRates' };
const B = { sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', branch: 'feature/health' };

// No real decision model in tests (the config files already point at a temp folder, see helpers.ts).
delete process.env.TYPESAFE_API_KEY;

test('the second session to touch a file is refused and told who holds it', () => {
  const repo = tempRepo();
  assert.deepEqual(claim(repo, A, ['src/server.js']).claimed, ['src/server.js']);
  const r = claim(repo, B, ['src/server.js', 'src/health.js']);
  assert.deepEqual(r.claimed, ['src/health.js']);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0]!.sessionId, A.sessionId);
  assert.equal(r.refused[0]!.ask, 'add a cache to getRates');
  // The holder itself is never refused; its lease is renewed.
  assert.deepEqual(claim(repo, A, ['src/server.js']).refused, []);
  // Releasing (session end) frees the file for the other session.
  assert.equal(release(repo, A.sessionId), 1);
  assert.deepEqual(claim(repo, B, ['src/server.js']).refused, []);
});

test('leases expire after the quiet period', () => {
  const repo = tempRepo();
  const prev = process.env.PL_LEASE_TTL_MIN;
  process.env.PL_LEASE_TTL_MIN = '0.005'; // 300 ms
  try {
    claim(repo, A, ['a.js']);
    const until = Date.now() + 400;
    while (Date.now() < until) {}
    assert.deepEqual(claim(repo, B, ['a.js']).refused, []);
    assert.deepEqual(listLeases(repo).map((l) => l.sessionId), [B.sessionId]);
  } finally {
    if (prev === undefined) delete process.env.PL_LEASE_TTL_MIN;
    else process.env.PL_LEASE_TTL_MIN = prev;
  }
});

test('leases are shared by every worktree of the repo', () => {
  const repo = tempRepo();
  const wt = mkdtempSync(join(tmpdir(), 'pl-wt-'));
  gitc(repo, 'worktree', 'add', '-q', '-b', 'other', join(wt, 'w'));
  claim(repo, A, ['src/server.js']);
  assert.equal(claim(join(wt, 'w'), B, ['src/server.js']).refused.length, 1);
});

test('which files a tool call is about to change', () => {
  const repo = '/r';
  assert.deepEqual(toolTargets(repo, '/r', 'Edit', { file_path: '/r/src/a.ts' }), ['src/a.ts']);
  assert.deepEqual(toolTargets(repo, '/r/src', 'Write', { file_path: 'b.ts' }), ['src/b.ts']);
  assert.deepEqual(toolTargets(repo, '/r', 'Edit', { file_path: '/elsewhere/x.ts' }), []);
  assert.deepEqual(toolTargets(repo, '/r', 'Read', { file_path: '/r/a.ts' }), []);
  assert.deepEqual(bashWriteTargets("python3 - <<'EOF'\np='src/agent.ts'; s=open(p).read()\nopen(p,'w').write(s)\nEOF"), ['src/agent.ts']);
  assert.deepEqual(bashWriteTargets('echo hi > notes.md && cat a.txt >> log.txt 2>/dev/null'), ['notes.md', 'log.txt']);
  assert.deepEqual(bashWriteTargets("sed -i '' 's/a/b/' src/x.ts"), ['src/x.ts']);
  assert.deepEqual(bashWriteTargets('git status && npm test'), []);
});

test('PreToolUse hook: refuses an edit another live session holds, with the reason the agent reads', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'server.js'), 'x\n');
  const a = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-lease-a-')), A.sessionId);
  a.t.human('add a cache to getRates');
  a.hook('UserPromptSubmit', { prompt: 'add a cache to getRates' });
  const call = (sid: string) => pl(repo, ['hook', 'PreToolUse'], JSON.stringify({ session_id: sid, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'server.js') } }));
  assert.equal(call(A.sessionId).stdout, '', 'the first session gets the file');
  const res = call(B.sessionId);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /server\.js: held by another agent session \(aaaaaaaa\)/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /working on: "add a cache to getRates"/);
  // `promptlog leases` shows it; releasing frees it.
  assert.match(pl(repo, ['leases']).stdout, /session aaaaaaaa.*add a cache to getRates[\s\S]*server\.js/);
  assert.match(pl(repo, ['leases', 'release', 'server.js']).stdout, /released 1 lease/);
  assert.equal(call(B.sessionId).stdout, '');
});

// ---------------------------------------------------------------------------
// The shared table on Cloudflare (agents on different machines), played by test/lease-server.ts
// ---------------------------------------------------------------------------

// Tests never touch the developer's Keychain: keys come from git config.
process.env.PL_LEASES_KEYCHAIN = 'off';

/** A clone on another machine: its own repo, pointed at the shared table. */
function machine(url: string, key: string): string {
  const repo = tempRepo();
  gitc(repo, 'config', 'promptlog.leases', `${url}/__leases/demo`);
  gitc(repo, 'config', 'promptlog.leasesKey', key);
  return repo;
}

const errorsLog = (repo: string) => (existsSync(join(repo, '.git/promptlog/errors.log')) ? readFileSync(join(repo, '.git/promptlog/errors.log'), 'utf8') : '');

test('agents on two machines share one lease table', async () => {
  const srv = await leaseServer('k3y');
  try {
    const m1 = machine(srv.url, 'k3y');
    const m2 = machine(srv.url, 'k3y');
    assert.deepEqual(claim(m1, A, ['src/server.js']).claimed, ['src/server.js']);
    const r = claim(m2, B, ['src/server.js', 'src/health.js']);
    assert.deepEqual(r.claimed, ['src/health.js']);
    assert.equal(r.refused[0]!.sessionId, A.sessionId);
    assert.equal(r.refused[0]!.ask, 'add a cache to getRates');
    assert.deepEqual(listLeases(m1).map((l) => l.path).sort(), ['src/health.js', 'src/server.js']);
    assert.equal(existsSync(join(m1, '.git/promptlog/leases.json')), false, 'nothing in the local file');
    assert.equal(release(m1, A.sessionId), 1);
    assert.deepEqual(claim(m2, B, ['src/server.js']).refused, []);
    assert.equal(errorsLog(m1) + errorsLog(m2), '');

    // The PreToolUse hook on machine 2 refuses an edit machine 1's agent holds.
    const edit = (repo: string, sid: string) =>
      pl(repo, ['hook', 'PreToolUse'], JSON.stringify({ session_id: sid, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'rates.js') } }));
    assert.equal(edit(m1, A.sessionId).stdout, '');
    const out = JSON.parse(edit(m2, B.sessionId).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /rates\.js: held by another agent session \(aaaaaaaa\)/);
    assert.match(pl(m2, ['leases']).stdout, /session aaaaaaaa[\s\S]*rates\.js/);
  } finally {
    srv.stop();
  }
});

test('an unreachable shared table: the local file is used, the failure logged, and no retry for a minute', async () => {
  const srv = await leaseServer('k3y');
  srv.stop(); // nothing listens on that port now
  await new Promise((r) => setTimeout(r, 100));
  const repo = machine(srv.url, 'k3y');
  const t0 = Date.now();
  assert.deepEqual(claim(repo, A, ['a.js']).claimed, ['a.js']);
  assert.ok(Date.now() - t0 < 2000, 'fails fast');
  assert.equal(claim(repo, B, ['a.js']).refused.length, 1, 'the local table still coordinates this machine');
  const log = errorsLog(repo);
  assert.match(log, /leases shared lease table http:\/\/127\.0\.0\.1:\d+\/__leases\/demo: claim failed/);
  assert.equal(log.trim().split('\n').length, 1, 'the second call went straight to the local file');
  assert.ok(!log.includes('k3y'), 'the key is never logged');
});

test('a shared table that hangs or refuses the key: the agent waits at most the timeout', async () => {
  const hung = await leaseServer('k3y', '--hang');
  const prev = process.env.PL_LEASES_TIMEOUT_MS;
  process.env.PL_LEASES_TIMEOUT_MS = '700';
  try {
    const repo = machine(hung.url, 'k3y');
    const t0 = Date.now();
    assert.deepEqual(claim(repo, A, ['a.js']).claimed, ['a.js']);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.match(errorsLog(repo), /claim failed/);
  } finally {
    hung.stop();
    if (prev === undefined) delete process.env.PL_LEASES_TIMEOUT_MS;
    else process.env.PL_LEASES_TIMEOUT_MS = prev;
  }
  const srv = await leaseServer('right-key');
  try {
    const repo = machine(srv.url, 'wrong-key');
    assert.deepEqual(claim(repo, A, ['a.js']).claimed, ['a.js']);
    assert.match(errorsLog(repo), /claim failed \(HTTP 401/);
    assert.ok(existsSync(join(repo, '.git/promptlog/leases.json')), 'claimed in the local file instead');
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------------------
// Blocks: two agents in one file
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

/** A repo with src/server.js. */
function serverRepo(repo = tempRepo()): string {
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/server.js'), SERVER);
  return repo;
}

/** What the agent's turn was asked (the hook reads it from the session's capture state). */
const asked = (repo: string, sid: string, prompt: string) =>
  pl(repo, ['hook', 'UserPromptSubmit'], JSON.stringify({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', transcript_path: '/dev/null', prompt }));

/** Claude Code's PreToolUse call for an Edit of src/server.js. Returns the parsed hook output (null: let through silently). */
function editHook(repo: string, sid: string, old: string): { out: Record<string, any> | null; ms: number } {
  const t0 = Date.now();
  const r = pl(repo, ['hook', 'PreToolUse'], JSON.stringify({ session_id: sid, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/server.js'), old_string: old, new_string: `${old} // changed` } }));
  assert.equal(r.status, 0);
  return { out: r.stdout ? JSON.parse(r.stdout) : null, ms: Date.now() - t0 };
}

test('which blocks an Edit or MultiEdit claims; anything we cannot place claims the whole file', () => {
  const repo = serverRepo();
  const c = editClaims(repo, repo, 'MultiEdit', { file_path: join(repo, 'src/server.js'), edits: [{ old_string: 'return RATES[cur];', new_string: 'x' }, { old_string: 'return s.trim()', new_string: 'y' }] });
  assert.deepEqual(c.paths, []);
  assert.deepEqual(c.blocks!.map((b) => b.block.name), ['getRates()', 'parseCurrency()']);
  assert.deepEqual(c.blocks![0]!.change, { old: 'return RATES[cur];', new: 'x' });
  assert.equal(c.texts!['src/server.js'], SERVER);
  assert.deepEqual(editClaims(repo, repo, 'Edit', { file_path: join(repo, 'src/server.js'), old_string: 'export function', new_string: 'function', replace_all: true }).blocks!.length, 4);
  assert.deepEqual(editClaims(repo, repo, 'Edit', { file_path: join(repo, 'src/server.js'), old_string: 'not there', new_string: 'x' }), { paths: ['src/server.js'] });
  assert.deepEqual(editClaims(repo, repo, 'Edit', { file_path: join(repo, 'src/new.js'), old_string: '', new_string: 'x' }), { paths: ['src/new.js'] });
  assert.deepEqual(editClaims(repo, repo, 'Write', { file_path: join(repo, 'src/server.js'), content: 'x' }), { paths: ['src/server.js'] });
});

test('PreToolUse hook, two worktrees: different functions both proceed; the same function is refused with its name; neighbours without Clef wait', () => {
  const a = serverRepo();
  gitc(a, 'add', '-A');
  gitc(a, 'commit', '-qm', 'server');
  const b = join(realpathSync(mkdtempSync(join(tmpdir(), 'pl-wt-'))), 'b');
  gitc(a, 'worktree', 'add', '-q', '-b', 'feature/format', b);
  asked(a, A.sessionId, 'add a cache to getRates');
  asked(b, B.sessionId, 'parse currency codes case-insensitively');

  assert.equal(editHook(a, A.sessionId, 'return RATES[cur];').out, null, 'A takes getRates()');
  assert.equal(editHook(b, B.sessionId, 'return s.trim()').out, null, 'B takes parseCurrency() in the same file');
  const same = editHook(b, B.sessionId, 'return RATES[cur];').out!;
  assert.equal(same.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(same.hookSpecificOutput.permissionDecisionReason, /another agent is working on this code right now/);
  assert.match(same.hookSpecificOutput.permissionDecisionReason, /- getRates\(\) in src\/server\.js \(lines 5-7 in your copy\): held by another agent session \(aaaaaaaa\) on branch main/);
  assert.match(same.hookSpecificOutput.permissionDecisionReason, /working on: "add a cache to getRates"/);
  assert.match(same.hookSpecificOutput.permissionDecisionReason, /Other functions in this file are free/);
  // formatRates() sits right under getRates(): a gray zone. No decision model on this machine: the safe default.
  const near = editHook(b, B.sessionId, 'return rates.map').out!;
  assert.equal(near.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(near.hookSpecificOutput.permissionDecisionReason, /You wanted formatRates\(\)\. No verdict on getRates\(\) and formatRates\(\) \(no decision model is set up on this machine\) → the second agent waited, to be safe\./);
  const listed = pl(b, ['leases']).stdout;
  assert.match(listed, /session aaaaaaaa on main, active 0 min ago: "add a cache to getRates"\n  src\/server\.js: getRates\(\)/);
  assert.match(listed, /session bbbbbbbb on feature\/format.*\n  src\/server\.js: parseCurrency\(\)/);
  assert.match(listed, /recent decisions:\n  No verdict on getRates\(\) and formatRates\(\)/);
  // A Write of the whole file is refused while anyone holds a block of it.
  const write = pl(b, ['hook', 'PreToolUse'], JSON.stringify({ session_id: B.sessionId, cwd: b, tool_name: 'Write', tool_input: { file_path: join(b, 'src/server.js'), content: '' } }));
  assert.match(JSON.parse(write.stdout).hookSpecificOutput.permissionDecisionReason, /getRates\(\) in src\/server\.js/);
});

test('the local decision model judges the gray zone when one is set up (here a fake one)', async () => {
  const repo = serverRepo();
  const take = (h: Holder, old: string, judge: Judge | null) => claimEdit(repo, h, editClaims(repo, repo, 'Edit', { file_path: join(repo, 'src/server.js'), old_string: old, new_string: 'x' }), { judge });
  await take(A, 'return RATES[cur];', null);
  const judge: Judge = async () => ({ model: 'jev-latest', answers: { verdict: { type: 'choice', choice: 'independent', probabilities: { independent: 0.91, conflicting: 0.05, unsure: 0.04 } } } });
  const r = await take(B, 'return rates.map', judge);
  assert.deepEqual(r.claimed, ['src/server.js']);
  assert.match(headsUpMessage(r.headsUp!), /^promptlog lease heads-up: another agent session \(aaaaaaaa\) on branch feature\/rates is working on getRates\(\) in src\/server\.js, right next to formatRates\(\), which you are editing \(their task: "add a cache to getRates"\)\. jev-latest judged the two changes independent \(91%\), so your edit goes ahead\./);
  assert.equal(listTable(repo).decisions[0]!.model, 'jev-latest');
});

test('the shared table asks Clef: independent -> allowed with a heads-up; conflicting or too slow -> refused with the verdict', async () => {
  const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'pl-clef-'))), 'clef.jsonl');
  const run = async (clef: string[], fn: (m1: string, m2: string) => void) => {
    const srv = await leaseServer('k3y', ...clef);
    try {
      const m1 = serverRepo(machine(srv.url, 'k3y'));
      const m2 = serverRepo(machine(srv.url, 'k3y'));
      asked(m1, A.sessionId, 'add a cache to getRates');
      asked(m2, B.sessionId, 'format rates with two decimals');
      assert.equal(editHook(m1, A.sessionId, 'return RATES[cur];').out, null);
      fn(m1, m2);
      assert.equal(errorsLog(m1) + errorsLog(m2), '');
    } finally {
      srv.stop();
    }
  };

  await run(['--clef', 'independent:0.84', '--log', log], (m1, m2) => {
    const { out } = editHook(m2, B.sessionId, 'return rates.map');
    // Let through with a heads-up: no permissionDecision, so the user's own permission rules still apply.
    assert.deepEqual(Object.keys(out!.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.match(out!.hookSpecificOutput.additionalContext, /heads-up: another agent session \(aaaaaaaa\) on branch main in .* is working on getRates\(\) in src\/server\.js, right next to formatRates\(\)/);
    assert.match(out!.hookSpecificOutput.additionalContext, /Clef judged the two changes independent \(84%\), so your edit goes ahead/);
    assert.match(pl(m1, ['leases']).stdout, /recent decisions:\n  Clef: getRates\(\) and formatRates\(\) are independent \(84%\) → both agents kept working \(src\/server\.js, 0 min ago\)/);
    // What Clef got: both asks, both blocks' code, the edit. Small.
    const reqs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].state.agent_a.asked_to, 'add a cache to getRates');
    assert.equal(reqs[0].state.agent_b.asked_to, 'format rates with two decimals');
    assert.equal(reqs[0].state.agent_a.code, 'export function getRates(cur) {\n  return RATES[cur];\n}');
    assert.match(reqs[0].state.agent_b.code, /^export function formatRates\(rates\)/);
    assert.ok(JSON.stringify(reqs[0]).length < 3000);
  });

  await run(['--clef', 'conflicting:0.8'], (_m1, m2) => {
    const { out } = editHook(m2, B.sessionId, 'return rates.map');
    assert.equal(out!.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out!.hookSpecificOutput.permissionDecisionReason, /getRates\(\) in src\/server\.js .*held by another agent session \(aaaaaaaa\)/);
    assert.match(out!.hookSpecificOutput.permissionDecisionReason, /You wanted formatRates\(\)\. Clef: getRates\(\) and formatRates\(\) conflict \(80%\) → the second agent waited\./);
  });

  await run(['--clef', 'hang', '--budget', '300'], (_m1, m2) => {
    const { out, ms } = editHook(m2, B.sessionId, 'return rates.map');
    assert.match(out!.hookSpecificOutput.permissionDecisionReason, /No verdict on getRates\(\) and formatRates\(\) \(Clef took longer than 0\.3 s\)/);
    assert.ok(ms < 3000, `the hook took ${ms} ms`);
  });
});
