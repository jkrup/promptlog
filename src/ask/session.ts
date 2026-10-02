// Small shared helpers for src/ask: session lookup, git locations, commit identity.
import { resolve } from 'node:path';
import { git, gitMaybe } from '../core/git.ts';
import { listSessions } from '../core/store.ts';

/** Resolve a full session id or a unique prefix. Throws with a helpful message otherwise. */
export function resolveSessionId(cwd: string, idOrPrefix: string): string {
  const all = listSessions(cwd).map((s) => s.sessionId);
  if (all.includes(idOrPrefix)) return idOrPrefix;
  const matches = all.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no captured session matches "${idOrPrefix}" (see \`promptlog ls\`)`);
  throw new Error(`"${idOrPrefix}" is ambiguous: ${matches.map((m) => m.slice(0, 12)).join(', ')}`);
}

/** Absolute git common dir (shared by all worktrees). */
export function commonGitDir(cwd: string): string {
  return resolve(cwd, git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }));
}

export function commitExists(cwd: string, sha: string | undefined): sha is string {
  return !!sha && gitMaybe(['cat-file', '-e', `${sha}^{commit}`], { cwd }) !== null;
}

export function treeExists(cwd: string, sha: string | undefined): sha is string {
  return !!sha && gitMaybe(['cat-file', '-e', `${sha}^{tree}`], { cwd }) !== null;
}

/** "Name <email>" of the local git identity, if configured. */
export function gitIdentity(cwd: string): string | undefined {
  const ident = gitMaybe(['var', 'GIT_AUTHOR_IDENT'], { cwd });
  const m = ident ? /^(.*<.*>) \d+ [+-]\d+$/.exec(ident) : null;
  return m ? m[1] : undefined;
}

/** Env for `git commit-tree`: the user's identity when configured, otherwise a promptlog placeholder. */
export function commitEnv(cwd: string): Record<string, string> {
  if (gitMaybe(['var', 'GIT_COMMITTER_IDENT'], { cwd }) && gitMaybe(['var', 'GIT_AUTHOR_IDENT'], { cwd })) return {};
  return PROMPTLOG_IDENT;
}

export const PROMPTLOG_IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: 'promptlog',
  GIT_AUTHOR_EMAIL: 'promptlog@localhost',
  GIT_COMMITTER_NAME: 'promptlog',
  GIT_COMMITTER_EMAIL: 'promptlog@localhost',
};
