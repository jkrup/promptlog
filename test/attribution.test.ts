// Which turn wrote each changed line: snapshots first, then the code inside the turn's own tool calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attribute, lineKey } from '../src/core/attribution.ts';
import { gitBuf } from '../src/core/git.ts';
import { assembleReview } from '../src/core/review.ts';
import { normalize } from '../src/core/transcript.ts';
import type { Session } from '../src/core/types.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Session as CaptureSession, Transcript } from './capture-helpers.ts';

const asSession = (t: Transcript, id = t.sessionId): Session => ({
  meta: { schema: 1, sessionId: id, agent: 'claude-code', cwd: '', startedAt: '', updatedAt: '' },
  turns: normalize(t.lines).filter((x) => x.index > 0),
});

/** Credit of each changed line as "turn:via", or "-" when nothing wrote it. */
function credits(a: ReturnType<typeof attribute>): Record<string, string> {
  const out: Record<string, string> = {};
  a.files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) =>
      h.lines.forEach((l, li) => {
        if (l.type !== 'add' && l.type !== 'del') return;
        const c = a.credit.get(lineKey(fi, hi, li));
        out[`${l.type === 'add' ? '+' : '-'}${l.text.trim()}`] = c ? `${c.turn}:${c.via}` : '-';
      }),
    ),
  );
  return out;
}

function diffOf(repo: string, a: string, b: string): string {
  return gitBuf(['diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', a, b, '--'], { cwd: repo })!.toString();
}

test('lines go to the turn whose Edit or Bash script wrote them; hand edits to nobody', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'cache.js'), 'export const cache = new Map();\n');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();

  const t = new Transcript();
  t.human('add a TTL');
  t.toolResult(t.toolUse('Edit', { file_path: '/r/cache.js', old_string: 'export const cache = new Map();', new_string: 'export const cache = new Map();\nexport const TTL_MS = Number(process.env.TTL_MS) || 600000;' }), 'ok');
  t.human('add a getter, with a script');
  t.toolResult(
    t.toolUse('Bash', { command: "python3 - <<'EOF'\np='cache.js'; s=open(p).read()\ns += '''export function fresh(entry) {\n  return Date.now() - entry.at < TTL_MS;\n}\n'''\nopen(p,'w').write(s)\nEOF" }),
    '',
  );
  t.human('what did we do?');
  t.text('Added a TTL and fresh().');

  writeFileSync(
    join(repo, 'cache.js'),
    'export const cache = new Map();\nexport const TTL_MS = Number(process.env.TTL_MS) || 600000;\nexport function fresh(entry) {\n  return Date.now() - entry.at < TTL_MS;\n}\n// a note typed by hand afterwards\n',
  );
  gitc(repo, 'commit', '-qam', 'cache work');
  const a = attribute(repo, diffOf(repo, base, 'HEAD'), [asSession(t)]);
  assert.deepEqual(credits(a), {
    '+export const TTL_MS = Number(process.env.TTL_MS) || 600000;': '1:conversation',
    '+export function fresh(entry) {': '2:conversation',
    '+return Date.now() - entry.at < TTL_MS;': '2:conversation',
    '+}': '2:conversation', // too short to match alone; both neighbours in its block say turn 2
    '+// a note typed by hand afterwards': '-',
  });
  assert.equal(a.totals.lines, 5);
  assert.equal(a.totals.credited, 4);
  assert.deepEqual(
    [...a.turns.values()].map((x) => [x.turn, x.lines]),
    [
      [1, 1],
      [2, 3],
    ],
  );
});

test('a removed line goes to the turn that removed it, not the one that wrote it', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'a.js'), 'const legacyFallbackHost = "api.typesafe.ai";\nconst keep = 1;\n');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  const t = new Transcript();
  t.human('write the fallback'); // in an earlier session of the work, the line was written...
  t.toolResult(t.toolUse('Write', { file_path: '/r/a.js', content: 'const legacyFallbackHost = "api.typesafe.ai";\nconst keep = 1;\n' }), 'ok');
  t.human('drop the fallback');
  t.toolResult(t.toolUse('Edit', { file_path: '/r/a.js', old_string: 'const legacyFallbackHost = "api.typesafe.ai";\n', new_string: '' }), 'ok');
  writeFileSync(join(repo, 'a.js'), 'const keep = 1;\n');
  gitc(repo, 'commit', '-qam', 'drop');
  assert.deepEqual(credits(attribute(repo, diffOf(repo, base, 'HEAD'), [asSession(t)])), { '-const legacyFallbackHost = "api.typesafe.ai";': '2:conversation' });
});

test('an exact before/after record beats the conversation', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'x.js'), 'start\n');
  gitc(repo, 'add', '.');
  gitc(repo, 'commit', '-qm', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  const before = gitc(repo, 'rev-parse', 'HEAD^{tree}').trim();
  writeFileSync(join(repo, 'x.js'), 'start\nconst written = "by turn two, says the snapshot";\n');
  gitc(repo, 'commit', '-qam', 'work');
  const after = gitc(repo, 'rev-parse', 'HEAD^{tree}').trim();

  const t = new Transcript();
  t.human('one'); // mentions the line first...
  t.toolResult(t.toolUse('Bash', { command: 'echo \'const written = "by turn two, says the snapshot";\'' }), '');
  t.human('two'); // ...but turn 2's snapshots show it made the change
  t.text('done');
  const s = asSession(t);
  s.turns[1]!.meta = { schema: 1, index: 2, commits: [], stateBefore: before, stateAfter: after };
  assert.deepEqual(credits(attribute(repo, diffOf(repo, base, 'HEAD'), [s])), { '+const written = "by turn two, says the snapshot";': '2:snapshot' });
});

test('a PR picks up the turns that wrote its code, even when only a later turn committed', () => {
  const repo = tempRepo();
  gitc(repo, 'checkout', '-qb', 'feature');
  const s = new CaptureSession(repo, mkdtempSync(join(tmpdir(), 'pl-attr-')));
  s.t.human('say hello');
  s.t.text('sure');
  s.t.human('add the greeting module, no commit yet');
  s.t.toolResult(s.t.toolUse('Write', { file_path: join(repo, 'greet.js'), content: 'export const greeting = "hello from the work turn";\n' }), 'ok');
  writeFileSync(join(repo, 'greet.js'), 'export const greeting = "hello from the work turn";\n');
  s.t.human('thanks');
  s.t.text('np');
  s.t.human('commit it');
  gitc(repo, 'add', 'greet.js');
  gitc(repo, 'commit', '-qm', 'Add greeting');
  s.t.toolResult(s.t.toolUse('Bash', { command: 'git add greet.js && git commit -qm "Add greeting"' }), '');
  s.flush();
  assert.equal(pl(repo, ['import', s.path, '--session', s.id]).status, 0);

  const review = assembleReview(repo, 'main', 'feature');
  assert.equal(review.slices.length, 1);
  const slice = review.slices[0]!;
  assert.deepEqual(slice.workTurns, [2]);
  assert.equal(slice.fromTurn, 1);
  assert.equal(review.attribution!.totals.credited, 1);
});
