import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRefs } from '../src/capture/sync.ts';
import { loadSession } from '../src/core/store.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session } from './capture-helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pl-sync-'));
const ref = (repo: string, id: string) => spawnSync('git', ['rev-parse', '-q', '--verify', `refs/promptlog/sessions/${id}`], { cwd: repo, encoding: 'utf8' }).stdout.trim();

function setup() {
  const remote = join(tmp(), 'remote.git');
  gitc(tmp(), 'init', '-q', '--bare', remote);
  const repo = tempRepo();
  gitc(repo, 'remote', 'add', 'origin', remote);
  gitc(repo, 'push', '-q', '-u', 'origin', 'main');
  return { remote, repo };
}

function turn(s: Session, text: string) {
  s.prompt(text);
  s.t.text('ok');
  s.hook('Stop');
}

test('pl push / pl fetch: share sessions through a remote', () => {
  const { remote, repo } = setup();
  assert.match(pl(repo, ['push']).stdout, /no sessions to push/);
  const s = new Session(repo, tmp());
  turn(s, 'one');
  const r = pl(repo, ['push']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pushed 1 session ref\(s\) to origin/);
  assert.equal(ref(remote, s.id), ref(repo, s.id));

  const clone = join(tmp(), 'clone');
  gitc(tmp(), 'clone', '-q', remote, clone);
  const f = pl(clone, ['fetch']);
  assert.equal(f.status, 0, f.stderr);
  assert.match(f.stdout, /1 session ref\(s\) new or updated/);
  assert.deepEqual(loadSession(clone, s.id)!.turns.map((t) => t.prompt), ['one']);

  // New turns upstream fast-forward the clone.
  turn(s, 'two');
  assert.equal(pl(repo, ['push', 'origin']).status, 0);
  assert.equal(fetchRefs(clone, 'origin').updated.length, 1);
  assert.equal(ref(clone, s.id), ref(repo, s.id));
});

test('pl fetch: never rewinds local, unpushed captures', () => {
  const { repo } = setup();
  const s = new Session(repo, tmp());
  turn(s, 'one');
  assert.equal(pl(repo, ['push']).status, 0);
  turn(s, 'two'); // local is now ahead of the remote
  const local = ref(repo, s.id);
  const res = fetchRefs(repo, 'origin');
  assert.ok(res.ok);
  assert.deepEqual(res.kept, [{ ref: `refs/promptlog/sessions/${s.id}`, reason: 'ahead' }]);
  assert.equal(ref(repo, s.id), local);
  assert.match(pl(repo, ['fetch']).stdout, /kept .*unpushed turns/);
});

test('pl push failures: non-zero normally, zero from the hook', () => {
  const repo = tempRepo();
  const s = new Session(repo, tmp());
  turn(s, 'one');
  assert.equal(pl(repo, ['push']).status, 1, 'no remote configured');
  assert.equal(pl(repo, ['push', join(tmp(), 'nope.git')]).status, 1);
  assert.equal(pl(repo, ['push', join(tmp(), 'nope.git'), '--from-hook']).status, 0);
});

test('pl install --auto-push: git push also pushes session refs (no recursion)', () => {
  const { remote, repo } = setup();
  assert.equal(pl(repo, ['install', '--auto-push']).status, 0);
  const s = new Session(repo, tmp());
  turn(s, 'one');
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  gitc(repo, 'add', 'f.txt');
  gitc(repo, 'commit', '-qm', 'f');
  const r = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /promptlog: pushed session refs to origin/);
  assert.equal(ref(remote, s.id), ref(repo, s.id));
  assert.equal(gitc(remote, 'rev-parse', 'main'), gitc(repo, 'rev-parse', 'main'));
});
