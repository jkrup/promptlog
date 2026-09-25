import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashBlob, lsTree, mktree, readBlobText } from '../src/core/git.ts';
import { captureSession, loadSession, readStoredSession, sessionRef, snapshotWorktree } from '../src/core/store.ts';
import type { SessionMeta, TurnMeta } from '../src/core/types.ts';
import { tempRepo } from './helpers.ts';
import { gitc, Transcript } from './capture-helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pl-t-'));
const turnsTree = (repo: string, commit: string) => lsTree(repo, commit).find((e) => e.name === 'turns')!.sha;
const turnEntry = (repo: string, commit: string, n: number) => lsTree(repo, `${commit}:turns`).find((e) => e.name === String(n).padStart(6, '0'))!;

function threeTurns() {
  const t = new Transcript();
  t.human('one');
  t.text('first answer');
  t.human('two');
  t.text('second answer');
  t.human('three');
  t.text('third answer');
  return t;
}

test('captureSession: re-running on the same transcript is a no-op with a stable tree', () => {
  const repo = tempRepo();
  const path = threeTurns().write(join(tmp(), 's.jsonl'));
  const a = captureSession({ root: repo, sessionId: 's1', transcriptPath: path })!;
  const b = captureSession({ root: repo, sessionId: 's1', transcriptPath: path })!;
  assert.equal(a.turnCount, 3);
  assert.equal(b.commit, a.commit, 'no new commit when nothing changed');
  assert.equal(gitc(repo, 'rev-list', '--count', sessionRef('s1')), '1');
  // A capture that must write (session patch) still produces the identical turns tree.
  const c = captureSession({ root: repo, sessionId: 's1', transcriptPath: path, sessionPatch: { endedAt: '2026-01-02T00:00:00Z' } })!;
  assert.notEqual(c.commit, a.commit);
  assert.equal(turnsTree(repo, c.commit), turnsTree(repo, a.commit));
  assert.equal(gitc(repo, 'rev-parse', `${c.commit}^`), a.commit, 'append-only chain');
});

test('captureSession: late-flushed lines heal the previous turn; older turns are reused', () => {
  const repo = tempRepo();
  const dir = tmp();
  const t = new Transcript();
  t.human('one');
  t.text('answer one');
  t.human('two');
  t.text('partial');
  const path = t.write(join(dir, 's.jsonl'));
  const first = captureSession({ root: repo, sessionId: 's2', transcriptPath: path })!;
  const turn1Before = turnEntry(repo, first.commit, 1).sha;

  // Turn 2's tail flushes only after turn 3 started.
  let n = t.lines.length;
  t.text('late line for turn two');
  t.human('three');
  t.appendSince(path, n);
  const second = captureSession({ root: repo, sessionId: 's2', transcriptPath: path })!;
  const s = readStoredSession(repo, 's2')!;
  assert.equal(s.turns.length, 3);
  assert.ok(s.turns[1]!.transcript.some((l) => l.includes('late line for turn two')), 'turn 2 healed');
  assert.equal(turnEntry(repo, second.commit, 1).sha, turn1Before, 'turn 1 is inside the rewrite window but unchanged');

  n = t.lines.length;
  t.text('answer three');
  t.human('four');
  t.appendSince(path, n);
  const third = captureSession({ root: repo, sessionId: 's2', transcriptPath: path })!;
  assert.equal(turnEntry(repo, third.commit, 1).sha, turn1Before, 'older turns reused as-is');
  assert.deepEqual(loadSession(repo, 's2')!.turns.map((x) => x.prompt), ['one', 'two', 'three', 'four']);
});

test('captureSession: never drops stored turns when the transcript shrinks', () => {
  const repo = tempRepo();
  const dir = tmp();
  const full = threeTurns();
  const path = full.write(join(dir, 's.jsonl'));
  captureSession({ root: repo, sessionId: 's3', transcriptPath: path });
  const short = new Transcript();
  short.human('one');
  short.write(path);
  captureSession({ root: repo, sessionId: 's3', transcriptPath: path });
  assert.equal(readStoredSession(repo, 's3')!.turns.length, 3);
});

