// The lease table's rules as pure functions, shared by the local file store (leases.ts) and the Cloudflare Durable
// Object that lets agents on different machines coordinate (cloud/viewer/src/leases.ts). No Node imports: the Worker
// bundles this file.
//
// A lease covers a whole file, or one block of it (a function, class, method, const...; see blocks.ts) when the edit's
// location is known. Two agents in different blocks of one file both proceed. The same block, or a whole file another
// agent holds, is refused. In between (blocks next to each other, or the same block left quiet for a while) is a gray
// zone: the table returns those cases, Clef judges them (lease-judge.ts), and the claim runs again with the verdicts.
import { blockCode, describeBlock, outline, relocate, type Block } from './blocks.ts';

export type { Block } from './blocks.ts';

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
  /** The block held, with its lines as the holder's file had them. Absent: the whole file. */
  block?: Block;
  /** When the holder last edited this block (renewals don't count). */
  touchedAt?: string;
}

export interface Holder {
  sessionId: string;
  branch?: string;
  worktree?: string;
  ask?: string;
}

/** One block an edit is about to change. */
export interface BlockClaim {
  path: string;
  block: Block;
  /** The edit itself (clipped), for Clef. */
  change?: { old: string; new: string };
}

export interface ClaimRequest {
  /** Whole files (Write, NotebookEdit, Bash writes, the end of a turn). */
  paths: string[];
  /** Blocks (Edit, MultiEdit). */
  blocks?: BlockClaim[];
  /** The claimant's current text of the files in `blocks`: other agents' blocks are found again in it. */
  texts?: Record<string, string>;
}

/** A verdict on a gray-zone case, kept in the table's log. */
export interface Decision {
  at: string;
  path: string;
  /** Blocks next to each other, or the same block, held by a session that has been quiet for a while. */
  why: 'near' | 'stale';
  /** The agent that wanted to edit, and its block. */
  asker: { sessionId: string; block: string; ask?: string };
  /** The agent already working there, and its block. */
  holder: { sessionId: string; block: string; ask?: string };
  question: string;
  /** Clef's answer; absent when there was none (no model set up, too slow, an error: see `note`). */
  choice?: 'independent' | 'conflicting' | 'unsure';
  probabilities?: Record<string, number>;
  model?: string;
  note?: string;
  outcome: 'allowed' | 'refused';
}

/** A gray-zone case waiting for a verdict. */
export interface GrayCase {
  key: string;
  why: 'near' | 'stale';
  path: string;
  asker: Holder;
  wanted: BlockClaim;
  /** The other session's lease, its block found again in the claimant's text. */
  held: Lease;
  /** Minutes since the holder last edited its block. */
  quietMin: number;
  /** Both blocks' code in the claimant's file, clipped (when it sent the text). */
  wantedCode?: string;
  heldCode?: string;
}

/** A refused lease: the other session's, with the block the claimant wanted and the verdict, if Clef was asked. */
export type Refusal = Lease & { wanted?: Block; decision?: Decision };

/** A gray-zone edit that goes ahead: the agent is told who is working next to it. */
export interface HeadsUp {
  lease: Lease;
  wanted: Block;
  decision: Decision;
}

export interface ClaimResult {
  refused: Refusal[];
  claimed: string[];
  headsUp?: HeadsUp[];
  /** Cases that need a verdict before the claim can be decided (nothing was claimed for their files). */
  gray?: GrayCase[];
}

export interface Table {
  leases: Lease[];
  decisions: Decision[];
}

export const DEFAULT_TTL_MS = 15 * 60_000;
/** A block whose holder hasn't edited it for this long is a gray zone, not a refusal. */
export const STALE_MS = 5 * 60_000;
/** Blocks this many lines apart (or closer) are neighbours: a gray zone. */
export const NEAR_LINES = 3;
/** Clef must say "independent" with at least this probability for a gray-zone edit to go ahead. */
export const ALLOW_AT = 0.7;
export const MAX_DECISIONS = 50;
/** A verdict on the same two blocks is reused this long: allowed ones while the leases live, refusals briefly. */
const REUSE_ALLOWED_MS = DEFAULT_TTL_MS;
const REUSE_REFUSED_MS = 2 * 60_000;

