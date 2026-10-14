// Clef decides the leases' gray zone: two agents about to edit neighbouring blocks of one file, or one agent about to
// edit a block another agent left quiet. One narrow question over small inputs (both agents' asks, both blocks' code,
// the edit), answered as a choice with probabilities; code decides: "independent" at ALLOW_AT or above lets the edit
// through, anything else (or no answer within the budget) refuses it. Any Jev-shaped decision endpoint works: Clef-flash
// through the Worker's AI binding (cloud/viewer), or the local decision client (src/quick/jev.ts).
// No Node imports: the Worker bundles this file.
import { describeBlock } from './blocks.ts';
import { claimIn, decisionFor, type ClaimOpts, type ClaimRequest, type ClaimResult, type Decision, type GrayCase, type Holder, type Table } from './lease-table.ts';

export interface JudgeRequest {
  state: Record<string, unknown>;
  questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
}

export interface JudgeAnswer {
  model?: string;
  answers: Record<string, unknown>;
}

/** One request to a decision model. Should give up when `signal` aborts (the caller stops waiting anyway). */
export type Judge = (req: JudgeRequest, signal: AbortSignal) => Promise<JudgeAnswer>;

/** How long a gray-zone claim waits for Clef before it refuses, to be safe. */
export const JUDGE_BUDGET_MS = 1500;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s);

/** The question for one case: small, typed, about these two blocks only. */
export function clefRequest(c: GrayCase): JudgeRequest {
  const mine = describeBlock(c.wanted.block);
  const theirs = describeBlock(c.held.block!);
  const situation =
    c.why === 'near'
      ? `Two coding agents are changing the same file, ${c.path}, at the same time. Agent A is working on ${theirs}. Agent B is about to edit ${mine}, right next to it.`
      : `Agent A edited ${theirs} in ${c.path} ${c.quietMin} min ago and has not touched it since. Agent B is about to edit the same code.`;
  const ch = c.wanted.change;
  return {
    state: {
      situation,
      agent_a: { asked_to: clip(c.held.ask, 300) ?? '(not known)', working_on: theirs, code: c.heldCode ?? '(not available)' },
      agent_b: {
        asked_to: clip(c.asker.ask, 300) ?? '(not known)',
        about_to_edit: mine,
        code: c.wantedCode ?? '(not available)',
        ...(ch ? { edit: { replaces: clip(ch.old, 600), with: clip(ch.new, 600) } } : {}),
      },
    },
    questions: {
      verdict: {
        type: 'choice',
        instructions: "Can agent B make its edit now, while agent A keeps working, without the two changes stepping on each other? Judge from the asks, the code and B's edit.",
        criteria: {
          independent: "Yes. The changes are about different things: B's edit won't break, undo or duplicate A's work, and A's work won't break B's.",
          conflicting: 'No. They change the same lines, logic or data, or one will likely break or redo the other. B should wait until A is done.',
          unsure: 'There is not enough information to tell.',
        },
      },
    },
  };
}

/** The choice and probabilities from a Jev-shaped answer, or null when it has none. */
export function readVerdict(res: JudgeAnswer | null | undefined): { choice: string; probabilities: Record<string, number>; model?: string } | null {
  const a = res?.answers?.verdict as { choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined;
  if (!a || typeof a.choice !== 'string') return null;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : {})) {
    if (typeof v === 'number' && Number.isFinite(v)) probabilities[k] = Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  }
  if (!(a.choice in probabilities) && typeof a.confidence === 'number') probabilities[a.choice] = a.confidence;
  return { choice: a.choice, probabilities, ...(typeof res?.model === 'string' ? { model: res.model } : {}) };
}

const secs = (ms: number) => String(Math.round(ms / 100) / 10);

/** Ask the judge about one case within `budgetMs`. Never throws: no judge, a timeout or an error is a refusal. */
export async function judgeCase(c: GrayCase, judge: Judge | null, budgetMs = JUDGE_BUDGET_MS, noJudge = 'no decision model is set up'): Promise<Decision> {
  if (!judge || budgetMs <= 0) return decisionFor(c, Date.now(), null, judge ? 'no time left to ask' : noJudge);
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((ok) => {
    timer = setTimeout(() => {
      ctl.abort();
      ok('late');
    }, budgetMs);
  });
  try {
    const res = await Promise.race([judge(clefRequest(c), ctl.signal), late]);
    if (res === 'late') return decisionFor(c, Date.now(), null, `Clef took longer than ${secs(budgetMs)} s`);
    const v = readVerdict(res);
    return decisionFor(c, Date.now(), v, v ? undefined : 'Clef gave no usable answer');
  } catch (err) {
    return decisionFor(c, Date.now(), null, `Clef failed: ${clip(err instanceof Error ? err.message : String(err), 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Where the table lives: `update` runs `fn` on it (expired leases dropped), one at a time, and saves what it leaves. */
export interface TableStore {
  update<T>(fn: (t: Table, now: number) => T): Promise<T>;
}

export interface JudgedOpts extends Pick<ClaimOpts, 'force' | 'keepBlocks' | 'staleMs'> {
  judge: Judge | null;
  budgetMs?: number;
  /** Why there's no verdict when `judge` is null. */
  noJudge?: string;
}

/**
 * Claim, asking Clef about gray-zone cases: claim once; if some cases need a verdict, ask (in parallel, within the
 * budget), then claim again with the verdicts. The table may have changed in between; cases that are new by then get
 * the safe default.
 */
export async function claimJudged(store: TableStore, holder: Holder, req: ClaimRequest, opts: JudgedOpts): Promise<ClaimResult> {
  const base: ClaimOpts = { force: opts.force, keepBlocks: opts.keepBlocks, staleMs: opts.staleMs };
  const first = await store.update((t, now) => claimIn(t, holder, req, now, base));
  if (!first.gray?.length) return first;
  const cases = [...new Map(first.gray.map((c) => [c.key, c])).values()];
  const decided = await Promise.all(cases.map((c) => judgeCase(c, opts.judge, opts.budgetMs, opts.noJudge)));
  const verdicts = Object.fromEntries(cases.map((c, i) => [c.key, decided[i]!]));
  return store.update((t, now) => claimIn(t, holder, req, now, { ...base, verdicts, final: true }));
}
