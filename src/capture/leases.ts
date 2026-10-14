// Leases: many agents on one repo at once, without editing the same file at the same time.
//
// When an agent session is about to change a file (Claude Code's PreToolUse hook on Edit/Write/MultiEdit, and Bash
// commands that write files), it claims a lease on that file. If another live session holds it, the edit is refused and
// the agent is told who holds it: their branch, what they were asked, how long ago they were active. Leases are
// renewed by activity, expire after a quiet spell (default 15 min), and are released when the session ends or by hand.
// The end of each turn also claims every file the turn changed (snapshot diff), so edits the PreToolUse check could not
// see (unusual Bash) still count.
//
// The table lives in <git-common-dir>/promptlog/leases.json, shared by every worktree of the repo, behind a lock file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gitMaybe } from '../core/git.ts';
import { withLock } from './state.ts';

export interface Lease {
  /** Repo-relative path. */
  path: string;
  sessionId: string;
  branch?: string;
  /** Worktree folder of the holder, repo-relative to its common dir's parent is not meaningful: absolute. */
  worktree?: string;
  /** First line of what the holder's current turn was asked. */
  ask?: string;
  since: string;
  renewedAt: string;
}

export interface Holder {
  sessionId: string;
  branch?: string;
  worktree?: string;
  ask?: string;
}

interface LeaseFile {
  version: 1;
  leases: Lease[];
}

export function leaseTtlMs(): number {
  const n = Number(process.env.PL_LEASE_TTL_MIN);
  return (Number.isFinite(n) && n > 0 ? n : 15) * 60_000;
}

function commonDir(root: string): string | null {
  const d = gitMaybe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  return d ? resolve(root, d) : null;
}

function leasePaths(root: string): { file: string; lock: string } | null {
  const c = commonDir(root);
  if (!c) return null;
  const dir = join(c, 'promptlog');
  mkdirSync(dir, { recursive: true });
  return { file: join(dir, 'leases.json'), lock: join(dir, 'leases.lock') };
}

function read(file: string): LeaseFile {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as LeaseFile;
    return v && Array.isArray(v.leases) ? v : { version: 1, leases: [] };
  } catch {
    return { version: 1, leases: [] };
  }
}

function write(file: string, v: LeaseFile): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, file);
}

const live = (l: Lease, now: number) => now - Date.parse(l.renewedAt) < leaseTtlMs();

/** Run `fn` on the lease table (expired leases dropped), under the lock; saves what `fn` leaves. */
function update<T>(root: string, fn: (leases: Lease[], now: number) => T): T | null {
  const p = leasePaths(root);
  if (!p) return null;
  return withLock(p.lock, () => {
    const now = Date.now();
    const v = read(p.file);
    v.leases = v.leases.filter((l) => live(l, now));
    const out = fn(v.leases, now);
    write(p.file, v);
    return out;
  }, { timeoutMs: 5_000 });
}

/** Current leases, freshest first. */
export function listLeases(root: string): Lease[] {
  const p = leasePaths(root);
  if (!p || !existsSync(p.file)) return [];
  const now = Date.now();
  return read(p.file)
    .leases.filter((l) => live(l, now))
    .sort((a, b) => (a.renewedAt < b.renewedAt ? 1 : -1));
}

/**
 * Claim `paths` for `holder`. Paths another live session holds are refused and returned; the rest are claimed (or
 * renewed). With `force`, take them anyway (the end of a turn: the change already happened, record it).
 */
export function claim(root: string, holder: Holder, paths: string[], opts: { force?: boolean } = {}): { refused: Lease[]; claimed: string[] } {
  const res = update(root, (leases, now) => {
    const at = new Date(now).toISOString();
    const refused: Lease[] = [];
    const claimed: string[] = [];
    for (const path of [...new Set(paths)]) {
      const other = leases.find((l) => l.path === path && l.sessionId !== holder.sessionId);
      if (other && !opts.force) {
        refused.push(other);
        continue;
      }
      const mine = leases.find((l) => l.path === path && l.sessionId === holder.sessionId);
      if (mine) Object.assign(mine, { renewedAt: at, branch: holder.branch, worktree: holder.worktree, ...(holder.ask ? { ask: holder.ask } : {}) });
      else leases.push({ path, sessionId: holder.sessionId, branch: holder.branch, worktree: holder.worktree, ask: holder.ask, since: at, renewedAt: at });
      claimed.push(path);
    }
    return { refused, claimed };
  });
  return res ?? { refused: [], claimed: [] };
}