/** One request against the table, as the remote API carries it. */
export type LeaseOp =
  | { op: 'list' }
  | ({ op: 'claim'; holder: Holder; force?: boolean; keepBlocks?: boolean } & ClaimRequest)
  | { op: 'renew'; sessionId: string }
  | { op: 'release'; sessionId: string | null; paths?: string[] };

export const isLive = (l: Lease, now: number, ttlMs: number) => now - Date.parse(l.renewedAt) < ttlMs;

/** Drop expired leases, in place. */
export function prune(leases: Lease[], now: number, ttlMs: number): void {
  const keep = leases.filter((l) => isLive(l, now, ttlMs));
  if (keep.length !== leases.length) leases.splice(0, leases.length, ...keep);
}

export const freshestFirst = (leases: Lease[]) => [...leases].sort((a, b) => (a.renewedAt < b.renewedAt ? 1 : a.renewedAt > b.renewedAt ? -1 : 0));

const overlaps = (a: Block, b: Block) => a.start <= b.end && b.start <= a.end;
const gap = (a: Block, b: Block) => (a.start > b.end ? a.start - b.end - 1 : b.start - a.end - 1);

/** The same two blocks of the same two sessions, whichever asks. */
const pairKey = (path: string, a: string, ab: string, b: string, bb: string) => [path, ...[`${a}:${ab}`, `${b}:${bb}`].sort()].join('\n');
export const caseKey = (path: string, a: string, ab: Block, b: string, bb: Block) => pairKey(path, a, describeBlock(ab), b, describeBlock(bb));
const decisionKey = (d: Decision) => pairKey(d.path, d.asker.sessionId, d.asker.block, d.holder.sessionId, d.holder.block);

/** The question Clef answers, in plain words (also what the log shows). */
export function questionFor(c: Pick<GrayCase, 'why' | 'path' | 'wanted' | 'held' | 'quietMin'>): string {
  const mine = describeBlock(c.wanted.block);
  const theirs = describeBlock(c.held.block!);
  return c.why === 'near'
    ? `Can one agent change ${mine} while another works on ${theirs} next to it in ${c.path}, without stepping on each other?`
    : `Can one agent change ${mine} in ${c.path}, which another agent edited ${c.quietMin} min ago and has left since, without stepping on its work?`;
}

/** The decision for a case: Clef's verdict (allowed when "independent" ≥ ALLOW_AT), or the safe default without one. */
export function decisionFor(c: GrayCase, now: number, v: { choice: string; probabilities: Record<string, number>; model?: string } | null, note?: string): Decision {
  const choice = v && ['independent', 'conflicting', 'unsure'].includes(v.choice) ? (v.choice as Decision['choice']) : undefined;
  const allowed = choice === 'independent' && (v!.probabilities.independent ?? 0) >= ALLOW_AT;
  return {
    at: new Date(now).toISOString(),
    path: c.path,
    why: c.why,
    asker: { sessionId: c.asker.sessionId, block: describeBlock(c.wanted.block), ...(c.asker.ask ? { ask: c.asker.ask } : {}) },
    holder: { sessionId: c.held.sessionId, block: describeBlock(c.held.block!), ...(c.held.ask ? { ask: c.held.ask } : {}) },
    question: questionFor(c),
    ...(choice ? { choice, probabilities: v!.probabilities } : {}),
    ...(v?.model ? { model: v.model } : {}),
    ...(note ? { note } : !choice ? { note: 'no usable answer' } : {}),
    outcome: allowed ? 'allowed' : 'refused',
  };
}

