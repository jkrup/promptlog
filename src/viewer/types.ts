// View models: plain, JSON-serializable data the render functions take. Built on the Node side by
// model.ts (git access) and consumed by render.ts (pure), so rendering can later move to Workers.
import type { AskResult, CommitInfo, FileChange, Review, ReviewSummary, Session } from '../core/types.ts';

/** Whether an optional feature module (ask, summarize) is installed in this build. */
export type FeatureState = { available: true } | { available: false; reason: string };

export interface Features {
  ask: FeatureState;
  summary: FeatureState;
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
}

export interface SessionPageModel {
  session: Session;
  extras: ExtrasMap;
  features: Features;
  repoName?: string;
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
