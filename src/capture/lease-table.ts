// The lease table's rules as pure functions, shared by the local file store (leases.ts) and the Cloudflare Durable
// Object that lets agents on different machines coordinate (cloud/viewer/src/leases.ts). No Node imports: the Worker
// bundles this file.

export interface Lease {
  /** Repo-relative path. */
  path: string;
  sessionId: string;
  branch?: string;
  /** Worktree folder of the holder (absolute, on the holder's machine). */
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

export interface ClaimResult {
  refused: Lease[];
  claimed: string[];
}

export const DEFAULT_TTL_MS = 15 * 60_000;

/** One request against the table, as the remote API carries it. */
export type LeaseOp =
  | { op: 'list' }
  | { op: 'claim'; holder: Holder; paths: string[]; force?: boolean }
  | { op: 'renew'; sessionId: string }
  | { op: 'release'; sessionId: string | null; paths?: string[] };

export const isLive = (l: Lease, now: number, ttlMs: number) => now - Date.parse(l.renewedAt) < ttlMs;

/** Drop expired leases, in place. */
export function prune(leases: Lease[], now: number, ttlMs: number): void {
  const keep = leases.filter((l) => isLive(l, now, ttlMs));
  if (keep.length !== leases.length) leases.splice(0, leases.length, ...keep);
}

export const freshestFirst = (leases: Lease[]) => [...leases].sort((a, b) => (a.renewedAt < b.renewedAt ? 1 : a.renewedAt > b.renewedAt ? -1 : 0));

/**
 * Claim `paths` for `holder`, in place. Paths another session holds are refused and returned; the rest are claimed (or
 * renewed). With `force`, take them anyway (the end of a turn: the change already happened, record it).
 */
export function claimIn(leases: Lease[], holder: Holder, paths: string[], now: number, opts: { force?: boolean } = {}): ClaimResult {
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
}

/** Keep a session's leases alive, in place. Returns how many it holds. */
export function renewIn(leases: Lease[], sessionId: string, now: number): number {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const l of leases) {
    if (l.sessionId !== sessionId) continue;
    l.renewedAt = at;
    n++;
  }
  return n;
}

/** Release a session's leases (all, or just `paths`; any session's when `sessionId` is null), in place. */
export function releaseIn(leases: Lease[], sessionId: string | null, paths?: string[]): number {
  const before = leases.length;
  const keep = leases.filter((l) => !((sessionId === null || l.sessionId === sessionId) && (!paths || paths.includes(l.path))));
  leases.splice(0, leases.length, ...keep);
  return before - keep.length;
}

/** Apply one op to the table (expired leases are dropped first), in place. Returns the reply and whether to save. */
export function applyOp(leases: Lease[], op: LeaseOp, now: number, ttlMs = DEFAULT_TTL_MS): { reply: unknown; changed: boolean } {
  const before = leases.length;
  prune(leases, now, ttlMs);
  const pruned = leases.length !== before;
  switch (op.op) {
    case 'list':
      return { reply: { leases: freshestFirst(leases) }, changed: pruned };
    case 'claim': {
      const r = claimIn(leases, op.holder, op.paths, now, { force: op.force });
      return { reply: r, changed: pruned || r.claimed.length > 0 };
    }
    case 'renew': {
      const n = renewIn(leases, op.sessionId, now);
      return { reply: { renewed: n }, changed: pruned || n > 0 };
    }
    case 'release': {
      const n = releaseIn(leases, op.sessionId, op.paths);
      return { reply: { released: n }, changed: pruned || n > 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Checking requests from the network
// ---------------------------------------------------------------------------

/** A remote table refuses new claims past this size (the Durable Object keeps it as one stored value). */
export const MAX_LEASES = 2000;
const MAX_PATHS = 500;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const isSessionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const pathList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= MAX_PATHS && v.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 1024) ? (v as string[]) : null;

/** `body` as a LeaseOp named `op`, or an error message. Untrusted input: strings are bounded, ids checked. */
export function parseOp(op: string, body: unknown): LeaseOp | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  switch (op) {
    case 'list':
      return { op: 'list' };
    case 'claim': {
      const h = (b.holder && typeof b.holder === 'object' ? b.holder : {}) as Record<string, unknown>;
      if (!isSessionId(h.sessionId)) return 'holder.sessionId is missing or invalid';
      const paths = pathList(b.paths);
      if (!paths) return `paths must be a list of up to ${MAX_PATHS} file paths`;
      const holder: Holder = { sessionId: h.sessionId };
      for (const [k, max] of [['branch', 256], ['worktree', 1024], ['ask', 300]] as const) {
        const v = str(h[k], max);
        if (v) holder[k] = v;
      }
      return { op: 'claim', holder, paths, ...(b.force === true ? { force: true } : {}) };
    }
    case 'renew':
      return isSessionId(b.sessionId) ? { op: 'renew', sessionId: b.sessionId } : 'sessionId is missing or invalid';
    case 'release': {
      if (b.sessionId !== null && !isSessionId(b.sessionId)) return 'sessionId must be a session id or null';
      const paths = b.paths === undefined ? undefined : pathList(b.paths);
      if (paths === null) return 'paths must be a list of file paths';
      return { op: 'release', sessionId: b.sessionId as string | null, ...(paths ? { paths } : {}) };
    }
    default:
      return `unknown operation "${op}"`;
  }
}
