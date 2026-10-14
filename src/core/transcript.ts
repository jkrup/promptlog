// Claude Code JSONL transcript -> normalized turns.
// The JSONL format is internal to Claude Code and changes between versions, so everything here is
// defensive: unknown entry types are skipped, never fatal.
import type { Turn, TurnItem } from './types.ts';

// Loosely-typed transcript entry; only the fields we read.
export interface RawEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  /** kind 'human' for typed prompts; 'peer' for a message from another Claude session (name = its session name). */
  origin?: { kind?: string; name?: string; body?: string };
  sessionId?: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
  content?: unknown;
  aiTitle?: string;
  /** queue-operation entries: enqueue | dequeue | remove. */
  operation?: string;
  /** queue-operation remove: why the message left the queue ('absorbed_mid_turn'), and its id. */
  reason?: string;
  commandUuid?: string;
  /** type 'attachment': context Claude Code adds to the next model call. 'queued_command' = a message sent mid-turn. */
  attachment?: {
    type?: string;
    prompt?: unknown;
    source_uuid?: string;
    commandMode?: string;
    /** handback: a report from one of this session's own subagents. */
    origin?: { kind?: string; name?: string; body?: string; handback?: boolean };
    timestamp?: string;
  };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
}

export function parseLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

export function parseEntry(line: string): RawEntry | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as RawEntry) : null;
  } catch {
    return null;
  }
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Written by Claude Code as a user entry when the human presses Esc; an event, not a prompt. */
const INTERRUPT_MARKER = /^\s*\[Request interrupted by user[^\]]*\]\s*$/;

const INJECTED_PREFIX = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|teammate-message|user-prompt-submit-hook|bash-stdout|bash-stderr)\b/;

/**
 * True when the entry is a prompt typed by the human (the start of a turn).
 * Newer Claude Code versions tag these with origin.kind === 'human'; older ones need heuristics.
 */
export function isHumanPrompt(e: RawEntry): boolean {
  // A message from another Claude session starts a turn too: the session works on it like on a prompt.
  if (isPeerMessage(e)) return true;
  if (e.type !== 'user' || e.isSidechain || e.isMeta || e.isCompactSummary) return false;
  const content = e.message?.content;
  const blocks = blocksOf(content);
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  if (e.origin?.kind) return e.origin.kind === 'human';
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  if (!text.trim()) return blocks.some((b) => b.type === 'image');
  if (INTERRUPT_MARKER.test(text)) return false;
  return !INJECTED_PREFIX.test(text);
}

/** A message another Claude session sent this one (Claude Code marks it origin.kind 'peer'; it arrives as isMeta). */
export function isPeerMessage(e: RawEntry): boolean {
  return e.type === 'user' && !e.isSidechain && e.origin?.kind === 'peer';
}

/** Strip system-injected blocks from prompt text; keep what the human typed. */
export function cleanPromptText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>/g, (_m, name: string, args: string) => `${name.trim()} ${args.trim()}`.trim())
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_m, name: string) => name.trim())
    .trim();
}

/** What a turn's own tool calls say about commits they made: ids printed after a commit, and the messages used. */
export interface CommitClues {
  ids: string[];
  subjects: string[];
}

const COMMIT_CMD = /\bgit\b[^\n]*?\b(?:commit|cherry-pick|merge|revert|am)\b/;
/** One git invocation that makes a commit (several can share a command line, joined by && or ;). */
const COMMIT_CALL = /\bgit\s+(?:-c\s+\S+\s+)*(?:commit|cherry-pick|merge|revert|am)\b/g;

/**
 * Commit clues from a turn's raw transcript lines. Only tool calls that run a committing git command count. Their output
 * gives ids: `[<branch> <sha>] <subject>` from git itself, or a line starting with an id (`git log --oneline -1` after
 * `git commit -q`). Their `-m` gives the subject. Candidates only: callers check them against the repo.
 */
