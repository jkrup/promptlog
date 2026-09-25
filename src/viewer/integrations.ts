// Optional feature modules built by other tracks: src/ask (M3) and src/summarize (M4).
// Loaded lazily with a dynamic import so the viewer works before they exist, and picks them up
// once they land, without restarting on a missing-file error.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AskResult, Review, ReviewSummary } from '../core/types.ts';

export interface AskModule {
  ask(opts: { cwd: string; sessionId: string; turn: number; question: string; model?: string }): Promise<AskResult>;
  listAsks?(cwd: string, sessionId: string): AskResult[] | Promise<AskResult[]>;
}

export interface SummarizeModule {
  summarizeReview(cwd: string, review: Review, opts?: { model?: string; refresh?: boolean }): Promise<ReviewSummary>;
}

export type Loaded<T> = { ok: true; mod: T } | { ok: false; reason: string };

async function load<T>(rel: string, fn: string, area: string): Promise<Loaded<T>> {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return { ok: false, reason: `${area} isn't installed in this build yet.` };
  try {
    const mod = (await import(url.href)) as Record<string, unknown>;
    if (typeof mod[fn] !== 'function') return { ok: false, reason: `${area} doesn't export ${fn}() yet.` };
    return { ok: true, mod: mod as T };
  } catch (e) {
    return { ok: false, reason: `${area} failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function loadAsk(): Promise<Loaded<AskModule>> {
  return load<AskModule>('../ask/index.ts', 'ask', 'Asking questions at a turn (src/ask)');
}

export function loadSummarize(): Promise<Loaded<SummarizeModule>> {
  return load<SummarizeModule>('../summarize/index.ts', 'summarizeReview', 'The summarizer (src/summarize)');
}
