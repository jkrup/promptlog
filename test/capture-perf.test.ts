// Capture performance on a realistic repo. Opt-in: PL_PERF=1 npm test (or node --test test/capture-perf.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredSession } from '../src/core/store.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session } from './capture-helpers.ts';

const enabled = !!process.env.PL_PERF;

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

test('perf: Stop capture on ~2,000 files and a 5 MB transcript', { skip: !enabled && 'set PL_PERF=1' }, () => {
  const repo = tempRepo();
  for (let d = 0; d < 40; d++) {
    mkdirSync(join(repo, 'src', `dir${d}`), { recursive: true });
    for (let f = 0; f < 50; f++) writeFileSync(join(repo, 'src', `dir${d}`, `file${f}.ts`), `export const v${d}_${f} = ${d * f};\n`.repeat(20));
  }
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'big');

  const s = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-perf-')));
  const filler = 'x'.repeat(2000) + ' password=hunter22 ';
  const addTurn = (i: number, kb: number) => {
    s.t.human(`turn ${i}: please change things`);
    for (let k = 0; k < kb / 4; k++) {
      const id = s.t.toolUse('Read', { file_path: `src/dir${k % 40}/file${k % 50}.ts` });
      s.t.toolResult(id, filler);
    }
    s.t.text(`done with turn ${i}`);
  };
  for (let i = 1; i <= 43; i++) addTurn(i, 84);
  s.flush();

  const [, coldPrompt] = time(() => s.hook('UserPromptSubmit'));
  addTurn(44, 84);
  const [, coldStop] = time(() => s.hook('Stop'));

  const warm: number[] = [];
  const warmPrompt: number[] = [];
  for (let i = 45; i <= 49; i++) {
    warmPrompt.push(time(() => s.hook('UserPromptSubmit'))[1]);
    addTurn(i, 84);
    writeFileSync(join(repo, 'src', 'dir1', `file${i % 50}.ts`), `changed in ${i}\n`);
    writeFileSync(join(repo, `new${i}.txt`), 'new\n');
    warm.push(time(() => s.hook('Stop'))[1]);
  }
  // End to end through bin/pl (process start + TS loading included).
  pl(repo, ['hook', 'UserPromptSubmit'], JSON.stringify({ session_id: s.id, transcript_path: s.path, cwd: repo }));
  addTurn(50, 84);
  s.flush();
  const [, cli] = time(() => pl(repo, ['hook', 'Stop'], JSON.stringify({ session_id: s.id, transcript_path: s.path, cwd: repo })));

  assert.equal(readStoredSession(repo, s.id)!.turns.length, 50);
  const size = statSync(s.path).size;
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const report = {
    files: Number(gitc(repo, 'ls-files').split('\n').length),
    transcriptMB: +(size / 1e6).toFixed(2),
    coldPromptMs: Math.round(coldPrompt),
    coldStopMs: Math.round(coldStop),
    warmPromptMedianMs: Math.round(med(warmPrompt)),
    warmStopMedianMs: Math.round(med(warm)),
    warmStopMaxMs: Math.round(Math.max(...warm)),
    cliStopMs: Math.round(cli),
  };
  console.log(JSON.stringify(report));
  assert.ok(report.warmStopMedianMs < 1000, `warm Stop took ${report.warmStopMedianMs}ms`);
});