test('captureSession: redacts transcript, title and commit message', () => {
  const repo = tempRepo();
  const t = new Transcript();
  t.human('deploy with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  t.text('ok');
  const path = t.write(join(tmp(), 's.jsonl'));
  const redact = (s: string) => s.replace(/sk-ant-[\w-]+/g, '[REDACTED:anthropic-key]');
  const res = captureSession({ root: repo, sessionId: 's4', transcriptPath: path, redact })!;
  const s = readStoredSession(repo, 's4')!;
  assert.match(s.meta.title!, /\[REDACTED:anthropic-key\]/);
  assert.ok(!s.turns[0]!.transcript.join('\n').includes('sk-ant-api03'));
  assert.ok(!gitc(repo, 'log', '-1', '--format=%B', res.commit).includes('sk-ant-api03'));
});

test('captureSession: extra files merge into turns and survive later captures', () => {
  const repo = tempRepo();
  const dir = tmp();
  const t = new Transcript();
  t.human('one');
  t.text('a');
  t.human('two');
  const path = t.write(join(dir, 's.jsonl'));
  captureSession({ root: repo, sessionId: 's5', transcriptPath: path, extraFiles: new Map([[2, { 'subagents/agent-a.jsonl': '{"a":1}\n' }]]) });
  // Another subagent for the same turn is added without dropping the first; bad paths are ignored.
  captureSession({
    root: repo,
    sessionId: 's5',
    transcriptPath: path,
    extraFiles: new Map([[2, { 'subagents/agent-b.jsonl': '{"b":1}\n', '../escape': 'x', 'meta.json': 'x' }]]),
  });
  // Later turns push turn 2 out of the rewrite window; its subagents stay.
  let n = t.lines.length;
  t.human('three');
  t.human('four');
  t.appendSince(path, n);
  let res = captureSession({ root: repo, sessionId: 's5', transcriptPath: path })!;
  const sub = lsTree(repo, `${res.commit}:turns/000002/subagents`).map((e) => e.name);
  assert.deepEqual(sub.sort(), ['agent-a.jsonl', 'agent-b.jsonl']);
  assert.equal(JSON.parse(readBlobText(repo, `${res.commit}:turns/000002/meta.json`)!).index, 2);

  // Extra files for an old turn (outside the window) force that turn to be rewritten.
  res = captureSession({ root: repo, sessionId: 's5', transcriptPath: path, extraFiles: new Map([[1, { 'subagents/late.jsonl': '{}\n' }]]) })!;
  assert.deepEqual(lsTree(repo, `${res.commit}:turns/000001/subagents`).map((e) => e.name), ['late.jsonl']);
  n = t.lines.length;
  t.text('more');
  t.appendSince(path, n);
  res = captureSession({ root: repo, sessionId: 's5', transcriptPath: path })!;
  assert.deepEqual(lsTree(repo, `${res.commit}:turns/000002/subagents`).map((e) => e.name).sort(), ['agent-a.jsonl', 'agent-b.jsonl']);
});

test('captureSession: keeps entries other tools add to turn trees and the root tree', () => {
  const repo = tempRepo();
  const t = new Transcript();
  t.human('one');
  const path = t.write(join(tmp(), 's.jsonl'));
  const first = captureSession({ root: repo, sessionId: 's6', transcriptPath: path })!;
  // Simulate another tool writing asks/ at the root and in turn 1.
  const note = { mode: '100644', type: 'blob' as const, sha: hashBlob(repo, 'q?'), name: 'q.json' };
  const asks = { mode: '040000', type: 'tree' as const, sha: mktree(repo, [note]), name: 'asks' };
  const turn1 = mktree(repo, [...lsTree(repo, `${first.commit}:turns/000001`), asks]);
  const turns = mktree(repo, [{ mode: '040000', type: 'tree', sha: turn1, name: '000001' }]);
  const rootTree = mktree(repo, [...lsTree(repo, first.commit).filter((e) => e.name !== 'turns'), { mode: '040000', type: 'tree', sha: turns, name: 'turns' }, asks]);
  const c = gitc(repo, 'commit-tree', rootTree, '-p', first.commit, '-m', 'ask');
  gitc(repo, 'update-ref', sessionRef('s6'), c);

  const n = t.lines.length;
  t.text('answer');
  t.appendSince(path, n);
  const res = captureSession({ root: repo, sessionId: 's6', transcriptPath: path })!;
  assert.equal(readBlobText(repo, `${res.commit}:asks/q.json`), 'q?');
  assert.equal(readBlobText(repo, `${res.commit}:turns/000001/asks/q.json`), 'q?');
});

test('captureSession: TurnMeta.commits lists commits made during the turn', () => {
  const repo = tempRepo();
  const t = new Transcript();
  t.human('commit something');
  const path = t.write(join(tmp(), 's.jsonl'));
  const headBefore = gitc(repo, 'rev-parse', 'HEAD');
  const stateBefore = snapshotWorktree(repo, 's7');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  gitc(repo, 'add', 'a.txt');
  gitc(repo, 'commit', '-qm', 'one');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  gitc(repo, 'add', 'b.txt');
  gitc(repo, 'commit', '-qm', 'two');
  const headAfter = gitc(repo, 'rev-parse', 'HEAD');
  const res = captureSession({
    root: repo,
    sessionId: 's7',
    transcriptPath: path,
    current: { pending: { startedAt: 'x', headBefore, stateBefore }, stateAfter: snapshotWorktree(repo, 's7'), headAfter },
  })!;
  const meta = JSON.parse(readBlobText(repo, `${res.commit}:turns/000001/meta.json`)!) as TurnMeta;
  assert.deepEqual(meta.commits, [gitc(repo, 'rev-parse', 'HEAD~1'), headAfter]);
  assert.deepEqual(meta.filesChanged!.map((f) => [f.status, f.path]), [['A', 'a.txt'], ['A', 'b.txt']]);
  assert.equal(lsTree(repo, `${res.commit}:turns/000001`).find((e) => e.name === 'before')?.sha, stateBefore);
});

test('captureSession: no pending turn means no commit attribution (not the whole history)', () => {
  const repo = tempRepo();
  const t = new Transcript();
  t.human('hooks installed mid-turn');
  const path = t.write(join(tmp(), 's.jsonl'));
  const res = captureSession({ root: repo, sessionId: 's8', transcriptPath: path, current: { headAfter: gitc(repo, 'rev-parse', 'HEAD') } })!;
  const meta = JSON.parse(readBlobText(repo, `${res.commit}:turns/000001/meta.json`)!) as TurnMeta;
  assert.deepEqual(meta.commits, []);
  const session = JSON.parse(readBlobText(repo, `${res.commit}:session.json`)!) as SessionMeta;
  assert.equal(session.sessionId, 's8');
});
