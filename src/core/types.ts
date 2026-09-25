// Shared data model. Every module (capture, viewer, ask/fork, summarize) builds on these types.
// On-disk layout is documented in docs/format.md; keep the two in sync.

export const SCHEMA_VERSION = 1;
export const REF_PREFIX = 'refs/promptlog/sessions/';

/** Stored as `session.json` at the root of every session commit (latest commit wins). */
export interface SessionMeta {
  schema: typeof SCHEMA_VERSION;
  sessionId: string;
  agent: 'claude-code';
  agentVersion?: string;
  /** Title from the agent (e.g. Claude Code's ai-title) or derived from the first prompt. */
  title?: string;
  author?: { name: string; email: string };
  /** Working directory relative to the repo root ('' = root). Absolute paths are never stored. */
  cwd: string;
  branch?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  /** Set when this session was forked from another session's turn. */
  parent?: { sessionId: string; turn: number };
}

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  additions: number;
  deletions: number;
  oldPath?: string;
}

/** Stored as `turns/<NNNNNN>/meta.json`. A turn = one human prompt plus everything until the next human prompt. */
export interface TurnMeta {
  schema: typeof SCHEMA_VERSION;
  /** 1-based ordinal of the human prompt within the session transcript. */
  index: number;
  /** uuid of the human prompt entry in the agent transcript. */
  promptUuid?: string;
  startedAt?: string;
  endedAt?: string;
  branch?: string;
  /** HEAD commit when the prompt was submitted / when the agent stopped. */
  headBefore?: string;
  headAfter?: string;
  /** Commits created during this turn (headBefore..headAfter), oldest first. */
  commits: string[];
  /** Tree SHAs of the working-tree snapshot (tracked + untracked-not-ignored files). Also stored as tree entries `before`/`after`. */
  stateBefore?: string;
  stateAfter?: string;
  /** Files changed between stateBefore and stateAfter, i.e. what happened during this turn. */
  filesChanged?: FileChange[];
  model?: string;
}

// ---------------------------------------------------------------------------
// Normalized conversation (agent-agnostic view of a transcript)
// ---------------------------------------------------------------------------

export type TurnItem =
  | { kind: 'text'; text: string; model?: string; timestamp?: string; uuid?: string }
  | { kind: 'thinking'; text: string; timestamp?: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      timestamp?: string;
      /** True when the call happened inside a subagent (sidechain). */
      sidechain?: boolean;
    }
  /** Non-human user-side content: slash-command output, interrupts, compaction summaries, hook feedback. */
  | { kind: 'event'; subtype: string; text: string; timestamp?: string };

export interface Turn {
  index: number;
  promptUuid?: string;
  /** The human's prompt, with system-injected blocks stripped. */
  prompt: string;
  timestamp?: string;
  items: TurnItem[];
  /** Last assistant text in the turn: what the human saw as "the answer". */
  finalResponse?: string;
  model?: string;
  /** Present when loaded from the store. */
  meta?: TurnMeta;
}

export interface Session {
  meta: SessionMeta;
  turns: Turn[];
}

// ---------------------------------------------------------------------------
// Review = the prompt-native equivalent of a PR: a commit range plus the conversation slices behind it.
// Many-to-many: one range can pull turns from several sessions; one session can feed several ranges.
// ---------------------------------------------------------------------------

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
  /** Values of `Promptlog: <sessionId>#<turn>` trailers. */
  trailers: { sessionId: string; turn: number }[];
}

export interface SessionSlice {
  sessionId: string;
  fromTurn: number;
  toTurn: number;
  /** Turns inside the slice that produced commits in the range. */
  committingTurns: number[];
}

export interface Review {
  base: string;
  head: string;
  mergeBase: string;
  commits: CommitInfo[];
  slices: SessionSlice[];
  sessions: Record<string, Session>;
}

// ---------------------------------------------------------------------------
// Contracts between feature areas (viewer <-> summarize, viewer <-> ask)
// ---------------------------------------------------------------------------

/** Output of src/summarize. The "taste" layer: what a reviewer should know without reading the log. */
export interface ReviewSummary {
  /** One or two sentences: what the human was trying to get done. */
  intent: string;
  /** How it was done, in reviewer terms. */
  approach: string;
  /** One line per turn. */
  timeline: { sessionId: string; turn: number; gist: string }[];
  decisions: { sessionId: string; turn: number; decision: string; rationale?: string; alternatives?: string[] }[];
  /** Where the human corrected or redirected the AI. Often the most review-relevant moments. */
  pushbacks: { sessionId: string; turn: number; humanSaid: string; aiChanged: string }[];
  /** Raised in the conversation, never resolved. */
  openLoops: { sessionId: string; turn: number; item: string }[];
  assumptions: string[];
  /** What the AI said it did vs what the diff shows. */
  planVsDiff: { sessionId: string; turn: number; claim: string; status: 'done' | 'partial' | 'missing' | 'unclear'; evidence: string }[];
  riskFlags: { severity: 'high' | 'medium' | 'low'; note: string; sessionId?: string; turn?: number }[];
  /** Provenance. */
  generatedAt: string;
  model?: string;
  promptVersion: string;
}

/** Output of src/ask: a question answered against the conversation + repo state at a turn. */
export interface AskResult {
  sessionId: string;
  turn: number;
  question: string;
  answer: string;
  /** Session id of the forked Claude Code session that answered (resumable). */
  forkSessionId?: string;
  askedAt: string;
  askedBy?: string;
  costUsd?: number;
}
