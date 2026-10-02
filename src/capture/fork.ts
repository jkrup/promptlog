// Link forked sessions to their parent. `promptlog fork` (src/ask) leaves a marker in the fork worktree's git dir; a session
// captured there whose transcript contains the parent's prompt uuid (`--fork-session` keeps message uuids) is the fork.
// src/ask is loaded dynamically and optionally, so capture keeps working without it.
import { existsSync, readFileSync } from 'node:fs';

export interface ForkParentMarker {
  parent: { sessionId: string; turn: number };
  parentPromptUuid?: string;
}

export type ForkMarkerReader = (cwd: string) => ForkParentMarker | null;

/** `readForkMarker` from src/ask, or undefined if that module is missing or doesn't export it. */
export async function loadForkMarkerReader(): Promise<ForkMarkerReader | undefined> {
  try {
    const spec = new URL('../ask/fork.ts', import.meta.url).href; // non-literal: no static dependency on src/ask
    const mod = (await import(spec)) as { readForkMarker?: unknown };
    return typeof mod.readForkMarker === 'function' ? (mod.readForkMarker as ForkMarkerReader) : undefined;
  } catch {
    return undefined;
  }
}

/** The parent to record for the session in `transcriptPath`, if this worktree is a fork of it. */
export function forkParent(read: ForkMarkerReader, root: string, transcriptPath: string): ForkParentMarker['parent'] | undefined {
  const m = read(root);
  const p = m?.parent;
  if (!p || typeof p.sessionId !== 'string' || !Number.isInteger(p.turn) || typeof m.parentPromptUuid !== 'string' || !m.parentPromptUuid) return undefined;
  if (!existsSync(transcriptPath) || !readFileSync(transcriptPath, 'utf8').includes(m.parentPromptUuid)) return undefined;
  return { sessionId: p.sessionId, turn: p.turn };
}
