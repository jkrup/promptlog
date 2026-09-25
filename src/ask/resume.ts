// Build a transcript that `claude --resume <abs-path> --fork-session` can load. Recipe and findings: docs/ask-fork.md.
//
// Claude Code accepts any absolute .jsonl path for --resume, and --fork-session copies the lines into a new session
// (new id, cwd = where claude runs). Nothing else is required. We still:
//   - rewrite the author's absolute repo root to the worktree root in every string (cwd fields, tool inputs,
//     tool results), so the model and its file tools point at the materialized state, never at the author's checkout
//     (which may exist on the same machine with a different, later state);
//   - drop a trailing tool_use that never got a result (turn cut mid-tool), so the resumed history ends cleanly;
//   - drop `queue-operation` entries: prompt-queue bookkeeping, not conversation. The store files the *next* prompt's
//     enqueue line under the previous turn, so keeping them would leak turn N+1's prompt into a turn-N resume.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEntry, type RawEntry } from '../core/transcript.ts';
import { transcriptUpTo, type StoredSession } from '../core/store.ts';

type Block = { type?: string; id?: string; tool_use_id?: string };

function blocks(e: RawEntry | null): Block[] {
  const c = e?.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

const isMessage = (e: RawEntry | null): e is RawEntry => !!e && (e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !!e.message;

/** The first `cwd` recorded in the transcript: where the author's agent ran. */
export function originalCwd(lines: string[]): string | undefined {
  for (const l of lines) {
    const e = parseEntry(l);
    if (e?.cwd) return e.cwd;
  }
  return undefined;
}

/**
 * The author's repo root: the first entry's `cwd` minus the session's repo-relative cwd.
 * Undefined when the suffix doesn't match (the caller then maps the raw cwd to the agent cwd instead).
 */
export function originalRoot(lines: string[], relCwd: string): string | undefined {
  const cwd = originalCwd(lines);
  if (!cwd) return undefined;
  if (!relCwd) return cwd;
  const suffix = '/' + relCwd.replace(/^\/+|\/+$/g, '');
  return cwd.endsWith(suffix) ? cwd.slice(0, -suffix.length) : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, f);
    return out;
  }
  return v;
}

/**
 * Replace the path `from` with `to` in every string of every JSON line. Only whole path prefixes match:
 * `/repo` rewrites `/repo` and `/repo/src/x.ts` but not `/repo-old`. Unparseable lines pass through unchanged.
 */
export function rewritePaths(lines: string[], from: string, to: string): string[] {
  if (!from || from === to || from === '/') return lines;
  const re = new RegExp(escapeRe(from) + '(?![\\w.-])', 'g');
  const needle = JSON.stringify(from).slice(1, -1);
  return lines.map((line) => {
    if (!line.includes(needle)) return line;
    try {
      return JSON.stringify(mapStrings(JSON.parse(line), (s) => (s.includes(from) ? s.replace(re, () => to) : s)));
    } catch {
      return line;
    }
  });
}

/**
 * If the conversation ends in an assistant message whose tool_use calls never got a tool_result, cut from its first
 * tool_use line onwards. Text/thinking lines of that message before the tool call are kept.
 */
export function dropDanglingToolUse(lines: string[]): { lines: string[]; dropped: number } {
  const entries = lines.map(parseEntry);
  const answered = new Set<string>();
  for (const e of entries) for (const b of blocks(e)) if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);

  let last = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] ?? null;
    if (isMessage(e) && e.type === 'assistant') {
      last = i;
      break;
    }
  }
  if (last < 0) return { lines, dropped: 0 };
  // A later human/user text message means the conversation moved on; leave it to Claude Code.
  for (let i = last + 1; i < entries.length; i++) {
    const e = entries[i] ?? null;
    if (isMessage(e) && e.type === 'user' && !blocks(e).some((b) => b.type === 'tool_result')) return { lines, dropped: 0 };
  }
  const msgId = entries[last]!.message?.id;
  const sameMsg = (e: RawEntry | null) => isMessage(e) && e.type === 'assistant' && (msgId ? e.message?.id === msgId : e === entries[last]);
  let cut = -1;
  let dangling = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? null;
    if (!sameMsg(e)) continue;
    for (const b of blocks(e)) {
      if (b.type !== 'tool_use' || !b.id) continue;
      if (cut < 0) cut = i;
      if (!answered.has(b.id)) dangling = true;
    }
  }
  if (!dangling || cut < 0) return { lines, dropped: 0 };
  return { lines: lines.slice(0, cut), dropped: lines.length - cut };
}

/** Remove Claude Code prompt-queue bookkeeping lines (`{"type":"queue-operation",...}`). */
export function dropQueueOperations(lines: string[]): string[] {
  return lines.filter((l) => !(l.includes('"queue-operation"') && parseEntry(l)?.type === 'queue-operation'));
}

export interface ResumeTranscript {
  lines: string[];
  /** The author's repo root found in the transcript (rewritten to `worktreeRoot`). */
  originalRoot?: string;
  /** Lines dropped from the end (dangling tool_use). */
  dropped: number;
}

/** Transcript lines up to and including `turn`, rewritten to run from `worktreeRoot`. */
export function buildResumeTranscript(stored: StoredSession, turn: number, worktreeRoot: string): ResumeTranscript {
  let lines = dropQueueOperations(transcriptUpTo(stored, turn));
  const rel = stored.meta.cwd || '';
  const root = originalRoot(lines, rel);
  if (root) lines = rewritePaths(lines, root, worktreeRoot);
  else {
    const cwd = originalCwd(lines);
    if (cwd) lines = rewritePaths(lines, cwd, rel ? `${worktreeRoot}/${rel}` : worktreeRoot);
  }
  const trimmed = dropDanglingToolUse(lines);
  return { lines: trimmed.lines, originalRoot: root, dropped: trimmed.dropped };
}

export function writeTranscript(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
}
