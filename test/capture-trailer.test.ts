import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookScript, hooksDir, installGitHooks, isOurHook } from '../src/capture/githooks.ts';
import { readCaptureState } from '../src/capture/state.ts';
import { addTrailers, pendingTrailers, stripIfOnlyTrailers } from '../src/capture/trailer.ts';
import { commitsInRange } from '../src/core/review.ts';
import { tempRepo } from './helpers.ts';
import { gitc, PL, pl, Session } from './capture-helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pl-tr-'));
const body = (repo: string, rev = 'HEAD') => gitc(repo, 'log', '-1', '--format=%B', rev);
const trailers = (repo: string, rev = 'HEAD') => body(repo, rev).split('\n').filter((l) => l.startsWith('Promptlog:'));

function commitFile(repo: string, name: string, args: string[] = ['-m', `add ${name}`], env: Record<string, string> = {}) {
  writeFileSync(join(repo, name), name + '\n');
  gitc(repo, 'add', name);
  return spawnSync('git', ['commit', '-q', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
}

function sessionWithTurns(repo: string, n: number): Session {
  const s = new Session(repo, tmp());
  for (let i = 1; i <= n; i++) {
    s.prompt(`turn ${i}`);
    s.t.text('ok');
    s.hook('Stop');
  }
  return s;
}

test('promptlog install: Claude Code hooks include SubagentStop; git hooks installed and chained', () => {
  const repo = tempRepo();
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\necho "Reviewed-by: existing-hook" >> "$1"\n');
  chmodSync(join(hooks, 'prepare-commit-msg'), 0o755);
  const r = pl(repo, ['install', '--auto-push']);
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
  for (const h of ['prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push']) assert.ok(isOurHook(join(hooks, h)), h);
  assert.ok(readFileSync(join(hooks, 'prepare-commit-msg.pre-promptlog'), 'utf8').includes('existing-hook'));
  assert.match(r.stdout, /kept your existing prepare-commit-msg hook/);
  // Re-running is idempotent: our scripts are rewritten, the backup is not replaced by our own script.
  assert.equal(pl(repo, ['install']).status, 0);
  assert.ok(readFileSync(join(hooks, 'prepare-commit-msg.pre-promptlog'), 'utf8').includes('existing-hook'));
  assert.equal(JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')).hooks.Stop.length, 1);

  // Both hooks run on commit.
  sessionWithTurns(repo, 1);
  assert.equal(commitFile(repo, 'a.txt').status, 0);
  assert.match(body(repo), /Reviewed-by: existing-hook/);
  assert.equal(trailers(repo).length, 1);
});

test('trailer: added for turns since the last commit, cleared after commit, no duplicate on amend', () => {
  const repo = tempRepo();
  installGitHooks(repo, PL);
  const s = sessionWithTurns(repo, 2);
  assert.equal(commitFile(repo, 'a.txt').status, 0);
  assert.deepEqual(trailers(repo), [`Promptlog: ${s.id}#2`]);
  assert.deepEqual(readCaptureState(repo, s.id)!.turnsSinceCommit, []);
  assert.deepEqual(commitsInRange(repo, 'HEAD~1', 'HEAD')[0]!.trailers, [{ sessionId: s.id, turn: 2 }]);

  // Amend: the message already carries the trailer; nothing is duplicated.
  const amend = spawnSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: repo, encoding: 'utf8' });
  assert.equal(amend.status, 0, amend.stderr);
  assert.deepEqual(trailers(repo), [`Promptlog: ${s.id}#2`]);

  // No new turns: the next commit gets no trailer.
  assert.equal(commitFile(repo, 'b.txt').status, 0);
  assert.deepEqual(trailers(repo), []);
});

test('trailer: a commit during an in-progress turn is tagged with that turn; amend in the same turn does not duplicate', () => {
  const repo = tempRepo();
  installGitHooks(repo, PL);
  const s = sessionWithTurns(repo, 1);
  gitc(repo, 'commit', '-q', '--allow-empty', '-m', 'consume turn 1');
  s.prompt('turn 2 commits'); // no Stop yet: the agent commits mid-turn
  assert.equal(commitFile(repo, 'c.txt').status, 0);
  assert.deepEqual(trailers(repo), [`Promptlog: ${s.id}#2`]);
  assert.equal(spawnSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: repo }).status, 0);
  assert.deepEqual(trailers(repo), [`Promptlog: ${s.id}#2`]);
});

