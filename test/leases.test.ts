// Leases: two agent sessions on one repo, editing the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashWriteTargets, claim, listLeases, release, toolTargets } from '../src/capture/leases.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session } from './capture-helpers.ts';

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
