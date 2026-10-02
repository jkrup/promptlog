import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadForkMarkerReader } from '../src/capture/fork.ts';
import { handleHook } from '../src/capture/hook.ts';
import { readCaptureState, withLock } from '../src/capture/state.ts';
import { lsTree, readBlobText } from '../src/core/git.ts';
import { localDir, readStoredSession } from '../src/core/store.ts';
import type { SessionMeta, TurnMeta } from '../src/core/types.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session } from './capture-helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pl-h-'));
const turnMeta = (repo: string, commit: string, n: number) => JSON.parse(readBlobText(repo, `${commit}:turns/${String(n).padStart(6, '0')}/meta.json`)!) as TurnMeta;
const head = (repo: string, id: string) => gitc(repo, 'rev-parse', `refs/promptlog/sessions/${id}`);

test('hooks: a turn is captured with before/after snapshots, file changes and a redacted transcript', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, '.env'), 'STRIPE=sk_live_x\n');
  const s = new Session(repo, tmp());
  s.hook('SessionStart', { source: 'startup' });
  s.prompt('add a greeting');
  const id = s.t.toolUse('Bash', { command: 'cat .env' });
  s.t.toolResult(id, 'DB_PASSWORD=hunter22');
  writeFileSync(join(repo, 'hello.txt'), 'hi\n');
  s.t.text('Added hello.txt');
  s.hook('Stop');

  const stored = readStoredSession(repo, s.id)!;
  assert.equal(stored.turns.length, 1);
  const m = stored.turns[0]!.meta;
  assert.ok(m.stateBefore && m.stateAfter && m.stateBefore !== m.stateAfter);
  assert.deepEqual(m.filesChanged!.map((f) => [f.status, f.path]), [['A', 'hello.txt']]);
  assert.deepEqual(m.commits, []);
  const tree = lsTree(repo, `${stored.commit}:turns/000001`).map((e) => e.name);
  assert.deepEqual(tree.sort(), ['after', 'before', 'meta.json', 'transcript.jsonl']);
  assert.ok(!gitc(repo, 'ls-tree', '-r', '--name-only', m.stateAfter!).includes('.env'), '.env never snapshotted');
  const raw = stored.turns[0]!.transcript.join('\n');
  assert.ok(raw.includes('DB_PASSWORD=[REDACTED:password]') && !raw.includes('hunter22'));
  for (const line of stored.turns[0]!.transcript) JSON.parse(line);

  const st = readCaptureState(repo, s.id)!;
  assert.deepEqual(st.turnsSinceCommit, [1]);
  assert.equal(st.lastTurn, 1);
  assert.equal(st.pending, undefined);
  const session = JSON.parse(readBlobText(repo, `${stored.commit}:session.json`)!) as SessionMeta;
  assert.equal(session.title, 'add a greeting');
});

test('hooks: commits made inside a turn are linked; human edits between turns show up', () => {
  const repo = tempRepo();
  const s = new Session(repo, tmp());
  s.prompt('one');
  writeFileSync(join(repo, 'a.txt'), '1\n');
  s.hook('Stop');
  writeFileSync(join(repo, 'human.txt'), 'edited by hand\n');
  s.prompt('commit it');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'agent commit');
  s.t.text('committed');
  s.hook('Stop');
  const c = head(repo, s.id);
  const m1 = turnMeta(repo, c, 1);
  const m2 = turnMeta(repo, c, 2);
  assert.deepEqual(m2.commits, [gitc(repo, 'rev-parse', 'HEAD')]);
  assert.deepEqual(m1.commits, []);
  const between = gitc(repo, 'diff-tree', '-r', '--name-only', m1.stateAfter!, m2.stateBefore!);
  assert.equal(between, 'human.txt');
  assert.deepEqual(readCaptureState(repo, s.id)!.turnsSinceCommit, [1, 2]);
});