test('trailer: one line per session, several sessions', () => {
  const repo = tempRepo();
  installGitHooks(repo, PL);
  const a = sessionWithTurns(repo, 1);
  const b = sessionWithTurns(repo, 3);
  assert.equal(commitFile(repo, 'x.txt').status, 0);
  assert.deepEqual(trailers(repo).sort(), [`Promptlog: ${a.id}#1`, `Promptlog: ${b.id}#3`].sort());
});

test('trailer: an otherwise empty message still aborts the commit', () => {
  const repo = tempRepo();
  installGitHooks(repo, PL);
  const s = sessionWithTurns(repo, 1);
  const before = gitc(repo, 'rev-parse', 'HEAD');
  // GIT_EDITOR=true leaves the template untouched: only comments and our trailer.
  const r = commitFile(repo, 'e.txt', [], { GIT_EDITOR: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty commit message/i);
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), before);
  assert.deepEqual(readCaptureState(repo, s.id)!.turnsSinceCommit, [1], 'turns are kept for the real commit');

  const msg = join(tmp(), 'MSG');
  writeFileSync(msg, 'real subject\n\nPromptlog: abc#1\n# comment\n');
  assert.equal(stripIfOnlyTrailers(repo, msg), false);
  writeFileSync(msg, '\nPromptlog: abc#1\n# Please enter a message\n# ------------------------ >8 ------------------------\ndiff --git a b\n');
  assert.equal(stripIfOnlyTrailers(repo, msg), true);
  assert.equal(readFileSync(msg, 'utf8'), '\n# Please enter a message\n# ------------------------ >8 ------------------------\ndiff --git a b\n');
});

test('trailer: skipped for merges and while rebasing', () => {
  const repo = tempRepo();
  const s = sessionWithTurns(repo, 1);
  const msg = join(tmp(), 'MSG');
  writeFileSync(msg, 'Merge branch x\n');
  assert.deepEqual(addTrailers(repo, msg, 'merge'), []);
  mkdirSync(join(repo, '.git', 'rebase-merge'));
  assert.deepEqual(addTrailers(repo, msg, 'message'), []);
  assert.equal(readFileSync(msg, 'utf8'), 'Merge branch x\n');
  assert.deepEqual(pendingTrailers(repo), [{ sessionId: s.id, turn: 1 }]);
});

test('trailer: a chained hook that fails still aborts the commit', () => {
  const repo = tempRepo();
  const hooks = hooksDir(repo);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  installGitHooks(repo, PL);
  const r = commitFile(repo, 'z.txt');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lint failed/);
});

test('trailer: worktrees share hooks but keep their own sessions; core.hooksPath is honoured', () => {
  const repo = tempRepo();
  const wt = join(tmp(), 'wt');
  gitc(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  // Installing from the linked worktree writes to the common hooks dir.
  const res = installGitHooks(wt, PL);
  assert.equal(res.dir, join(repo, '.git', 'hooks'));
  const s = sessionWithTurns(wt, 1);
  assert.equal(commitFile(repo, 'main.txt').status, 0);
  assert.deepEqual(trailers(repo), [], 'main worktree has no sessions');
  assert.equal(commitFile(wt, 'side.txt').status, 0);
  assert.deepEqual(trailers(wt), [`Promptlog: ${s.id}#1`]);

  const other = tempRepo();
  gitc(other, 'config', 'core.hooksPath', '.githooks');
  assert.equal(installGitHooks(other, PL).dir, join(other, '.githooks'));
  assert.ok(existsSync(join(other, '.githooks', 'post-commit')));
});

test('hookScript: quotes the promptlog path', () => {
  const s = hookScript('post-commit', "/opt/it's here/bin/promptlog");
  assert.match(s, /PL='\/opt\/it'\\''s here\/bin\/promptlog'/);
});
