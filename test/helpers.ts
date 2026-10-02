import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;

// Tests never read the developer's own keys (~/.config/promptlog/config.json), so they can't make real API calls.
// Live tests (PL_LIVE=1) keep the real config.
if (process.env.PL_LIVE !== '1') process.env.XDG_CONFIG_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pl-xdg-')));

export interface DemoIds {
  sessionA: string;
  sessionB: string;
  sessionC: string;
}

export function demoIds(): DemoIds {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures/demo.json'), 'utf8')) as DemoIds;
}

/** Clone fixtures/demo.bundle (with refs/promptlog/*) into a temp dir, checked out on feature/rates. */
export function cloneDemo(): string {
  // realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and git reports real paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pl-demo-')));
  const run = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  run(['clone', '-q', join(ROOT, 'fixtures/demo.bundle'), dir], tmpdir());
  run(['fetch', '-q', 'origin', '+refs/promptlog/*:refs/promptlog/*']);
  run(['checkout', '-q', 'feature/rates']);
  for (const b of ['main', 'feature/health']) run(['branch', '-q', '-f', b, `origin/${b}`]);
  return dir;
}

/** Empty temp git repo with one commit. */
export function tempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pl-repo-')));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'user.email', 'test@example.com']);
  run(['commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
