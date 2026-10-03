// promptlog connect: hooks, past sessions and a first push in one command. Uses a local bare repo as the review
// remote (an existing `artifacts` remote means connect never calls Cloudflare).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitMaybe } from '../src/core/git.ts';
import { claudeProjectDir } from '../src/capture/backfill.ts';
import { tempRepo } from './helpers.ts';
import { gitc, pl, Transcript } from './capture-helpers.ts';

test('claudeProjectDir: the folder Claude Code uses for a working directory', () => {
  assert.equal(claudeProjectDir('/Users/maz/Projects/laya-pilot/.claude/worktrees/x', '/h'), '/h/.claude/projects/-Users-maz-Projects-laya-pilot--claude-worktrees-x');
});

test('connect: hooks installed, past sessions brought in and linked, everything pushed', () => {
  const repo = tempRepo();
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'pl-connect-remote-')));
  gitc(bare, 'init', '-q', '--bare');
  gitc(repo, 'remote', 'add', 'artifacts', bare);

  writeFileSync(join(repo, 'cache.js'), 'export const cache = new Map();\n');
  gitc(repo, 'add', 'cache.js');
  gitc(repo, 'commit', '-qm', 'Add an in-memory cache for rates');
  const sha = gitc(repo, 'rev-parse', 'HEAD').trim();

  // A session Claude Code saved for this folder before promptlog was set up.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl-connect-home-')));
  const t = new Transcript(undefined, repo);
  t.human('add a cache for rates and commit');
  t.toolResult(t.toolUse('Bash', { command: 'git add cache.js && git commit -q -m "Add an in-memory cache for rates" && git log --oneline -1' }), `${sha.slice(0, 7)} Add an in-memory cache for rates`);
  t.text('Done: an in-memory Map.');
  const dir = claudeProjectDir(repo, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.sessionId}.jsonl`), t.lines.join('\n') + '\n');

  const res = pl(repo, ['connect'], '', { HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Brought in 1 past Claude Code session\(s\): 1 turns, linked to 1 commit\(s\)/);
  assert.match(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'), /promptlog hook Stop/);

  const branch = gitc(repo, 'symbolic-ref', '--short', 'HEAD').trim();
  assert.equal(gitMaybe(['rev-parse', `refs/heads/${branch}`], { cwd: bare }), sha);
  const session = gitMaybe(['rev-parse', `refs/promptlog/sessions/${t.sessionId}`], { cwd: bare });
  assert.ok(session, 'the session reached the review remote');
  const meta = JSON.parse(gitc(bare, 'show', `${session}:turns/000001/meta.json`));
  assert.deepEqual(meta.commits, [sha]);
});