export function commitClues(lines: string[]): CommitClues {
  const ids = new Set<string>();
  const subjects = new Set<string>();
  const commands = new Map<string, string>();
  for (const line of lines) {
    const e = parseEntry(line);
    for (const b of blocksOf(e?.message?.content)) {
      if (b.type === 'tool_use') {
        const cmd = (b as { input?: { command?: unknown } }).input?.command;
        if (typeof cmd === 'string' && COMMIT_CMD.test(cmd) && b.id) {
          commands.set(b.id, cmd);
          for (const m of cmd.matchAll(/(?:^|\s)-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)) {
            const subject = (m[1] ?? m[2] ?? '').replace(/\$\(cat <<'?EOF'?\n?/, '').split('\n')[0]!.trim();
            if (subject) subjects.add(subject);
          }
        }
      } else if (b.type === 'tool_result' && b.tool_use_id && commands.has(b.tool_use_id)) {
        const c = (b as { content?: unknown }).content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String(x.text) : '')).join('\n') : '';
        // As many ids as the command made commits: a `git log -4` after three commits lists an older one too.
        const made = Math.max(1, (commands.get(b.tool_use_id)!.match(COMMIT_CALL) ?? []).length);
        const found = [...text.matchAll(/^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]|^([0-9a-f]{7,40})\b/gm)].map((m) => (m[1] ?? m[2])!);
        for (const id of found.slice(0, made)) ids.add(id);
      }
    }
  }
  return { ids: [...ids], subjects: [...subjects] };
}

/**
 * The part of a prompt worth naming a session after: the person's own words, not text they pasted.
 * Pasted blocks arrive wrapped as `<pasted_content …>…</pasted_content …>`; when there's nothing else, use what was pasted.
 */
export function titleText(prompt: string): string {
  const PASTE = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;
  const own = prompt.replace(PASTE, ' ').trim();
  const text = own || [...prompt.matchAll(PASTE)].map((m) => m[1]!).join('\n');
  return text.replace(/<\/?pasted_content\b[^>]*>/g, '').trim();
}

/** True for prompts that are terminal commands (`!ls`, bash mode) or slash commands, not requests to the agent. */
export function isCommandPrompt(prompt: string): boolean {
  return /^\s*(?:!|<bash-input>|<bash-stdout>|\/[a-z][\w:-]*(?:\s|$))/i.test(prompt);
}

function promptText(e: RawEntry): string {
  const blocks = blocksOf(e.message?.content);
  const parts = blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : '')).filter(Boolean);
  return cleanPromptText(parts.join('\n'));
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : b.type ? `[${b.type}]` : ''))
    .join('\n');
}

/** `queue-operation` enqueue/dequeue entries: Claude Code writes these just before the prompt they queue. */
function isPromptQueueOp(e: RawEntry | null): boolean {
  return e?.type === 'queue-operation' && (e.operation === 'enqueue' || e.operation === 'dequeue');
}

const CROSS_SESSION = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)(?:<\/cross-session-message>|$)/;

/** The sender's session name and the message inside a `<cross-session-message from-name="…">` envelope. */
export function crossSessionMessage(text: string): { from?: string; body: string } | null {
  const m = CROSS_SESSION.exec(text);
  if (!m) return null;
  const name = /\bfrom-name="([^"]*)"/.exec(m[1]!)?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { ...(name ? { from: name } : {}), body: m[2]!.trim() };
}

/** A message that reached Claude while it was working. `from` is set when another Claude session sent it. */
interface MidTurnMessage {
  text: string;
  from?: string;
  /** The queued message's id, shared by its attachment (source_uuid) and its queue removal (commandUuid). */
  id?: string;
  timestamp?: string;
  source: 'attachment' | 'remove';
}

const PEER_FALLBACK = 'another Claude session';

/** Queued but not a message: background-task notices, and reports from this session's own subagents. */
const NOT_A_MESSAGE = /^\s*<(task-notification|agent-message)\b/;

/**
 * Read a mid-turn message from a `queued_command` attachment (what Claude saw, with the sender) or, for transcripts
 * that lack it, from the queue's `remove` (reason absorbed_mid_turn).
 */
