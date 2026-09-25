// Summary cache: <git-dir>/promptlog/cache/summary-<hash>.json.
// Keyed by everything that determines the output: the range (resolved SHAs), each session's ref commit and slice,
// the prompt version + template hash, the render version + budget, and the model.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir, gitMaybe } from '../core/git.ts';
import { sessionRef } from '../core/store.ts';
import type { Review, ReviewSummary } from '../core/types.ts';

export interface CacheKeyInput {
  mergeBase: string;
  /** Resolved head commit SHA (not a branch name, so new commits invalidate). */
  head: string;
  sessions: { sessionId: string; commit: string; fromTurn: number; toTurn: number }[];
  promptVersion: string;
  promptHash: string;
  renderVersion: number;
  budget: object;
  model: string;
}

/** Stable across session order and object key order. */
export function summaryCacheKey(k: CacheKeyInput): string {
  const sessions = [...k.sessions].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.fromTurn - b.fromTurn));
  const budget = Object.fromEntries(Object.entries(k.budget).sort(([a], [b]) => (a < b ? -1 : 1)));
  const canonical = JSON.stringify([k.mergeBase, k.head, sessions.map((s) => [s.sessionId, s.commit, s.fromTurn, s.toTurn]), k.promptVersion, k.promptHash, k.renderVersion, budget, k.model]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Session ref commits for the sessions in a review. */
export function sessionCommits(cwd: string, review: Review): CacheKeyInput['sessions'] {
  return review.slices.map((sl) => ({
    sessionId: sl.sessionId,
    commit: gitMaybe(['rev-parse', '--verify', '-q', sessionRef(sl.sessionId)], { cwd }) ?? '',
    fromTurn: sl.fromTurn,
    toTurn: sl.toTurn,
  }));
}

export interface CachedSummary {
  key: string;
  createdAt: string;
  summary: ReviewSummary;
  run?: { costUsd?: number; durationMs?: number; renderLevel?: number; inputTokens?: number; usage?: unknown };
}

export function cacheDir(cwd: string): string {
  return join(gitDir(cwd), 'promptlog', 'cache');
}

export function cachePath(cwd: string, key: string): string {
  return join(cacheDir(cwd), `summary-${key}.json`);
}

export function readCache(cwd: string, key: string): CachedSummary | null {
  const p = cachePath(cwd, key);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as CachedSummary;
    return c.key === key && c.summary ? c : null;
  } catch {
    return null;
  }
}

export function writeCache(cwd: string, entry: CachedSummary): string {
  mkdirSync(cacheDir(cwd), { recursive: true });
  const p = cachePath(cwd, entry.key);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  renameSync(tmp, p);
  return p;
}
