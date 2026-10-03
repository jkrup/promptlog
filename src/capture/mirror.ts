// Mirror: keep a review remote up to date without anyone running `git push`.
// The review remote is `git config promptlog.mirror <remote>` when set ("false" turns it off), else a remote named
// `artifacts`. After every commit, and at the end of a turn that committed, the current branch and refs/promptlog/*
// are pushed in the background. Only committed work travels: uncommitted changes never leave the machine.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentBranch, gitMaybe } from '../core/git.ts';
import { PUSH_REFSPEC } from './sync.ts';

export function mirrorRemote(root: string): string | null {
  const set = gitMaybe(['config', '--get', 'promptlog.mirror'], { cwd: root });
  if (set !== null) return set && set !== 'false' ? set : null;
  const remotes = (gitMaybe(['remote'], { cwd: root }) ?? '').split('\n');
  return remotes.includes('artifacts') ? 'artifacts' : null;
}

/**
 * `git push` arguments for one mirror run. The branch is forced (the mirror follows local history, rebases included);
 * session refs are append-only and never forced. --no-verify: the pre-push hook would only push the same refs again.
 */
export function mirrorPushArgs(root: string, remote: string): string[] {
  const branch = currentBranch(root);
  return ['push', '--no-verify', '--quiet', remote, ...(branch ? [`+refs/heads/${branch}:refs/heads/${branch}`] : []), PUSH_REFSPEC];
}

const MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/** Start `promptlog mirror --from-hook` detached, so commits and turns never wait on the network. */
export function startMirror(root: string): boolean {
  if (process.env.PROMPTLOG_PUSHING || !mirrorRemote(root)) return false;
  const child = spawn(process.execPath, ['--no-warnings', MAIN, 'mirror', '--from-hook'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PROMPTLOG_PUSHING: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  child.on('error', () => {});
  child.unref();
  return true;
}
