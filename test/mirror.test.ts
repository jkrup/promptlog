// Mirror: commits (and the turns that made them) reach the review remote with no `git push` from anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitMaybe } from '../src/core/git.ts';
import { mirrorPushArgs, mirrorRemote } from '../src/capture/mirror.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session } from './capture-helpers.ts';

function bareRemote(repo: string, name = 'artifacts'): string {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'pl-mirror-remote-')));
  gitc(bare, 'init', '-q', '--bare');
  gitc(repo, 'remote', 'add', name, bare);
  return bare;
}

/** Background pushes finish on their own time: wait for a ref to show up on the remote. */
async function waitForRef(bare: string, ref: string, ms = 15_000): Promise<string | null> {
  const until = Date.now() + ms;
  for (;;) {
    const sha = gitMaybe(['rev-parse', '-q', '--verify', ref], { cwd: bare });
    if (sha || Date.now() > until) return sha;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('mirrorRemote: an `artifacts` remote, unless promptlog.mirror says otherwise', () => {
  const repo = tempRepo();
  assert.equal(mirrorRemote(repo), null);
  bareRemote(repo, 'origin');
  assert.equal(mirrorRemote(repo), null);
  bareRemote(repo);
  assert.equal(mirrorRemote(repo), 'artifacts');
  gitc(repo, 'config', 'promptlog.mirror', 'origin');
  assert.equal(mirrorRemote(repo), 'origin');
  gitc(repo, 'config', 'promptlog.mirror', 'false');
  assert.equal(mirrorRemote(repo), null);
});

test('mirrorPushArgs: the current branch (forced) and session refs (never forced)', () => {
  const repo = tempRepo();
  gitc(repo, 'checkout', '-qb', 'feature/x');
  assert.deepEqual(mirrorPushArgs(repo, 'artifacts'), ['push', '--no-verify', '--quiet', 'artifacts', '+refs/heads/feature/x:refs/heads/feature/x', 'refs/promptlog/*:refs/promptlog/*']);
});

test('a plain git commit lands on the review remote by itself', async () => {
  const repo = tempRepo();
  const bare = bareRemote(repo);
  assert.equal(pl(repo, ['install']).status, 0);
  gitc(repo, 'checkout', '-qb', 'fix-thing');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  gitc(repo, 'add', 'a.txt');
  gitc(repo, 'commit', '-qm', 'add a');
  const head = gitc(repo, 'rev-parse', 'HEAD').trim();
  assert.equal(await waitForRef(bare, 'refs/heads/fix-thing'), head);
});

test('a turn that commits also pushes its conversation; a turn that does not, pushes nothing', async () => {
  const repo = tempRepo();
  const bare = bareRemote(repo);
  gitc(repo, 'checkout', '-qb', 'agent-work');
  const s = new Session(repo, realpathSync(mkdtempSync(join(tmpdir(), 'pl-mirror-'))));

  s.t.human('look around, change nothing');
  s.hook('UserPromptSubmit');
  s.t.text('nothing to change');
  s.hook('Stop');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(gitMaybe(['rev-parse', '-q', '--verify', `refs/promptlog/sessions/${s.id}`], { cwd: bare }), null);

  s.t.human('add b.txt and commit');
  s.hook('UserPromptSubmit');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  gitc(repo, 'add', 'b.txt');
  gitc(repo, 'commit', '-qm', 'add b');
  s.t.text('committed');
  s.hook('Stop');
  const local = gitc(repo, 'rev-parse', `refs/promptlog/sessions/${s.id}`).trim();
  assert.equal(await waitForRef(bare, `refs/promptlog/sessions/${s.id}`), local);
  assert.ok(await waitForRef(bare, 'refs/heads/agent-work'));
});
