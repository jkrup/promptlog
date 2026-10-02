// Types shared by the quick-ask pieces (map, scoring, answer) and stored with each quick ask.

/** One Gemini-written note per turn: the "map" Jev reads to find turns that matter. */
export interface TurnNote {
  turn: number;
  /** What the human asked for, ≤15 words, lowercase verb first ("swap the URL for the proxy"). */
  asked: string;
  /** What the AI actually did, ≤30 words, lowercase past-tense verb first. */
  did: string;
  /** Changes nobody asked for (removed checks, new defaults, hardcoded values), each with the AI's stated reason. */
  beyond: string[];
  /** Choices made this turn, with the reason when one was given. */
  decided: string[];
  /** Raised but not done: skipped, deferred, left as a TODO, or dropped after pushback. */
  deferred: string[];
  /** Housekeeping a reviewer can skip (a terminal command, a quick look, a thank-you). */
  minor: boolean;
}

export type { QuickAskInfo, TurnScore, Verdict, VerdictLabel } from '../core/types.ts';
