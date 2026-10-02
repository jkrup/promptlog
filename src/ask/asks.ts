// Persisted Q&A: refs/promptlog/asks/<sessionId>. See docs/format.md ("Asks").
//
// Kept out of refs/promptlog/sessions/* on purpose: capture rebuilds session trees and would drop anything else.
// Append-only commit chain; each commit adds one file `<id>.json` (a StoredAsk) to a flat tree. Ids are unique
// (timestamp + random), so two reviewers' chains merge as a plain union of files.
import { randomBytes } from 'node:crypto';
import { catFileBatch, git, gitMaybe, hashBlob, lsTree, mktree } from '../core/git.ts';
import type { AskResult } from '../core/types.ts';
import type { QuickAskInfo } from '../quick/types.ts';
import type { StateSource } from './materialize.ts';
import { commitEnv } from './session.ts';

export const ASKS_REF_PREFIX = 'refs/promptlog/asks/';
export const asksRef = (sessionId: string) => ASKS_REF_PREFIX + sessionId;

/** One persisted ask. A superset of the core AskResult contract. */
export interface StoredAsk extends AskResult {
  schema: 1;
  /** Unique id; also the file name (`<id>.json`) in the asks tree. */
  id: string;
  model?: string;
  /** Repo state the answer was produced against. */
  state?: { source: StateSource; commit: string; tree: string };
  /** Set on quick asks (`promptlog ask` without --at): Jev scores, verdict, the turns that answered. */
  quick?: QuickAskInfo;
}

/** `20260925T190102Z-3fa9c1`: sortable by time, unique across machines. */
export function newAskId(askedAt: string): string {
  return `${askedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
}

/** Append an ask to the session's asks ref. Retries on concurrent writers (compare-and-swap on the ref). */
export function saveAsk(cwd: string, ask: StoredAsk): { commit: string; path: string } {
  const ref = asksRef(ask.sessionId);
  const path = `${ask.id}.json`;
  const blob = hashBlob(cwd, JSON.stringify(ask, null, 2) + '\n');
  const env = commitEnv(cwd);
  const subject = `ask turn ${ask.turn}: ${ask.question.split('\n')[0]!.slice(0, 72)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const prev = gitMaybe(['rev-parse', '--verify', '-q', ref], { cwd }) ?? undefined;
    const entries = (prev ? lsTree(cwd, prev) : []).filter((e) => e.name !== path);
    entries.push({ mode: '100644', type: 'blob', sha: blob, name: path });
    const tree = mktree(cwd, entries);
    const commit = git(['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', subject], { cwd, env });
    if (gitMaybe(['update-ref', ref, commit, prev ?? ''], { cwd }) !== null) return { commit, path };
  }
  throw new Error(`could not update ${ref}: too many concurrent writers`);
}

export interface ListAsksOptions {
  /** Only asks at this turn. */
  turn?: number;
}

/** All asks for a session, oldest first. Unreadable entries are skipped. */
export function listAsks(cwd: string, sessionId: string, opts: ListAsksOptions = {}): StoredAsk[] {
  const ref = asksRef(sessionId);
  const head = gitMaybe(['rev-parse', '--verify', '-q', ref], { cwd });
  if (!head) return [];
  const files = lsTree(cwd, head).filter((e) => e.type === 'blob' && e.name.endsWith('.json'));
  const bufs = catFileBatch(cwd, files.map((f) => f.sha));
  const asks: StoredAsk[] = [];
  for (const buf of bufs) {
    if (!buf) continue;
    try {
      const a = JSON.parse(buf.toString('utf8')) as StoredAsk;
      if (a && typeof a.question === 'string' && typeof a.turn === 'number') asks.push(a);
    } catch {
      // skip
    }
  }
  return asks
    .filter((a) => opts.turn === undefined || a.turn === opts.turn)
    .sort((a, b) => (a.askedAt === b.askedAt ? (a.id < b.id ? -1 : 1) : a.askedAt < b.askedAt ? -1 : 1));
}

/** Session ids that have asks. */
export function listAskedSessions(cwd: string): string[] {
  const out = gitMaybe(['for-each-ref', '--format=%(refname)', ASKS_REF_PREFIX], { cwd });
  return out ? out.split('\n').filter(Boolean).map((r) => r.slice(ASKS_REF_PREFIX.length)) : [];
}
