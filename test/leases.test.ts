// Leases: two agent sessions on one repo, editing the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashWriteTargets, claim, listLeases, release, toolTargets } from '../src/capture/leases.ts';
import { tempRepo } from './helpers.ts';
import { gitc, leaseServer, pl, Session } from './capture-helpers.ts';

const A = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', branch: 'feature/rates', ask: 'add a cache to getRates' };
const B = { sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', branch: 'feature/health' };

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