function midTurnMessage(e: RawEntry): MidTurnMessage | null {
  if (e.isSidechain) return null;
  if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
    const a = e.attachment;
    const kind = a.origin?.kind;
    if ((a.commandMode && a.commandMode !== 'prompt') || (kind && kind !== 'human' && kind !== 'peer') || a.origin?.handback) return null;
    const raw = blocksOf(a.prompt)
      .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
    if (NOT_A_MESSAGE.test(raw)) return null;
    const env = crossSessionMessage(raw);
    const text = kind === 'peer' && typeof a.origin?.body === 'string' ? a.origin.body : env ? env.body : cleanPromptText(raw);
    const peer = kind === 'peer' || (!kind && !!env);
    return { text: text.trim(), ...(peer ? { from: a.origin?.name || env?.from || PEER_FALLBACK } : {}), id: a.source_uuid, timestamp: a.timestamp ?? e.timestamp, source: 'attachment' };
  }
  if (e.type === 'queue-operation' && e.operation === 'remove' && (!e.reason || e.reason === 'absorbed_mid_turn') && typeof e.content === 'string') {
    if (NOT_A_MESSAGE.test(e.content)) return null;
    const env = crossSessionMessage(e.content);
    return { text: (env ? env.body : cleanPromptText(e.content)).trim(), ...(env ? { from: env.from || PEER_FALLBACK } : {}), id: e.commandUuid, timestamp: e.timestamp, source: 'remove' };
  }
  return null;
}

