// promptlog mirror               push the current branch and refs/promptlog/* to the review remote now
// promptlog mirror --from-hook   the same, started in the background by hooks: quiet, logs failures, never fails
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../../core/git.ts';
import { logHookError } from '../../capture/hook.ts';
import { mirrorPushArgs, mirrorRemote } from '../../capture/mirror.ts';

export async function run(args: string[]): Promise<number> {
  const fromHook = args.includes('--from-hook');
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  if (!root) {
    if (!fromHook) process.stderr.write('not inside a git repository\n');
    return fromHook ? 0 : 1;
  }
  const remote = mirrorRemote(root);
  if (!remote) {
    if (!fromHook) process.stderr.write('no review remote: add a remote named `artifacts`, or `git config promptlog.mirror <remote>`\n');
    return fromHook ? 0 : 1;
  }
  const res = spawnSync('git', mirrorPushArgs(root, remote), {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PROMPTLOG_PUSHING: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  const ok = !res.error && res.status === 0;
  if (!ok) {
    const why = res.error ? res.error.message : (res.stderr || `exit ${res.status}`).trim();
    if (fromHook) logHookError(cwd, 'mirror', new Error(`push to ${remote} failed: ${why}`));
    else process.stderr.write(`promptlog: push to ${remote} failed: ${why}\n`);
    return fromHook ? 0 : 1;
  }
  if (!fromHook) process.stdout.write(`pushed to ${remote}\n`);
  return 0;
}
