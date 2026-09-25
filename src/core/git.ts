// Thin synchronous wrappers over the git CLI. Hooks run once per turn, so sync + simple beats clever.
import { spawnSync } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly status: number | null;
  constructor(args: string[], stderr: string, status: number | null) {
    super(`git ${args.join(' ')} failed (${status}): ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
    this.status = status;
  }
}

export interface GitOpts {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Return null instead of throwing on non-zero exit. */
  allowFail?: boolean;
}

export function gitBuf(args: string[], opts: GitOpts): Buffer | null {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...opts.env },
    maxBuffer: 1024 * 1024 * 512,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    if (opts.allowFail) return null;
    throw new GitError(args, res.stderr.toString(), res.status);
  }
  return res.stdout;
}

/** Run git and return trimmed stdout. */
export function git(args: string[], opts: GitOpts): string {
  const out = gitBuf(args, opts);
  return out === null ? '' : out.toString('utf8').replace(/\n$/, '');
}

export function gitMaybe(args: string[], opts: Omit<GitOpts, 'allowFail'>): string | null {
  const out = gitBuf(args, { ...opts, allowFail: true });
  return out === null ? null : out.toString('utf8').replace(/\n$/, '');
}

export function repoRoot(cwd: string): string | null {
  return gitMaybe(['rev-parse', '--show-toplevel'], { cwd });
}

/** Per-worktree git dir (absolute). */
export function gitDir(cwd: string): string {
  return git(['rev-parse', '--absolute-git-dir'], { cwd });
}

export function headSha(cwd: string): string | undefined {
  return gitMaybe(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }) ?? undefined;
}

export function currentBranch(cwd: string): string | undefined {
  return gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd }) ?? undefined;
}

export function hashBlob(cwd: string, content: string | Buffer): string {
  return git(['hash-object', '-w', '--stdin'], { cwd, input: content });
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  name: string;
}

export function mktree(cwd: string, entries: TreeEntry[]): string {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join('\n') + (entries.length ? '\n' : '');
  return git(['mktree'], { cwd, input });
}

export function lsTree(cwd: string, treeish: string): TreeEntry[] {
  const out = gitMaybe(['ls-tree', '-z', treeish], { cwd });
  if (!out) return [];
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, sha] = line.slice(0, tab).split(' ') as [string, TreeEntry['type'], string];
      return { mode, type, sha, name: line.slice(tab + 1) };
    });
}

/**
 * Read many objects in one process: `git cat-file --batch`.
 * Returns content per requested rev (null when missing).
 */
export function catFileBatch(cwd: string, revs: string[]): (Buffer | null)[] {
  if (revs.length === 0) return [];
  const out = gitBuf(['cat-file', '--batch'], { cwd, input: revs.join('\n') + '\n' });
  if (!out) return revs.map(() => null);
  const results: (Buffer | null)[] = [];
  let pos = 0;
  for (let i = 0; i < revs.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      results.push(null);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    results.push(out.subarray(pos, pos + size));
    pos += size + 1; // trailing newline
  }
  return results;
}

export function readBlobText(cwd: string, rev: string): string | null {
  const [buf] = catFileBatch(cwd, [rev]);
  return buf ? buf.toString('utf8') : null;
}