/** For matching a message's attachment with its queue removal: image placeholders and spacing differ between them. */
const midTurnKey = (text: string) => text.replace(/\[Image #\d+\]|\[image\]/gi, '').replace(/\s+/g, ' ').trim();

/**
 * Split raw transcript lines into per-turn chunks, keyed by the ordinal of the human prompt.
 * Lines before the first prompt (preamble metadata) are attached to turn 1.
 * Queue operations written after a turn's last user/assistant entry belong to the next prompt (they carry its text),
 * so they move to the next chunk together with whatever follows them; concatenating the chunks still gives `lines`.
 * Returns chunks[0] = turn 1. Used by the store so every turn's raw log lives in its own blob.
 */
export function splitByTurn(lines: string[]): { promptUuid?: string; lines: string[] }[] {
  const chunks: { promptUuid?: string; lines: string[] }[] = [];
  let preamble: string[] = [];
  let carryFrom = -1; // index in the current chunk of the first queue op after its last user/assistant entry
  for (const line of lines) {
    const e = parseEntry(line);
    if (e && isHumanPrompt(e)) {
      const carry = chunks.length > 0 && carryFrom >= 0 ? chunks[chunks.length - 1]!.lines.splice(carryFrom) : [];
      chunks.push({ promptUuid: e.uuid, lines: chunks.length === 0 ? [...preamble, line] : [...carry, line] });
      preamble = [];
      carryFrom = -1;
    } else if (chunks.length === 0) {
      preamble.push(line);
    } else {
      const cur = chunks[chunks.length - 1]!.lines;
      cur.push(line);
      if (e?.type === 'user' || e?.type === 'assistant') carryFrom = -1;
      else if (carryFrom < 0 && isPromptQueueOp(e)) carryFrom = cur.length - 1;
    }
  }
  return chunks;
}

/** Normalize transcript lines into turns. Assistant blocks split across lines (same message.id) are merged in order. */
export function normalize(lines: string[]): Turn[] {
  const turns: Turn[] = [];
  const toolIndex = new Map<string, Extract<TurnItem, { kind: 'tool' }>>();
  let current: Turn | null = null;
  // This turn's mid-turn messages, to pair each one's attachment with its queue removal (either can come first).
  let mids: { item: Extract<TurnItem, { kind: 'event' }>; id?: string; key: string; sources: Set<string> }[] = [];

  const push = (item: TurnItem) => {
    if (!current) {
      current = { index: 0, prompt: '', items: [] }; // activity before any human prompt (rare)
      turns.push(current);
    }
    current.items.push(item);
  };

  for (const line of lines) {
    const e = parseEntry(line);
    if (!e) continue;

    if (isHumanPrompt(e)) {
      const peer = isPeerMessage(e);
      current = {
        index: turns.filter((t) => t.index > 0).length + 1,
        promptUuid: e.uuid,
        // A peer message's text sits in the envelope Claude Code wraps around it; origin.body is just the message.
        prompt: peer && typeof e.origin?.body === 'string' ? e.origin.body : promptText(e),
        ...(peer ? { from: e.origin?.name || 'another Claude session' } : {}),
        timestamp: e.timestamp,
        items: [],
      };
      turns.push(current);
      mids = [];
      continue;
    }

    const mid = midTurnMessage(e);
    if (mid) {
      const key = midTurnKey(mid.text);
      const same = mids.find((m) => !m.sources.has(mid.source) && (mid.id && m.id ? m.id === mid.id : m.key === key));
      if (same) {
        // The other half of a message already shown. The attachment knows more (sender, images), so it wins.
        same.sources.add(mid.source);
        if (mid.source === 'attachment') {
          if (mid.text) same.item.text = mid.text;
          if (mid.from) same.item.from = mid.from;
          if (mid.timestamp) same.item.timestamp = mid.timestamp;
        }
      } else if (mid.text) {
        const item: Extract<TurnItem, { kind: 'event' }> = { kind: 'event', subtype: 'midturn', text: mid.text, timestamp: mid.timestamp, ...(mid.from ? { from: mid.from } : {}) };
        push(item);
        mids.push({ item, id: mid.id, key, sources: new Set([mid.source]) });
      }
      continue;
    }

    if (e.type === 'assistant' && e.message) {
      const sidechain = !!e.isSidechain;
      for (const b of blocksOf(e.message.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          if (!sidechain) push({ kind: 'text', text: b.text, model: e.message.model, timestamp: e.timestamp, uuid: e.uuid });
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          if (!sidechain) push({ kind: 'thinking', text: b.thinking, timestamp: e.timestamp });
        } else if (b.type === 'tool_use' && b.id) {
          const item: Extract<TurnItem, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: b.name ?? 'unknown', input: b.input, timestamp: e.timestamp, sidechain };
          toolIndex.set(b.id, item);
          push(item);
        }
      }
      if (current && e.message.model && !sidechain && e.message.model !== '<synthetic>') current.model = e.message.model;
      continue;
    }

    if (e.type === 'user' && e.message) {
      const blocks = blocksOf(e.message.content);
      let handled = false;
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const item = toolIndex.get(b.tool_use_id);
          if (item) {
            item.result = toolResultText(b.content);
            item.isError = !!b.is_error;
          }
          handled = true;
        }
      }
      if (handled) continue;
      if (e.isSidechain) continue;
      const text = blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n').trim();
      if (!text) continue;
      const subtype = e.isCompactSummary ? 'compact_summary' : /^\s*<local-command-/.test(text) ? 'command_output' : /interrupted by user/i.test(text) ? 'interrupt' : 'injected';
      if (subtype === 'injected' && /^\s*<system-reminder>/.test(text)) continue; // noise for reviewers
      push({ kind: 'event', subtype, text: cleanPromptText(text) || text, timestamp: e.timestamp });
      continue;
    }

    if (e.type === 'system' && e.subtype) {
      if (e.subtype === 'compact_boundary') push({ kind: 'event', subtype: 'compact_boundary', text: 'Conversation compacted', timestamp: e.timestamp });
      continue;
    }
    // other attachments and queue operations, titles, mode, cost-state, etc. are skipped.
  }

  for (const t of turns) {
    for (let i = t.items.length - 1; i >= 0; i--) {
      const it = t.items[i]!;
      if (it.kind === 'text') {
        t.finalResponse = it.text;
        break;
      }
    }
  }
  return turns;
}

/** Session-level facts found in the transcript. */
export function transcriptFacts(lines: string[]): { title?: string; version?: string; model?: string; startedAt?: string; branch?: string } {
  const facts: { title?: string; version?: string; model?: string; startedAt?: string; branch?: string } = {};
  for (const line of lines) {
    const e = parseEntry(line);
    if (!e) continue;
    if (e.type === 'ai-title' && e.aiTitle) facts.title = e.aiTitle;
    if (!facts.version && e.version) facts.version = e.version;
    if (!facts.startedAt && e.timestamp) facts.startedAt = e.timestamp;
    if (!facts.branch && e.gitBranch && e.gitBranch !== 'HEAD') facts.branch = e.gitBranch;
    if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>') facts.model = e.message.model;
  }
  return facts;
}