function writeSubagent(dir: string, sessionId: string, agentId: string, promptId: string | undefined): string {
  const subDir = join(dir, sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const path = join(subDir, `agent-${agentId}.jsonl`);
  const lines = [
    { type: 'user', isSidechain: true, agentId, ...(promptId ? { promptId } : {}), uuid: 'u1', message: { role: 'user', content: 'explore; token=abcd1234' } },
    { type: 'assistant', isSidechain: true, agentId, uuid: 'u2', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'found it' }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'look around' }));
  return path;
}

test('hooks: SubagentStop transcripts are stored under their turn and preserved by later captures', () => {
  const repo = tempRepo();
  const dir = tmp();
  const s = new Session(repo, dir);
  s.prompt('one');
  s.hook('Stop');
  s.prompt('use a subagent');
  const task = s.t.toolUse('Task', { prompt: 'explore' });
  const fg = writeSubagent(dir, s.id, 'fg1', s.t.promptId);
  s.hook('SubagentStop', { agent_id: 'fg1', agent_transcript_path: fg });
  s.t.toolResult(task, 'report');
  // A background subagent launched in turn 2...
  const bgPrompt = s.t.promptId;
  s.hook('Stop');
  s.prompt('three');
  // ...finishes during turn 3, but belongs to turn 2 (matched by promptId).
  const bg = writeSubagent(dir, s.id, 'bg1', bgPrompt);
  s.hook('SubagentStop', { agent_id: 'bg1', agent_transcript_path: bg });
  // A subagent without promptId goes to the latest turn.
  const anon = writeSubagent(dir, s.id, 'anon', undefined);
  s.hook('SubagentStop', { agent_id: 'anon', agent_transcript_path: anon });
  s.hook('Stop');

  let c = head(repo, s.id);
  const sub2 = lsTree(repo, `${c}:turns/000002/subagents`).map((e) => e.name).sort();
  assert.deepEqual(sub2, ['agent-bg1.jsonl', 'agent-bg1.meta.json', 'agent-fg1.jsonl', 'agent-fg1.meta.json']);
  assert.deepEqual(lsTree(repo, `${c}:turns/000003/subagents`).map((e) => e.name).sort(), ['agent-anon.jsonl', 'agent-anon.meta.json']);
  const stored = readBlobText(repo, `${c}:turns/000002/subagents/agent-fg1.jsonl`)!;
  assert.ok(stored.includes('token=[REDACTED:token]'), 'subagent transcripts are redacted');
  assert.ok(!lsTree(repo, `${c}:turns/000001`).some((e) => e.name === 'subagents'));

  // Two more turns push turn 2 out of the rewrite window: its subagents stay, local records are pruned.
  s.prompt('four');
  s.hook('Stop');
  s.prompt('five');
  s.hook('Stop');
  c = head(repo, s.id);
  assert.equal(lsTree(repo, `${c}:turns/000002/subagents`).length, 4);
  assert.equal(lsTree(repo, `${c}:turns/000003/subagents`).length, 2);
  assert.equal(readCaptureState(repo, s.id)!.subagents, undefined);
});

test('hooks: SessionEnd closes an interrupted turn and cleans up the temp index', () => {
  const repo = tempRepo();
  const s = new Session(repo, tmp());
  s.prompt('one');
  s.hook('Stop');
  s.prompt('interrupted');
  writeFileSync(join(repo, 'partial.txt'), 'x\n');
  s.t.userText('[Request interrupted by user]');
  assert.ok(existsSync(join(localDir(repo), `index-${s.id}`)));
  s.hook('SessionEnd', { reason: 'exit' });
  const stored = readStoredSession(repo, s.id)!;
  assert.equal(stored.turns.length, 2);
  assert.deepEqual(stored.turns[1]!.meta.filesChanged!.map((f) => f.path), ['partial.txt']);
  assert.ok(stored.meta.endedAt);
  const st = readCaptureState(repo, s.id)!;
  assert.equal(st.ended, true);
  assert.equal(st.pending, undefined);
  assert.deepEqual(st.turnsSinceCommit, [1, 2]);
  assert.ok(!existsSync(join(localDir(repo), `index-${s.id}`)));
});

