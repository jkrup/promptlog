// Sharing sessions: push/fetch refs/promptlog/* (refspecs from docs/format.md).
import { spawnSync } from 'node:child_process';
import { gitMaybe } from '../core/git.ts';

export const PUSH_REFSPEC = 'refs/promptlog/*:refs/promptlog/*';
export const FETCH_REFSPEC = '+refs/promptlog/*:refs/promptlog/*';

/** Upstream remote of the current branch, else `origin`, else the only remote. */
export function defaultRemote(root: string): string | null {
  const branch = gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root });
  const upstream = branch ? gitMaybe(['config', '--get', `branch.${branch}.remote`], { cwd: root }) : null;
  if (upstream && upstream !== '.') return upstream;
  const remotes = (gitMaybe(['remote'], { cwd: root }) ?? '').split('\n').filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0]! : null;
}

function localRefs(root: string): Map<string, string> {
  const out = gitMaybe(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/promptlog/'], { cwd: root }) ?? '';
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(root: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync('git', args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  return { ok: res.status === 0, stdout: res.stdout, stderr: res.stderr };
}

export interface PushResult extends RunResult {
  refs: number;
}

/**
 * Push every refs/promptlog/* ref. Never forced: session refs are append-only, so a rejection means someone else
 * pushed a different history for the same session and deserves a look. `noVerify` skips the remote's pre-push hooks
 * (used from our own pre-push hook).
 */
export function pushRefs(root: string, remote: string, opts: { noVerify?: boolean } = {}): PushResult {
  const refs = localRefs(root).size;
  if (refs === 0) return { ok: true, stdout: '', stderr: '', refs };
  const args = ['push', ...(opts.noVerify ? ['--no-verify'] : []), remote, PUSH_REFSPEC];
  return { ...runGit(root, args, { PROMPTLOG_PUSHING: '1' }), refs };
}

export interface FetchResult extends RunResult {
  /** Refs created or fast-forwarded by the fetch. */
  updated: string[];
  /** Local refs the fetch would have rewound or replaced; restored because they hold unpushed captures. */
  kept: { ref: string; reason: 'ahead' | 'diverged' }[];
}

const isAncestor = (root: string, a: string, b: string) => gitMaybe(['merge-base', '--is-ancestor', a, b], { cwd: root }) !== null;

/**
 * Fetch refs/promptlog/* with the forced refspec, then put back any local ref the fetch would have lost:
 * a session captured here and not pushed yet is ahead of the remote, and a forced update would rewind it.
 */
export function fetchRefs(root: string, remote: string): FetchResult {
  const before = localRefs(root);
  const res = runGit(root, ['fetch', remote, FETCH_REFSPEC]);
  const after = localRefs(root);
  const updated: string[] = [];
  const kept: FetchResult['kept'] = [];
  for (const [ref, sha] of after) {
    const old = before.get(ref);
    if (old === sha) continue;
    if (old && !isAncestor(root, old, sha)) {
      gitMaybe(['update-ref', ref, old, sha], { cwd: root });
      kept.push({ ref, reason: isAncestor(root, sha, old) ? 'ahead' : 'diverged' });
    } else {
      updated.push(ref);
    }
  }
  return { ...res, updated, kept };
}
