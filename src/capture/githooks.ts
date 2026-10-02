// Git hooks installed by `promptlog install`: commit trailers, and optionally pushing refs/promptlog/* on `git push`.
// Existing hooks are never overwritten: they're moved to `<name>.pre-promptlog` and our script chains to them,
// propagating their exit status where git honours it.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git } from '../core/git.ts';

export const HOOK_MARKER = '# promptlog: managed by `promptlog install`';
export const BACKUP_SUFFIX = '.pre-promptlog';
export const COMMIT_HOOKS = ['prepare-commit-msg', 'commit-msg', 'post-commit'] as const;
export type GitHookName = (typeof COMMIT_HOOKS)[number] | 'pre-push';

/** Active hooks directory: honours core.hooksPath and resolves to the common dir from a linked worktree. */
export function hooksDir(root: string): string {
  const p = git(['rev-parse', '--git-path', 'hooks'], { cwd: root });
  return isAbsolute(p) ? p : join(root, p);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookScript(name: GitHookName, plBin: string): string {
  const head = [
    '#!/bin/sh',
    HOOK_MARKER,
    `# A hook that was here before is kept as ${name}${BACKUP_SUFFIX} and still runs.`,
    `PL=${shq(plBin)}`,
    `ORIG="$(dirname "$0")/${name}${BACKUP_SUFFIX}"`,
  ];
  const pl = (args: string, io = '</dev/null >/dev/null 2>&1') => `if [ -x "$PL" ]; then "$PL" ${args} ${io} || :; fi`;
  const body: Record<GitHookName, string[]> = {
    // Theirs first (it may rewrite the message), then append our trailers so they stay in the trailer block.
    'prepare-commit-msg': ['if [ -x "$ORIG" ]; then "$ORIG" "$@" || exit $?; fi', pl('trailer "$@"')],
    // Drop our trailers if they're all that's left, so an empty message still aborts; then theirs decides.
    'commit-msg': [pl('trailer --commit-msg "$1"'), 'if [ -x "$ORIG" ]; then exec "$ORIG" "$@"; fi'],
    'post-commit': ['if [ -x "$ORIG" ]; then "$ORIG" "$@"; fi', pl('trailer --post-commit')],
    // Theirs gets stdin (the ref list) and can veto the push. Our own `git push` of the refs sets PROMPTLOG_PUSHING
    // and uses --no-verify, so this never recurses.
    'pre-push': ['if [ -x "$ORIG" ]; then "$ORIG" "$@" || exit $?; fi', `if [ -z "$PROMPTLOG_PUSHING" ]; then ${pl('push "$1" --from-hook', '</dev/null >&2')}; fi`],
  };
  return [...head, ...body[name], 'exit 0', ''].join('\n');
}

export interface InstallGitHooksResult {
  dir: string;
  installed: GitHookName[];
  /** Pre-existing hooks now chained (moved to `<name>.pre-promptlog`). */
  chained: GitHookName[];
}

/** Like existsSync, but true for a dangling symlink too (writing through one would create its target). */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isOurHook(path: string): boolean {
  try {
    // Prefix match, so hooks installed under the old `pl` name still count as ours.
    return readFileSync(path, 'utf8').includes('# promptlog: managed by');
  } catch {
    return false;
  }
}

export function installGitHooks(root: string, plBin: string, opts: { autoPush?: boolean } = {}): InstallGitHooksResult {
  const dir = hooksDir(root);
  mkdirSync(dir, { recursive: true });
  const names: GitHookName[] = [...COMMIT_HOOKS, ...(opts.autoPush ? (['pre-push'] as const) : [])];
  const res: InstallGitHooksResult = { dir, installed: [], chained: [] };
  for (const name of names) {
    const path = join(dir, name);
    if (lexists(path) && !(lstatSync(path).isFile() && isOurHook(path))) {
      const backup = path + BACKUP_SUFFIX;
      // Never lose a hook: an older backup (from a previous install) is set aside under a unique name.
      if (lexists(backup)) renameSync(backup, `${backup}.${Date.now()}`);
      renameSync(path, backup);
      res.chained.push(name);
    }
    writeFileSync(path, hookScript(name, plBin));
    chmodSync(path, 0o755);
    res.installed.push(name);
  }
  return res;
}
