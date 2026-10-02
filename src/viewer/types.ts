// View models: plain, JSON-serializable data the render functions take. Built on the Node side by
// model.ts (git access) and consumed by render.ts (pure), so rendering can later move to Workers.
import type { AskResult, CommitInfo, FileChange, Glance, Leftover, Review, ReviewSummary, Session } from '../core/types.ts';

/** Whether an optional feature module (ask, summarize) is installed in this build. */
export type FeatureState = { available: true } | { available: false; reason: string };

export interface Features {
  /** Deep ask at a turn (Claude Code in a worktree, the user's Claude plan). */
  ask: FeatureState;
  /** The long review summary (Claude Code, the user's Claude plan). Runs only when asked for. */
  summary: FeatureState;
  /** Quick ask about the whole page (Jev + Gemini). Needs both keys. */
  quick?: FeatureState;
  /** Gemini-written glance (turn lines, file reasons, headline). Without it the page shows the model-free glance. */
  glance?: FeatureState;
}

/** The "at a glance" block and the quick-ask box, shared by review and session pages. */
export interface GlanceBlock {
  /** Model-free version rendered with the page; upgraded from `src` when set. */
  glance: Glance;
  /** /api/glance URL for the Gemini version. */
  src?: string;
  /** Quick-ask target: a session id or `base..head`. */
  target: string;
  /** Past quick asks on these turns, newest first. */
  asks: AskResult[];
  /** Names the work removed, and where the code still has them (git grep, no model). */
  leftovers?: Leftover[];
}

/** Per-turn data that needs git to compute. Keyed by turnKey(sessionId, turn). */
export interface TurnExtras {
  /** Commits made during the turn, with subjects. */
  commits?: { sha: string; subject: string }[];
  /** Files the human changed between the previous turn's end and this prompt: before(N) vs after(N-1). */
  humanEdits?: FileChange[];
  /** Earlier "ask at this turn" questions and answers. */
  asks?: AskResult[];
}

export type ExtrasMap = Record<string, TurnExtras>;

export const turnKey = (sessionId: string, turn: number) => `${sessionId}#${turn}`;

export interface ReviewPageModel {
  review: Review;
  extras: ExtrasMap;
  /** `git diff mergeBase..head`. */
  diff: string;
  diffTruncated?: boolean;
  features: Features;
  /** Server-side summary (e.g. the ?mockSummary=1 preview). When absent the page fetches /api/summary. */
  summary?: { data: ReviewSummary; mock?: boolean };
  repoName?: string;
  glance?: GlanceBlock;
}

export interface SessionPageModel {
  session: Session;
  extras: ExtrasMap;
  features: Features;
  repoName?: string;
  /** What the session changed: first turn's before-snapshot..last turn's after-snapshot. */
  diff?: string;
  diffTruncated?: boolean;
  glance?: GlanceBlock;
}

export interface BranchRow {
  branch: string;
  /** Default branch the review compares against. */
  base: string;
  exists: boolean;
  /** Ref to review: the local branch, or origin/<branch> when only the remote-tracking branch exists. */
  head: string;
  ahead: number;
  sessions: { sessionId: string; title?: string }[];
  updatedAt?: string;
}

export interface SessionRow {
  sessionId: string;
  title?: string;
  branch?: string;
  author?: string;
  turns: number;
  commits: number;
  startedAt?: string;
  updatedAt?: string;
}

export interface IndexPageModel {
  repoName: string;
  defaultBranch: string;
  branches: BranchRow[];
  sessions: SessionRow[];
}

export type { AskResult, CommitInfo, ReviewSummary };
