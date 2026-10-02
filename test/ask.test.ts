// Deterministic tests for src/ask (no network): materialize, resume transcript, asks ref, ask() with a fake runner, fork.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  ask,
  asksRef,
  buildResumeTranscript,
  dropDanglingToolUse,
  fork,
  listAskedSessions,
  listAsks,
  materialize,
  pickTurnState,
  readForkMarker,
  removeWorktree,
  rewritePaths,
  saveAsk,
  type ClaudeRunner,
  type StoredAsk,
} from '../src/ask/index.ts';
import { readStoredSession, sessionRef, transcriptUpTo } from '../src/core/store.ts';
import { parseEntry } from '../src/core/transcript.ts';
import type { TurnMeta } from '../src/core/types.ts';
import { cloneDemo, demoIds, ROOT } from './helpers.ts';

const { sessionA } = demoIds();
const repo = cloneDemo();
const cleanupDirs: string[] = [repo];
after(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const stored = readStoredSession(repo, sessionA)!;
const meta = (n: number) => stored.turns.find((t) => t.meta.index === n)!.meta;
const ORIGINAL_ROOT = parseEntry(stored.turns[0]!.transcript.find((l) => parseEntry(l)?.cwd)!)!.cwd!;

describe('materialize', () => {
  test('turn 1 and turn 2 check out different states, on top of HEAD at the end of the turn', () => {
    const headBefore = g(repo, 'rev-parse', 'HEAD');
    const m1 = materialize({ cwd: repo, sessionId: sessionA, turn: 1 });
    const m2 = materialize({ cwd: repo, sessionId: sessionA, turn: 2 });
    try {
      const s1 = readFileSync(join(m1.root, 'src/server.js'), 'utf8');
      const s2 = readFileSync(join(m2.root, 'src/server.js'), 'utf8');
      assert.match(s1, /let cache = null/);
      assert.doesNotMatch(s1, /searchParams|base/);
      assert.match(s2, /new Map\(\)/);
      assert.match(s2, /searchParams\.get\('base'\)/);

      assert.equal(m1.source, 'after');
      assert.equal(m1.tree, meta(1).stateAfter);
      assert.equal(g(m1.root, 'rev-parse', 'HEAD^{tree}'), meta(1).stateAfter);
      assert.equal(g(m1.root, 'rev-parse', 'HEAD^'), meta(1).headAfter);
      assert.match(g(m1.root, 'log', '-1', '--format=%B'), /Promptlog-Snapshot: e2741880-fe50-41e3-a98c-741901cf6ab1#1/);
      assert.equal(g(m1.root, 'status', '--porcelain'), '');

      const common = g(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      assert.ok(m1.root.startsWith(join(common, 'promptlog', 'worktrees') + '/'), m1.root);
      assert.equal(m1.gitDir, g(m1.root, 'rev-parse', '--absolute-git-dir'));
      assert.equal(m1.cwd, m1.root);
    } finally {
      m1.cleanup();
      m2.cleanup();
    }
    assert.ok(!existsSync(m1.root) && !existsSync(m2.root));
    assert.ok(!g(repo, 'worktree', 'list').includes(m1.root));
    // The user's checkout is untouched.
    assert.equal(g(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(g(repo, 'status', '--porcelain'), '');
  });

  test('uses the real commit when nothing was uncommitted (turn 3 committed)', () => {
    const m3 = materialize({ cwd: repo, sessionId: sessionA, turn: 3 });
    try {
      assert.equal(m3.commit, meta(3).headAfter);
      assert.equal(g(m3.root, 'rev-parse', 'HEAD'), meta(3).headAfter);
    } finally {
      m3.cleanup();
    }
  });

  test('synthetic snapshot commits are deterministic', () => {
    const a = materialize({ cwd: repo, sessionId: sessionA, turn: 2 });
    const b = materialize({ cwd: repo, sessionId: sessionA, turn: 2 });
    try {
      assert.notEqual(a.root, b.root);
      assert.equal(a.commit, b.commit);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('rejects unknown turns', () => {
    assert.throws(() => materialize({ cwd: repo, sessionId: sessionA, turn: 9 }), /has turns 1\.\.4; no turn 9/);
    assert.throws(() => materialize({ cwd: repo, sessionId: sessionA, turn: 0 }), /no turn 0/);
  });

  test('pickTurnState falls back: after -> next before -> headAfter', () => {
    const base = { schema: 1 as const, commits: [] };
    const turns: TurnMeta[] = [
      { ...base, index: 1, stateAfter: 'T1A', headAfter: 'C1' },
      { ...base, index: 2, headAfter: 'C2', headBefore: 'C1' },
      { ...base, index: 3, stateBefore: 'T3B', headAfter: 'C3' },
      { ...base, index: 4, headAfter: 'GONE' },
    ];
    const lookup = {
      hasTree: (s: string) => s.startsWith('T'),
      hasCommit: (s: string) => s.startsWith('C'),
      treeOf: (c: string) => `tree-of-${c}`,
    };
    assert.deepEqual(pickTurnState(turns, 1, lookup), { tree: 'T1A', source: 'after', parent: 'C1' });
    assert.deepEqual(pickTurnState(turns, 2, lookup), { tree: 'T3B', source: 'next-before', parent: 'C2' });
    assert.deepEqual(pickTurnState(turns, 3, lookup), { tree: 'tree-of-C3', source: 'head-after', parent: 'C3' });
    assert.equal(pickTurnState(turns, 4, lookup), null);
    assert.equal(pickTurnState(turns, 5, lookup), null);
    // A missing snapshot object is skipped, not trusted.
    const t: TurnMeta[] = [{ ...base, index: 1, stateAfter: 'XMISSING', headAfter: 'C1' }];
    assert.equal(pickTurnState(t, 1, lookup)?.source, 'head-after');
  });
});

describe('resume transcript', () => {
  const WT = '/work/wt-xyz';

  test('truncates at the turn and rewrites the author root everywhere', () => {
    const r = buildResumeTranscript(stored, 2, WT);
    assert.equal(r.originalRoot, ORIGINAL_ROOT);
    assert.equal(r.dropped, 0);
    const upTo = transcriptUpTo(stored, 2);
    assert.equal(r.lines.length, upTo.filter((l) => parseEntry(l)?.type !== 'queue-operation').length);
    assert.ok(upTo.some((l) => l.includes('Looks good. Commit this')), 'store files the next prompt\'s enqueue line under this turn');
    const text = r.lines.join('\n');
    assert.ok(!text.includes(ORIGINAL_ROOT), 'no author paths left');
    assert.ok(text.includes(`${WT}/src/server.js`), 'tool paths point at the worktree');
    assert.ok(text.includes('we run ~20 instances'), 'turn 2 prompt present');
    assert.ok(!text.includes('Looks good. Commit this'), 'turn 3 prompt absent');
    for (const l of r.lines) {
      const e = parseEntry(l);
      assert.ok(e, 'every line is still JSON');
      if (e.cwd) assert.equal(e.cwd, WT);
      if (e.sessionId) assert.equal(e.sessionId, sessionA, 'session id kept: --fork-session assigns the new one');
    }
  });

  test('rewritePaths only matches whole path prefixes and is replacement-safe', () => {
    const line = JSON.stringify({ cwd: '/repo', a: '/repo/src/x.ts', b: '/repo-old/y', c: 'cd /repo && ls', d: ['/repo'], n: 3 });
    const [out] = rewritePaths([line], '/repo', '/w/$&');
    assert.deepEqual(JSON.parse(out!), { cwd: '/w/$&', a: '/w/$&/src/x.ts', b: '/repo-old/y', c: 'cd /w/$& && ls', d: ['/w/$&'], n: 3 });
    assert.deepEqual(rewritePaths(['not json /repo'], '/repo', '/w'), ['not json /repo']);
  });

  test('drops a trailing tool_use that never got a result', () => {
    const lines = transcriptUpTo(stored, 1);
    // Cut right after turn 1's Edit tool_use: its tool_result is gone.
    const editIdx = lines.findIndex((l) => {
      const c = parseEntry(l)?.message?.content;
      return Array.isArray(c) && c.some((b: { type?: string; name?: string }) => b.type === 'tool_use' && b.name === 'Edit');
    });
    assert.ok(editIdx > 0);
    const cut = lines.slice(0, editIdx + 1);
    const res = dropDanglingToolUse(cut);
    assert.equal(res.dropped, 1);
    assert.deepEqual(res.lines, lines.slice(0, editIdx));
    // Complete turns are left alone.
    assert.equal(dropDanglingToolUse(lines).dropped, 0);
  });

  test('parallel tool calls: cuts from the first tool_use of the unfinished message', () => {
    const u = (o: object) => JSON.stringify(o);
    const lines = [
      u({ type: 'user', uuid: 'p', message: { role: 'user', content: 'do it' } }),
      u({ type: 'assistant', uuid: 'a0', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      u({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      u({ type: 'assistant', uuid: 'a2', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } }),
      u({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
      u({ type: 'last-prompt', leafUuid: 'r1' }),
    ];
    const res = dropDanglingToolUse(lines);
    assert.equal(res.dropped, 4);
    assert.deepEqual(res.lines, lines.slice(0, 2));
  });
});

describe('asks ref', () => {
  const mk = (turn: number, q: string, askedAt: string, id: string): StoredAsk => ({
    schema: 1,
    id,
    sessionId: sessionA,
    turn,
    question: q,
    answer: `answer to ${q}`,
    askedAt,
  });

  test('append-only, one file per ask, separate from the session ref', () => {
    const repo2 = cloneDemo();
    cleanupDirs.push(repo2);
    const sessionTip = g(repo2, 'rev-parse', sessionRef(sessionA));
    assert.deepEqual(listAsks(repo2, sessionA), []);

    const r1 = saveAsk(repo2, mk(2, 'second?', '2026-09-25T10:00:02.000Z', '20260925T100002Z-bbbbbb'));
    const r2 = saveAsk(repo2, mk(1, 'first?', '2026-09-25T10:00:01.000Z', '20260925T100001Z-aaaaaa'));
    assert.equal(r1.path, '20260925T100002Z-bbbbbb.json');
    assert.equal(g(repo2, 'rev-parse', `${r2.commit}^`), r1.commit, 'second commit extends the first');
    assert.equal(g(repo2, 'rev-parse', asksRef(sessionA)), r2.commit);
    assert.deepEqual(g(repo2, 'ls-tree', '--name-only', asksRef(sessionA)).split('\n'), ['20260925T100001Z-aaaaaa.json', '20260925T100002Z-bbbbbb.json']);
    assert.match(g(repo2, 'log', '-1', '--format=%s', asksRef(sessionA)), /^ask turn 1: first\?$/);

    const all = listAsks(repo2, sessionA);
    assert.deepEqual(all.map((a) => a.question), ['first?', 'second?'], 'sorted by askedAt');
    assert.deepEqual(listAsks(repo2, sessionA, { turn: 2 }).map((a) => a.id), ['20260925T100002Z-bbbbbb']);
    assert.deepEqual(listAskedSessions(repo2), [sessionA]);
    assert.equal(g(repo2, 'rev-parse', sessionRef(sessionA)), sessionTip, 'session ref untouched');

    // `promptlog asks` prints them.
    const out = execFileSync('node', ['--no-warnings', join(ROOT, 'src/cli/main.ts'), 'asks', sessionA.slice(0, 6)], { cwd: repo2, encoding: 'utf8' });
    assert.match(out, /── turn 1 · 2026-09-25 10:00[\s\S]*Q: first\?\nA: answer to first\?/);
  });
});

describe('ask() with a fake runner', () => {
  test('resumes a truncated, rewritten transcript in a read-only worktree, then persists and cleans up', async () => {
    const repo3 = cloneDemo();
    cleanupDirs.push(repo3);
    let seen: { cwd: string; args: string[]; transcript: string[]; server: string; prompt: string } | undefined;
    const runner: ClaudeRunner = async (o) => {
      const args = o.args ?? [];
      const path = args[args.indexOf('--resume') + 1]!;
      seen = {
        cwd: o.cwd,
        args,
        prompt: o.prompt,
        transcript: readFileSync(path, 'utf8').split('\n').filter(Boolean),
        server: readFileSync(join(o.cwd, 'src/server.js'), 'utf8'),
      };
      return { session_id: 'fork-123', result: '  No: it is a single cache.  ', total_cost_usd: 0.0123 };
    };
    const res = await ask({ cwd: repo3, sessionId: sessionA.slice(0, 8), turn: 1, question: 'Is the cache keyed by base?', model: 'haiku', runner, askedBy: 'Rita Reviewer <rita@example.com>' });

    assert.ok(seen);
    assert.match(seen.cwd, /promptlog\/worktrees\/e2741880-t1-/);
    assert.match(seen.server, /let cache = null/);
    assert.match(seen.prompt, /^\[Reviewer question about the state at turn 1\. [^\n]*\]\n\nIs the cache keyed by base\?$/);
    const a = seen.args;
    assert.equal(a[a.indexOf('--resume') + 1]!.startsWith('/'), true, 'absolute transcript path');
    assert.ok(a.includes('--fork-session'));
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');
    assert.match(a[a.indexOf('--allowedTools') + 1]!, /Bash\(git log:\*\).*Bash\(cat:\*\)/);
    assert.match(a[a.indexOf('--disallowedTools') + 1]!, /Edit,Write/);
    assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]!), { disableAllHooks: true });
    assert.match(a[a.indexOf('--append-system-prompt') + 1]!, /reviewer's question about the state at turn 1/);
    assert.ok(seen.transcript.length > 20 && seen.transcript.every((l) => parseEntry(l)?.type !== 'queue-operation'));
    assert.ok(seen.transcript.every((l) => !l.includes(ORIGINAL_ROOT)));
    assert.ok(!seen.transcript.join('\n').includes('we run ~20 instances'), 'turn 2 not visible at turn 1');

    assert.equal(res.answer, 'No: it is a single cache.');
    assert.equal(res.forkSessionId, 'fork-123');
    assert.equal(res.costUsd, 0.0123);
    assert.equal(res.model, 'haiku');
    assert.equal(res.sessionId, sessionA, 'prefix resolved');
    assert.equal(res.state?.source, 'after');
    assert.equal(res.worktree, undefined);
    assert.ok(!existsSync(seen.cwd), 'worktree removed');

    const saved = listAsks(repo3, sessionA);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.askedBy, 'Rita Reviewer <rita@example.com>');
    assert.equal(saved[0]!.answer, res.answer);
  });

  test('errors are not persisted and the worktree is still removed; keep leaves it', async () => {
    const repo4 = cloneDemo();
    cleanupDirs.push(repo4);
    let cwd = '';
    await assert.rejects(
      ask({ cwd: repo4, sessionId: sessionA, turn: 2, question: 'q', runner: async (o) => ((cwd = o.cwd), { session_id: 'x', result: 'boom', is_error: true }) }),
      /claude failed: boom/,
    );
    assert.ok(cwd && !existsSync(cwd));
    assert.deepEqual(listAsks(repo4, sessionA), []);

    const kept = await ask({ cwd: repo4, sessionId: sessionA, turn: 2, question: 'q', keep: true, save: false, runner: async () => ({ session_id: 'y', result: 'ok' }) });
    assert.ok(kept.worktree && existsSync(join(kept.worktree, 'src/server.js')));
    assert.ok(kept.transcriptPath && existsSync(kept.transcriptPath));
    assert.deepEqual(listAsks(repo4, sessionA), []);
    removeWorktree(repo4, kept.worktree);
    assert.ok(!existsSync(kept.worktree));
  });
});

describe('fork', () => {
  test('new branch + sibling worktree + resumable transcript + parent marker', () => {
    const repo5 = cloneDemo();
    cleanupDirs.push(repo5);
    // Repo-local promptlog hooks (untracked, not in the snapshot) should follow the fork.
    mkdirSync(join(repo5, '.claude'), { recursive: true });
    writeFileSync(join(repo5, '.claude', 'settings.local.json'), '{"hooks":{}}\n');

    const f = fork({ cwd: repo5, sessionId: sessionA.slice(0, 8), turn: 2, model: 'sonnet' });
    cleanupDirs.push(f.root);
    assert.equal(f.branch, 'promptlog/fork-e2741880-t2');
    assert.equal(f.root, `${repo5}-fork-e2741880-t2`);
    assert.ok(!f.root.includes('/.git/'), 'fork worktrees live outside .git (Claude Code gates edits under .git)');
    assert.equal(g(repo5, 'rev-parse', `refs/heads/${f.branch}`), f.commit);
    assert.equal(g(f.root, 'symbolic-ref', '--short', 'HEAD'), f.branch);
    assert.match(readFileSync(join(f.root, 'src/server.js'), 'utf8'), /new Map\(\)/);
    assert.ok(f.copiedLocalSettings && existsSync(join(f.root, '.claude', 'settings.local.json')));

    const marker = readForkMarker(f.root);
    assert.ok(marker);
    assert.deepEqual(marker.parent, { sessionId: sessionA, turn: 2 });
    assert.equal(marker.parentPromptUuid, meta(2).promptUuid);
    assert.equal(marker.branch, f.branch);
    assert.equal(marker.transcriptPath, f.transcriptPath);
    assert.equal(readForkMarker(repo5), null, 'main worktree has no marker');

    const t = readFileSync(f.transcriptPath, 'utf8');
    assert.ok(!t.includes(ORIGINAL_ROOT) && t.includes(`${f.root}/src/server.js`));
    assert.deepEqual(f.command, ['claude', '--resume', f.transcriptPath, '--fork-session', '--model', 'sonnet']);
    assert.equal(f.commandLine, `cd ${f.root} && claude --resume ${f.transcriptPath} --fork-session --model sonnet`);

    assert.throws(() => fork({ cwd: repo5, sessionId: sessionA, turn: 2 }), /branch promptlog\/fork-e2741880-t2 already exists/);

    // CLI prints the command on stdout.
    const out = execFileSync('node', ['--no-warnings', join(ROOT, 'src/cli/main.ts'), 'fork', sessionA.slice(0, 8), '--at', '1', '--branch', 'try-again'], { cwd: repo5, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const dir1 = `${repo5}-fork-e2741880-t1`;
    cleanupDirs.push(dir1);
    assert.match(out.trim(), new RegExp(`^cd ${dir1} && claude --resume \\S+/promptlog/fork-${sessionA}-t1\\.jsonl --fork-session$`));
    assert.equal(g(dir1, 'symbolic-ref', '--short', 'HEAD'), 'try-again');

    removeWorktree(repo5, f.root);
    removeWorktree(repo5, dir1);
    assert.equal(readForkMarker(repo5), null);
  });
});