test('hooks: a session in a `promptlog fork` worktree records its parent', async () => {
  const readForkMarker = await loadForkMarkerReader();
  assert.ok(readForkMarker, 'src/ask exports readForkMarker');
  const repo = tempRepo();
  const dir = tmp();
  const fork = new Session(repo, dir);
  const parentPromptUuid = fork.t.human('copied from the parent (turn 3)');
  fork.t.text('ok');
  fork.prompt('continue differently');
  writeFileSync(
    join(localDir(repo), 'fork.json'),
    JSON.stringify({ schema: 1, parent: { sessionId: 'parent-session', turn: 3 }, parentPromptUuid, transcriptPath: '', branch: 'b', commit: 'c' }),
  );
  fork.hook('Stop', {}, { readForkMarker });
  assert.deepEqual(readStoredSession(repo, fork.id)!.meta.parent, { sessionId: 'parent-session', turn: 3 });

  // An unrelated session started in the same worktree is not a fork.
  const other = new Session(repo, dir);
  other.prompt('something else');
  other.hook('Stop', {}, { readForkMarker });
  assert.equal(readStoredSession(repo, other.id)!.meta.parent, undefined);

  // Through the CLI (dynamic import of src/ask).
  const cli = new Session(repo, dir);
  cli.t.lines.push(fork.t.lines[0]!);
  cli.t.human('via cli');
  cli.flush();
  assert.equal(pl(repo, ['hook', 'Stop'], JSON.stringify({ session_id: cli.id, transcript_path: cli.path, cwd: repo })).status, 0);
  assert.deepEqual(readStoredSession(repo, cli.id)!.meta.parent, { sessionId: 'parent-session', turn: 3 });
});

test('hooks: nothing happens outside a git repo', () => {
  const dir = tmp();
  const t = join(dir, 't.jsonl');
  writeFileSync(t, '');
  handleHook('UserPromptSubmit', { session_id: 'x1', transcript_path: t, cwd: dir });
  handleHook('Stop', { session_id: 'x1', transcript_path: t, cwd: join(dir, 'missing') });
  const r = pl(dir, ['hook', 'Stop'], JSON.stringify({ session_id: 'x1', transcript_path: t, cwd: dir }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(!existsSync(join(dir, '.git')));
});

test('bin/promptlog hook: reads JSON on stdin, exits 0, logs errors instead of failing', () => {
  const repo = tempRepo();
  const dir = tmp();
  const s = new Session(repo, dir);
  s.t.human('via the CLI');
  s.flush();
  const payload = (extra = {}) => JSON.stringify({ session_id: s.id, transcript_path: s.path, cwd: repo, ...extra });
  assert.equal(pl(repo, ['hook', 'UserPromptSubmit'], payload()).status, 0);
  const r = pl(repo, ['hook', 'Stop'], payload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'hooks print nothing (stdout would be injected into the conversation)');
  assert.equal(readStoredSession(repo, s.id)!.turns.length, 1);

  const errors = join(localDir(repo), 'errors.log');
  assert.equal(pl(repo, ['hook', 'Stop'], '{not json').status, 0);
  assert.equal(pl(repo, ['hook', 'Stop'], payload({ session_id: '../../evil' })).status, 0);
  const log = readFileSync(errors, 'utf8');
  assert.match(log, /Stop .*JSON/);
  assert.match(log, /unsafe session id/);
  assert.ok(!existsSync(join(repo, '.git', 'evil.json')));
});

test('withLock: serializes, and breaks stale locks', () => {
  const dir = tmp();
  const lock = join(dir, 'x.lock');
  const order: string[] = [];
  withLock(lock, () => {
    order.push('outer');
    assert.throws(() => withLock(lock, () => order.push('inner'), { timeoutMs: 100 }), /timed out/);
  });
  assert.ok(!existsSync(lock));
  writeFileSync(lock, '12345');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  withLock(lock, () => order.push('after-stale'));
  assert.deepEqual(order, ['outer', 'after-stale']);
});