/** Keep a session's leases alive while it works, even on turns that touch nothing new. */
export function renew(root: string, sessionId: string): void {
  update(root, (leases, now) => {
    const at = new Date(now).toISOString();
    for (const l of leases) if (l.sessionId === sessionId) l.renewedAt = at;
  });
}

/** Release a session's leases (all, or just `paths`). Returns how many were released. */
export function release(root: string, sessionId: string | null, paths?: string[]): number {
  return (
    update(root, (leases) => {
      const before = leases.length;
      const keep = leases.filter((l) => !((sessionId === null || l.sessionId === sessionId) && (!paths || paths.includes(l.path))));
      leases.splice(0, leases.length, ...keep);
      return before - keep.length;
    }) ?? 0
  );
}

/** A path from a tool call, made repo-relative; null when it's outside the repo. */
export function repoPath(root: string, cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

/**
 * Files a Bash command is about to write, best effort: redirections (`> f`, `>> f`, `tee f`), `sed -i`/`perl -pi`
 * targets, `cp`/`mv` destinations, and Python/Node one-liners that open a file for writing (including `p='f'; open(p,'w')`).
 */
export function bashWriteTargets(command: string): string[] {
  const out = new Set<string>();
  const clean = (s: string) => s.replace(/^['"]|['"]$/g, '');
  const skip = (s: string) => !s || s.startsWith('/dev/') || s.startsWith('&') || s.startsWith('$') || s.includes('*');
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:\d?>>?|tee(?:\s+-a)?)\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) {
    const f = clean(m[1]!);
    if (!skip(f)) out.add(f);
  }
  for (const m of command.matchAll(/\b(?:sed\s+-i(?:\s*''|\s+\S*)?|perl\s+-p?i\S*)\s+((?:'[^']*'|"[^"]*"|-e\s+\S+|\S+)\s+)+?([^\s;&|<>]+)(?=\s*(?:$|[;&|]))/gm)) {
    const f = clean(m[2]!);
    if (!skip(f)) out.add(f);
  }
  for (const m of command.matchAll(/\b(?:cp|mv)\s+(?:-\w+\s+)*\S+\s+([^\s;&|<>]+)/g)) {
    const f = clean(m[1]!);
    if (!skip(f)) out.add(f);
  }
  const vars = new Map<string, string>();
  for (const m of command.matchAll(/\b(\w+)\s*=\s*(?:Path\()?['"]([^'"\n]+)['"]/g)) vars.set(m[1]!, m[2]!);
  for (const m of command.matchAll(/\bopen\(\s*(?:(['"])([^'"\n]+)\1|(\w+))\s*,\s*['"][wa]/g)) {
    const f = m[2] ?? vars.get(m[3]!);
    if (f && !skip(f)) out.add(f);
  }
  for (const m of command.matchAll(/(?:(\w+)|Path\(\s*['"]([^'"\n]+)['"]\s*\))\.write_(?:text|bytes)\(/g)) {
    const f = m[2] ?? vars.get(m[1] ?? '');
    if (f && !skip(f)) out.add(f);
  }
  for (const m of command.matchAll(/\bwriteFileSync\(\s*(?:(['"])([^'"\n]+)\1|(\w+))/g)) {
    const f = m[2] ?? vars.get(m[3]!);
    if (f && !skip(f)) out.add(f);
  }
  return [...out];
}

/** The repo files a tool call is about to change. */
export function toolTargets(root: string, cwd: string, tool: string, input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const raw: string[] = [];
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') raw.push(String(input.file_path ?? ''));
  else if (tool === 'NotebookEdit') raw.push(String(input.notebook_path ?? ''));
  else if (tool === 'Bash' && typeof input.command === 'string') raw.push(...bashWriteTargets(input.command));
  return raw.filter(Boolean).map((p) => repoPath(root, cwd, p)).filter((p): p is string => !!p);
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : `${m} min ago`;
};

/** What the refused agent reads: who holds the file and what they're doing, and its options. */
export function refusalMessage(refused: Lease[]): string {
  const lines = refused.map((l) => {
    const who = [l.branch ? `on branch ${l.branch}` : '', l.worktree ? `in ${l.worktree}` : ''].filter(Boolean).join(' ');
    return `- ${l.path}: held by another agent session (${l.sessionId.slice(0, 8)}) ${who}, active ${ago(l.renewedAt)}${l.ask ? `, working on: "${l.ask}"` : ''}`;
  });
  return [
    'promptlog lease: another agent is working on this file right now, so this edit was not made.',
    ...lines,
    'Work on something else first, or coordinate with that session (for example, send it a message). Leases end when that session ends or after 15 minutes without activity. A person can free it with `promptlog leases release <path>`.',
  ].join('\n');
}