const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`;
/** Who judged: Clef, unless another decision model answered. */
export const judgeName = (d: Decision) => (!d.model || /clef/i.test(d.model) ? 'Clef' : d.model);

/** A decision in plain words, e.g. "Clef: getRates() and formatRates() are independent (84%) → both agents kept working". */
export function describeDecision(d: Decision): string {
  const pair = d.asker.block === d.holder.block ? `two changes to ${d.asker.block}` : `${d.holder.block} and ${d.asker.block}`;
  if (!d.choice) return `No verdict on ${pair} (${d.note ?? 'no answer'}) → the second agent waited, to be safe`;
  const p = d.probabilities ?? {};
  if (d.outcome === 'allowed') return `${judgeName(d)}: ${pair} are independent (${pct(p.independent)}) → both agents kept working`;
  if (d.choice === 'conflicting') return `${judgeName(d)}: ${pair} conflict (${pct(p.conflicting)}) → the second agent waited`;
  const odds = d.choice === 'independent' ? `independent ${pct(p.independent)}, under ${pct(ALLOW_AT)}` : `${d.choice} ${pct(p[d.choice])}, independent ${pct(p.independent)}`;
  return `${judgeName(d)}: not sure ${pair} are independent (${odds}) → the second agent waited, to be safe`;
}

/** Add a decision to the log (the last MAX_DECISIONS). A repeat of the last one for the same blocks just updates it. */
export function logDecision(t: Table, d: Decision): void {
  const key = decisionKey(d);
  const prev = t.decisions.findLast((x) => decisionKey(x) === key);
  if (prev && prev.outcome === d.outcome && prev.choice === d.choice && Date.parse(d.at) - Date.parse(prev.at) < REUSE_REFUSED_MS) {
    Object.assign(prev, d);
    return;
  }
  t.decisions.push(d);
  if (t.decisions.length > MAX_DECISIONS) t.decisions.splice(0, t.decisions.length - MAX_DECISIONS);
}

/** A recent real verdict on the same two blocks. */
function reusable(t: Table, key: string, now: number): Decision | undefined {
  const d = t.decisions.findLast((x) => decisionKey(x) === key);
  if (!d?.choice) return undefined;
  return now - Date.parse(d.at) < (d.outcome === 'allowed' ? REUSE_ALLOWED_MS : REUSE_REFUSED_MS) ? d : undefined;
}

export interface ClaimOpts {
  /** Take whole files even if others hold them (the end of a turn: the change already happened, record it). */
  force?: boolean;
  /** With `force`: a file this session already holds blocks of is renewed, not taken whole. */
  keepBlocks?: boolean;
  /** Verdicts for gray-zone cases, by case key (they are logged as they are applied). */
  verdicts?: Record<string, Decision>;
  /** Gray-zone cases without a verdict are refused (the safe default) instead of returned. */
  final?: boolean;
  staleMs?: number;
}

/**
 * Claim whole files and blocks for `holder`, in place. Whole files another session holds any part of are refused; so
 * are blocks that overlap another session's block (or a file it holds whole). Neighbouring blocks, and blocks whose
 * holder has been quiet, are gray: decided by `opts.verdicts` (or a recent verdict on the same blocks), else returned
 * in `gray` without claiming anything in that file.
 */
export function claimIn(t: Table, holder: Holder, req: ClaimRequest, now: number, opts: ClaimOpts = {}): ClaimResult {
  const at = new Date(now).toISOString();
  const refused: Refusal[] = [];
  const claimed: string[] = [];
  const headsUp: HeadsUp[] = [];
  const gray: GrayCase[] = [];
  const staleMs = opts.staleMs ?? STALE_MS;
  const others = (path: string) => t.leases.filter((l) => l.path === path && l.sessionId !== holder.sessionId);
  const mine = (path: string) => t.leases.filter((l) => l.path === path && l.sessionId === holder.sessionId);
  const stamp = (l: Lease) => Object.assign(l, { renewedAt: at, branch: holder.branch, worktree: holder.worktree, ...(holder.ask ? { ask: holder.ask } : {}) });

  for (const path of [...new Set(req.paths)]) {
    const own = mine(path);
    if (opts.force && opts.keepBlocks && own.length) {
      own.forEach(stamp);
      claimed.push(path);
      continue;
    }
    const theirs = others(path);
    if (theirs.length && !opts.force) {
      refused.push(...theirs);
      continue;
    }
    // Holding the whole file replaces this session's blocks in it.
    const since = own.map((l) => l.since).sort()[0] ?? at;
    t.leases.splice(0, t.leases.length, ...t.leases.filter((l) => !own.includes(l)));
    t.leases.push(stamp({ path, sessionId: holder.sessionId, since, renewedAt: at }));
    claimed.push(path);
  }

  const byPath = new Map<string, BlockClaim[]>();
  for (const b of req.blocks ?? []) if (!claimed.includes(b.path)) byPath.set(b.path, [...(byPath.get(b.path) ?? []), b]);
  for (const [path, wants] of byPath) {
    const text = req.texts?.[path];
    const out = text === undefined ? null : outline(path, text);
    const here = (b: Block) => (text === undefined ? b : relocate(b, path, text, out));
    const theirs = others(path).map((l) => (l.block ? { ...l, block: here(l.block) } : l));
    const no: Refusal[] = [];
    const ok: HeadsUp[] = [];
    const wait: GrayCase[] = [];
    const seen = new Set<string>();
    for (const w of wants) {
      for (const l of theirs) {
        if (!l.block) {
          no.push({ ...l, wanted: w.block });
          continue;
        }
        const same = overlaps(w.block, l.block);
        if (!same && gap(w.block, l.block) > NEAR_LINES) continue;
        const key = caseKey(path, holder.sessionId, w.block, l.sessionId, l.block);
        if (seen.has(key)) continue;
        seen.add(key);
        const quietMs = now - Date.parse(l.touchedAt ?? l.since);
        const given = opts.verdicts?.[key];
        const known = given ?? reusable(t, key, now);
        if (same && quietMs < staleMs && known?.outcome !== 'allowed') {
          no.push({ ...l, wanted: w.block });
          continue;
        }
        const c: GrayCase = {
          key,
          why: same ? 'stale' : 'near',
          path,
          asker: holder,
          wanted: w,
          held: l,
          quietMin: Math.round(quietMs / 60_000),
          ...(text !== undefined ? { wantedCode: blockCode(text, w.block), heldCode: blockCode(text, l.block) } : {}),
        };
        const d = known ?? (opts.final ? decisionFor(c, now, null, 'no verdict') : undefined);
        if (!d) {
          wait.push(c);
          continue;
        }
        if (d !== known || given) logDecision(t, Object.assign(d, { at }));
        if (d.outcome === 'allowed') ok.push({ lease: l, wanted: w.block, decision: d });
        else no.push({ ...l, wanted: w.block, decision: d });
      }
    }
    if (no.length) {
      refused.push(...no);
      continue;
    }
    if (wait.length) {
      gray.push(...wait);
      continue;
    }
    for (const w of wants) {
      const own = mine(path);
      const whole = own.find((l) => !l.block);
      if (whole) {
        stamp(whole);
        continue;
      }
      const same = own.find((l) => overlaps(here(l.block!), w.block));
      if (same) stamp(Object.assign(same, { block: w.block, touchedAt: at }));
      else t.leases.push(stamp({ path, sessionId: holder.sessionId, since: at, renewedAt: at, block: w.block, touchedAt: at }));
    }
    headsUp.push(...ok);
    claimed.push(path);
  }
  return { refused, claimed, ...(headsUp.length ? { headsUp } : {}), ...(gray.length ? { gray } : {}) };
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

/**
 * Apply one op to the table (expired leases are dropped first), in place. Returns the reply and whether to save.
 * Gray-zone claims get the safe default here; lease-judge.ts `claimJudged` asks Clef first.
 */
export function applyOp(t: Table, op: LeaseOp, now: number, ttlMs = DEFAULT_TTL_MS, claimOpts: ClaimOpts = {}): { reply: unknown; changed: boolean } {
  const before = t.leases.length;
  prune(t.leases, now, ttlMs);
  const pruned = t.leases.length !== before;
  switch (op.op) {
    case 'list':
      return { reply: { leases: freshestFirst(t.leases), decisions: [...t.decisions].reverse() }, changed: pruned };
    case 'claim': {
      const logged = t.decisions.length;
      const r = claimIn(t, op.holder, op, now, { final: true, ...claimOpts, force: op.force, keepBlocks: op.keepBlocks });
      return { reply: r, changed: pruned || r.claimed.length > 0 || t.decisions.length !== logged || !!claimOpts.verdicts };
    }
    case 'renew': {
      const n = renewIn(t.leases, op.sessionId, now);
      return { reply: { renewed: n }, changed: pruned || n > 0 };
    }
    case 'release': {
      const n = releaseIn(t.leases, op.sessionId, op.paths);
      return { reply: { released: n }, changed: pruned || n > 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Checking requests from the network
// ---------------------------------------------------------------------------

/** A remote table refuses new claims past this size (the Durable Object keeps it as one stored value). */
export const MAX_LEASES = 2000;
/** File text sent with a claim, per file and in all; larger files are claimed without it. */
export const MAX_TEXT = 200_000;
const MAX_TEXTS = 400_000;
const MAX_PATHS = 500;
const MAX_BLOCKS = 100;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lineNo = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000_000 ? (v as number) : null);
const isSessionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const isPath = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024;
const pathList = (v: unknown): string[] | null => (Array.isArray(v) && v.length <= MAX_PATHS && v.every(isPath) ? (v as string[]) : null);

function parseBlock(v: unknown): Block | null {
  const b = obj(v);
  const [start, end, anchorLine] = [lineNo(b.start), lineNo(b.end), lineNo(b.anchorLine)];
  if (!start || !end || !anchorLine || end < start || typeof b.anchor !== 'string') return null;
  const name = str(b.name, 120);
  return { ...(name ? { name } : {}), start, end, anchor: b.anchor.slice(0, 300), anchorLine };
}

function parseBlocks(v: unknown): BlockClaim[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_BLOCKS) return `blocks must be a list of up to ${MAX_BLOCKS} blocks`;
  const out: BlockClaim[] = [];
  for (const x of v) {
    const c = obj(x);
    const block = parseBlock(c.block);
    if (!isPath(c.path) || !block) return 'each block needs a path and a block {start, end, anchor, anchorLine}';
    const ch = obj(c.change);
    const change = typeof ch.old === 'string' && typeof ch.new === 'string' ? { change: { old: ch.old.slice(0, 2000), new: ch.new.slice(0, 2000) } } : {};
    out.push({ path: c.path, block, ...change });
  }
  return out;
}

function parseTexts(v: unknown): Record<string, string> | string {
  if (v === undefined) return {};
  const entries = Object.entries(obj(v));
  if (entries.length > 20 || !entries.every(([k, t]) => isPath(k) && typeof t === 'string' && t.length <= MAX_TEXT)) return `texts must map up to 20 paths to file text (up to ${MAX_TEXT} characters each)`;
  if (entries.reduce((n, [, t]) => n + (t as string).length, 0) > MAX_TEXTS) return 'texts are too large';
  return Object.fromEntries(entries) as Record<string, string>;
}

/** `body` as a LeaseOp named `op`, or an error message. Untrusted input: strings are bounded, ids checked. */
export function parseOp(op: string, body: unknown): LeaseOp | string {
  const b = obj(body);
  switch (op) {
    case 'list':
      return { op: 'list' };
    case 'claim': {
      const h = obj(b.holder);
      if (!isSessionId(h.sessionId)) return 'holder.sessionId is missing or invalid';
      const paths = b.paths === undefined && b.blocks !== undefined ? [] : pathList(b.paths);
      if (!paths) return `paths must be a list of up to ${MAX_PATHS} file paths`;
      const blocks = parseBlocks(b.blocks);
      if (typeof blocks === 'string') return blocks;
      const texts = parseTexts(b.texts);
      if (typeof texts === 'string') return texts;
      const holder: Holder = { sessionId: h.sessionId };
      for (const [k, max] of [['branch', 256], ['worktree', 1024], ['ask', 300]] as const) {
        const v = str(h[k], max);
        if (v) holder[k] = v;
      }
      return {
        op: 'claim',
        holder,
        paths,
        ...(blocks.length ? { blocks } : {}),
        ...(Object.keys(texts).length ? { texts } : {}),
        ...(b.force === true ? { force: true } : {}),
        ...(b.keepBlocks === true ? { keepBlocks: true } : {}),
      };
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
