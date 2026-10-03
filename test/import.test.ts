// `promptlog import` on transcripts people already have: titles, git time limits, and speed on big files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, GitError } from '../src/core/git.ts';
import { readStoredSession } from '../src/core/store.ts';
import { titleText } from '../src/core/transcript.ts';
import { tempRepo } from './helpers.ts';
import { pl, Session } from './capture-helpers.ts';

test('titleText: the person\'s own words, not text they pasted', () => {
  assert.equal(titleText('<pasted_content id="de48">\nlong handoff\n</pasted_content id="de48">\nRead this and start'), 'Read this and start');
  assert.equal(titleText('Fix it\n<pasted_content id="a1">stack trace</pasted_content id="a1">'), 'Fix it');
  assert.equal(titleText('<pasted_content id="a1">\nOnly pasted text\n</pasted_content id="a1">'), 'Only pasted text');
  assert.equal(titleText('plain prompt'), 'plain prompt');
});

test('import: a session that starts with pasted text is named after the typed request', () => {
  const repo = tempRepo();
  const s = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-import-')));
  s.t.human('<pasted_content id="de48">\nHandoff from another chat\n</pasted_content id="de48">\nRead the handoff and commit the work');
  s.t.text('ok');
  s.flush();
  const res = pl(repo, ['import', s.path, '--session', s.id]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readStoredSession(repo, s.id)!.meta.title, 'Read the handoff and commit the work');
});

test('git: a call that runs past PL_GIT_TIMEOUT_MS fails and names the command', () => {
  const repo = tempRepo();
  const prev = process.env.PL_GIT_TIMEOUT_MS;
  process.env.PL_GIT_TIMEOUT_MS = '300';
  try {
    assert.throws(() => git(['-c', 'alias.nap=!sleep 3', 'nap'], { cwd: repo }), (e: unknown) => e instanceof GitError && /nap.*timed out/.test(e.message));
  } finally {
    if (prev === undefined) delete process.env.PL_GIT_TIMEOUT_MS;
    else process.env.PL_GIT_TIMEOUT_MS = prev;
  }
});

test('perf: import a ~30 MB transcript', { skip: !process.env.PL_PERF && 'set PL_PERF=1' }, () => {
  const repo = tempRepo();
  const s = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-import-perf-')));
  const big = 'y'.repeat(20_000);
  for (let i = 1; i <= 60; i++) {
    s.t.human(`turn ${i}: refactor the thing`);
    for (let k = 0; k < 25; k++) s.t.toolResult(s.t.toolUse('Read', { file_path: `src/f${k}.ts` }), big);
    s.t.text(`done ${i}`);
  }
  s.flush();
  const t0 = performance.now();
  const res = pl(repo, ['import', s.path, '--session', s.id]);
  const ms = performance.now() - t0;
  assert.equal(res.status, 0, res.stderr);
  console.log(JSON.stringify({ transcriptMB: +(statSync(s.path).size / 1e6).toFixed(1), importMs: Math.round(ms) }));
  assert.equal(readStoredSession(repo, s.id)!.turns.length, 60);
  assert.ok(ms < 15_000, `import took ${Math.round(ms)} ms`);
});
