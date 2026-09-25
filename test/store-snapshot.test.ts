import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffTrees, MAX_SNAPSHOT_FILE_BYTES, snapshotWorktree } from '../src/core/store.ts';
import { tempRepo } from './helpers.ts';
import { gitc } from './capture-helpers.ts';

const files = (repo: string, tree: string) => gitc(repo, 'ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean).sort();

test('snapshotWorktree: tracked + untracked files, never .gitignored ones, user index untouched', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.gitignore'), '.env\nbuild/\n');
  writeFileSync(join(repo, 'tracked.txt'), 'v1\n');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'base');
  writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
  writeFileSync(join(repo, 'new.txt'), 'new\n');
  writeFileSync(join(repo, 'staged.txt'), 'staged\n');
  gitc(repo, 'add', 'staged.txt');
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  mkdirSync(join(repo, 'build'));
  writeFileSync(join(repo, 'build', 'out.js'), 'x');
  const indexBefore = readFileSync(join(repo, '.git', 'index'));
  const statusBefore = gitc(repo, 'status', '--porcelain');

  const tree = snapshotWorktree(repo, 'snap1');
  assert.deepEqual(files(repo, tree), ['.gitignore', 'new.txt', 'staged.txt', 'tracked.txt']);
  assert.equal(gitc(repo, 'cat-file', '-p', `${tree}:tracked.txt`), 'v2', 'working tree content, not HEAD');
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'user index untouched');
  assert.equal(gitc(repo, 'status', '--porcelain'), statusBefore);

  // Re-snapshot picks up deletions and new files; unchanged content gives the same tree.
  rmSync(join(repo, 'new.txt'));
  const t2 = snapshotWorktree(repo, 'snap1');
  assert.deepEqual(files(repo, t2), ['.gitignore', 'staged.txt', 'tracked.txt']);
  assert.equal(snapshotWorktree(repo, 'snap1'), t2);
});

test('snapshotWorktree: files over the size limit are skipped without touching ignore files', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'big-tracked.bin'), 'small\n');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'base');
  writeFileSync(join(repo, 'small.txt'), 'x'.repeat(100));
  writeFileSync(join(repo, 'odd [name] *.bin'), 'y'.repeat(2000));
  writeFileSync(join(repo, 'big-tracked.bin'), 'z'.repeat(2000));
  let skipped: string[] = [];
  const tree = snapshotWorktree(repo, 'snap2', { maxFileBytes: 1000, onSkipped: (p) => (skipped = p) });
  assert.deepEqual(skipped.sort(), ['big-tracked.bin', 'odd [name] *.bin']);
  assert.deepEqual(files(repo, tree), ['big-tracked.bin', 'small.txt']);
  assert.equal(gitc(repo, 'cat-file', '-p', `${tree}:big-tracked.bin`), 'small', 'tracked big file keeps its last snapshotted version');
  assert.equal(gitc(repo, 'status', '--porcelain', '--ignored').includes('!!'), false, 'nothing became ignored');
});

test('snapshotWorktree: default limit is 5 MB', () => {
  const repo = tempRepo();
  assert.equal(MAX_SNAPSHOT_FILE_BYTES, 5 * 1024 * 1024);
  writeFileSync(join(repo, 'huge.bin'), Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES + 1));
  writeFileSync(join(repo, 'edge.bin'), Buffer.alloc(1024));
  assert.deepEqual(files(repo, snapshotWorktree(repo, 'snap3')), ['edge.bin']);
});

test('diffTrees: add, modify, delete, rename, binary', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'keep.txt'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'gone.txt'), 'bye\n');
  writeFileSync(join(repo, 'move-me.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3]));
  const a = snapshotWorktree(repo, 'd1');
  writeFileSync(join(repo, 'keep.txt'), 'a\nB\nc\nd\n');
  rmSync(join(repo, 'gone.txt'));
  renameSync(join(repo, 'move-me.txt'), join(repo, 'moved.txt'));
  writeFileSync(join(repo, 'fresh.txt'), '1\n2\n');
  writeFileSync(join(repo, 'img.bin'), Buffer.from([9, 9, 0, 9]));
  const b = snapshotWorktree(repo, 'd1');
  const changes = diffTrees(repo, a, b).sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(changes, [
    { status: 'A', path: 'fresh.txt', additions: 2, deletions: 0 },
    { status: 'D', path: 'gone.txt', additions: 0, deletions: 1 },
    { status: 'M', path: 'img.bin', additions: 0, deletions: 0 },
    { status: 'M', path: 'keep.txt', additions: 2, deletions: 1 },
    { status: 'R', oldPath: 'move-me.txt', path: 'moved.txt', additions: 0, deletions: 0 },
  ]);
  assert.deepEqual(diffTrees(repo, a, a), []);
});
