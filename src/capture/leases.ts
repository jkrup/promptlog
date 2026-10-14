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
// Agents on different machines share one table on Cloudflare instead (a Durable Object per repo, cloud/viewer), when
// the repo has `git config promptlog.leases <url>` and its key (macOS Keychain, else `git config promptlog.leasesKey`).
// Remote calls time out fast; when one fails, the local file is used for a minute and the failure goes to errors.log,
// so a network problem never blocks an agent. The table's rules are in lease-table.ts, shared with the Durable Object.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gitMaybe } from '../core/git.ts';
import { localDir } from '../core/store.ts';
import { claimIn, freshestFirst, prune, releaseIn, renewIn, type ClaimResult, type Holder, type Lease, type LeaseOp } from './lease-table.ts';
import { withLock } from './state.ts';

export type { Holder, Lease } from './lease-table.ts';

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

function leasePaths(root: string): { dir: string; file: string; lock: string } | null {
  const c = commonDir(root);
  if (!c) return null;
  const dir = join(c, 'promptlog');
  mkdirSync(dir, { recursive: true });
  return { dir, file: join(dir, 'leases.json'), lock: join(dir, 'leases.lock') };
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

/** Run `fn` on the local lease table (expired leases dropped), under the lock; saves what `fn` leaves. */
function update<T>(root: string, fn: (leases: Lease[], now: number) => T): T | null {
  const p = leasePaths(root);
  if (!p) return null;
  return withLock(p.lock, () => {
    const now = Date.now();
    const v = read(p.file);
    prune(v.leases, now, leaseTtlMs());
    const out = fn(v.leases, now);
    write(p.file, v);
    return out;
  }, { timeoutMs: 5_000 });
}

/** Current leases, freshest first. */
export function listLeases(root: string): Lease[] {
  const r = remote(root, { op: 'list' }, isLeaseList);
  if (r) return r.leases;
  const p = leasePaths(root);
  if (!p || !existsSync(p.file)) return [];
  const leases = read(p.file).leases;
  prune(leases, Date.now(), leaseTtlMs());
  return freshestFirst(leases);
}

/**
 * Claim `paths` for `holder`. Paths another live session holds are refused and returned; the rest are claimed (or
 * renewed). With `force`, take them anyway (the end of a turn: the change already happened, record it).
 */
export function claim(root: string, holder: Holder, paths: string[], opts: { force?: boolean } = {}): ClaimResult {
  const r = remote(root, { op: 'claim', holder, paths, ...(opts.force ? { force: true } : {}) }, isClaimResult);
  if (r) return r;
  return update(root, (leases, now) => claimIn(leases, holder, paths, now, opts)) ?? { refused: [], claimed: [] };
}

/** Keep a session's leases alive while it works, even on turns that touch nothing new. */
export function renew(root: string, sessionId: string): void {
  if (remote(root, { op: 'renew', sessionId }, hasCount('renewed'))) return;
  update(root, (leases, now) => renewIn(leases, sessionId, now));
}

/**
 * Release a session's leases (all, or just `paths`; anyone's when `sessionId` is null). Returns how many were released.
 * With a shared table, leases left in the local file (taken while it was unreachable) are released too.
 */
export function release(root: string, sessionId: string | null, paths?: string[]): number {
  const r = remote(root, { op: 'release', sessionId, ...(paths ? { paths } : {}) }, hasCount('released'));
  const file = leasePaths(root)?.file;
  if (r && !(file && existsSync(file))) return r.released;
  return (r?.released ?? 0) + (update(root, (leases) => releaseIn(leases, sessionId, paths)) ?? 0);
}

const isClaimResult = (v: unknown): v is ClaimResult => Array.isArray((v as ClaimResult).refused) && Array.isArray((v as ClaimResult).claimed);
const hasCount =
  <K extends string>(k: K) =>
  (v: unknown): v is Record<K, number> =>
    typeof (v as Record<string, unknown>)[k] === 'number';

// ---------------------------------------------------------------------------
// The shared table on Cloudflare (cloud/viewer: POST <url>/<op>, Bearer key)
// ---------------------------------------------------------------------------

/** Keychain account name the key is stored under (with the table's URL as server and path). */
const KEY_USER = 'promptlog-leases';
/** After a failed call, use the local table this long before trying the shared one again. */
const RETRY_AFTER_MS = 60_000;

const timeoutMs = () => {
  const n = Number(process.env.PL_LEASES_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
};

/** A tiny HTTP client in a child process, so the hook can wait for it synchronously. Reads {url,key,body,ms} on stdin. */
const HTTP_CHILD = `let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',async()=>{try{const r=JSON.parse(s);
const res=await fetch(r.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+r.key},body:JSON.stringify(r.body),signal:AbortSignal.timeout(r.ms)});
const t=await res.text();if(!res.ok){process.stderr.write('HTTP '+res.status+' '+t.slice(0,200));process.exit(2)}
process.stdout.write(t,()=>process.exit(0))}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(1)}})`;

/** The shared table's URL (…/__leases/<repo>) when this repo uses one. */
export function sharedLeasesUrl(root: string): string | null {
  if (process.env.PL_LEASES === 'local') return null;
  return gitMaybe(['config', '--get', 'promptlog.leases'], { cwd: root }) || null;
}

function sharedLeasesKey(root: string, url: string): string | null {
  return keychainKey(url) ?? (gitMaybe(['config', '--get', 'promptlog.leasesKey'], { cwd: root }) || null);
}

function credentialInput(url: string, password?: string): string {
  const u = new URL(url);
  return `protocol=${u.protocol.replace(':', '')}\nhost=${u.host}\npath=${u.pathname.replace(/^\//, '')}\nusername=${KEY_USER}\n${password ? `password=${password}\n` : ''}\n`;
}

function keychainKey(url: string): string | null {
  if (platform() !== 'darwin' || process.env.PL_LEASES_KEYCHAIN === 'off') return null;
  try {
    const r = spawnSync('git', ['credential-osxkeychain', 'get'], { input: credentialInput(url), encoding: 'utf8', timeout: 3000 });
    return /^password=(.+)$/m.exec(r.stdout ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Point this repo at a shared lease table and save its key: in the macOS Keychain, else in the repo's git config
 * (`promptlog.leasesKey`). Returns where the key went.
 */
export function useSharedLeases(root: string, url: string, key: string): 'keychain' | 'git config' {
  gitMaybe(['config', 'promptlog.leases', url], { cwd: root });
  if (platform() === 'darwin' && process.env.PL_LEASES_KEYCHAIN !== 'off') {
    spawnSync('git', ['credential-osxkeychain', 'erase'], { input: credentialInput(url), encoding: 'utf8' });
    const r = spawnSync('git', ['credential-osxkeychain', 'store'], { input: credentialInput(url, key), encoding: 'utf8' });
    if (r.status === 0 && keychainKey(url) === key) {
      gitMaybe(['config', '--unset', 'promptlog.leasesKey'], { cwd: root });
      return 'keychain';
    }
  }
  gitMaybe(['config', 'promptlog.leasesKey', key], { cwd: root });
  return 'git config';
}

/** One call to the shared table, synchronously, within the timeout. Never throws. */
function callShared<T>(root: string, url: string, op: LeaseOp, ok: (v: unknown) => v is T): { value: T } | { error: string } {
  const key = sharedLeasesKey(root, url);
  if (!key) return { error: 'no key (run `promptlog connect --leases <url> --leases-key <key>` again)' };
  const ms = timeoutMs();
  const input = JSON.stringify({ url: `${url.replace(/\/+$/, '')}/${op.op}`, key, body: op, ms: Math.max(100, ms - 300) });
  const res = spawnSync(process.execPath, ['-e', HTTP_CHILD], { input, encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL' });
  if (res.status !== 0) return { error: res.error ? res.error.message : (res.stderr || `exit ${res.status ?? res.signal}`).trim().slice(0, 300) };
  try {
    const v: unknown = JSON.parse(res.stdout);
    return ok(v) ? { value: v } : { error: `unexpected reply: ${res.stdout.slice(0, 200)}` };
  } catch {
    return { error: `reply is not JSON: ${res.stdout.slice(0, 200)}` };
  }
}

const isLeaseList = (v: unknown): v is { leases: Lease[] } => Array.isArray((v as { leases?: unknown }).leases);

/** Check the shared table works (for `promptlog connect`): its current leases, or what went wrong. */
export function checkSharedLeases(root: string): { leases: Lease[] } | { error: string } {
  const url = sharedLeasesUrl(root);
  if (!url) return { error: 'promptlog.leases is not set' };
  const r = callShared(root, url, { op: 'list' }, isLeaseList);
  return 'value' in r ? r.value : r;
}

/** Run `op` on the shared table. Null when there is none, or on any failure (logged), so the caller uses the local one. */
function remote<T>(root: string, op: LeaseOp, ok: (v: unknown) => v is T): T | null {
  const url = sharedLeasesUrl(root);
  if (!url) return null;
  const p = leasePaths(root);
  const down = p ? join(p.dir, 'leases-remote-down') : null;
  try {
    if (down && existsSync(down) && Date.now() - statSync(down).mtimeMs < RETRY_AFTER_MS) return null;
  } catch {
    // marker vanished: try the shared table
  }
  const r = callShared(root, url, op, ok);
  if ('value' in r) {
    if (down) rmSync(down, { force: true });
    return r.value;
  }
  logLeaseError(root, `shared lease table ${url}: ${op.op} failed (${r.error}); using the local table for ${RETRY_AFTER_MS / 1000} s`);
  try {
    if (down) writeFileSync(down, new Date().toISOString() + '\n');
  } catch {
    // nothing else we can do
  }
  return null;
}

function logLeaseError(root: string, msg: string): void {
  try {
    const file = join(localDir(root), 'errors.log');
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, file + '.1');
    appendFileSync(file, `${new Date().toISOString()} leases ${msg}\n`);
  } catch {
    // nothing else we can do
  }
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
