// The model's structured output and its conversion to the ReviewSummary contract (src/core/types.ts).
// The model refers to sessions by short labels (A, B, …) from the rendering; we map them back to session ids.
import type { ReviewSummary } from '../core/types.ts';

type Json = Record<string, unknown>;

const turnRef = (labels: string[]) => ({
  session: { type: 'string', enum: labels, description: 'Session label from the material, e.g. "A".' },
  turn: { type: 'integer', minimum: 1, description: 'Turn number within that session.' },
});

const arr = (props: Json, required: string[]): Json => ({
  type: 'array',
  items: { type: 'object', additionalProperties: false, properties: props, required },
});

/** JSON schema for `claude --json-schema`. `labels` are the session labels present in the material. */
export function outputSchema(labels: string[]): Json {
  const ref = turnRef(labels.length ? labels : ['A']);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'approach', 'timeline', 'decisions', 'pushbacks', 'openLoops', 'assumptions', 'planVsDiff', 'riskFlags'],
    properties: {
      intent: { type: 'string' },
      approach: { type: 'string' },
      timeline: arr({ ...ref, gist: { type: 'string' } }, ['session', 'turn', 'gist']),
      decisions: arr(
        { ...ref, decision: { type: 'string' }, rationale: { type: 'string' }, alternatives: { type: 'array', items: { type: 'string' } } },
        ['session', 'turn', 'decision'],
      ),
      pushbacks: arr({ ...ref, humanSaid: { type: 'string' }, aiChanged: { type: 'string' } }, ['session', 'turn', 'humanSaid', 'aiChanged']),
      openLoops: arr({ ...ref, item: { type: 'string' } }, ['session', 'turn', 'item']),
      assumptions: { type: 'array', items: { type: 'string' } },
      planVsDiff: arr(
        { ...ref, claim: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'missing', 'unclear'] }, evidence: { type: 'string' } },
        ['session', 'turn', 'claim', 'status', 'evidence'],
      ),
      riskFlags: arr(
        { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, note: { type: 'string' }, ...ref },
        ['severity', 'note'],
      ),
    },
  };
}

export interface ConvertMeta {
  /** label -> sessionId */
  sessions: Map<string, string>;
  /** sessionId -> turn numbers present in the review slice */
  turns: Map<string, number[]>;
  generatedAt: string;
  model?: string;
  promptVersion: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v)).trim();
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object') : []);
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Validate and convert raw model output. Tolerant: drops malformed entries instead of failing, maps labels to
 * session ids, and snaps turn numbers that fall outside the slice to the nearest turn that exists.
 */
export function toReviewSummary(raw: unknown, meta: ConvertMeta): ReviewSummary {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Json;
  const firstSession = [...meta.sessions.values()][0] ?? '';
  const order = [...meta.sessions.values()];

  const resolve = (e: Json): { sessionId: string; turn: number } | null => {
    const label = s(e.session ?? e.sessionId);
    const sessionId = meta.sessions.get(label) ?? (order.includes(label) ? label : meta.sessions.size === 1 ? firstSession : '');
    if (!sessionId) return null;
    const n = Math.round(Number(e.turn));
    const valid = meta.turns.get(sessionId) ?? [];
    if (!valid.length) return Number.isFinite(n) && n > 0 ? { sessionId, turn: n } : null;
    if (valid.includes(n)) return { sessionId, turn: n };
    if (!Number.isFinite(n)) return null;
    const nearest = valid.reduce((best, t) => (Math.abs(t - n) < Math.abs(best - n) ? t : best), valid[0]!);
    return { sessionId, turn: nearest };
  };
  const byTurn = <T extends { sessionId: string; turn: number }>(a: T, b: T) =>
    order.indexOf(a.sessionId) - order.indexOf(b.sessionId) || a.turn - b.turn;

  const timeline = list(o.timeline)
    .map((e) => {
      const r = resolve(e);
      const gist = s(e.gist);
      return r && gist ? { ...r, gist } : null;
    })
    .filter((x) => x !== null)
    .sort(byTurn);

  const decisions = list(o.decisions)
    .map((e) => {
      const r = resolve(e);
      const decision = s(e.decision);
      if (!r || !decision) return null;
      const rationale = s(e.rationale);
      const alternatives = Array.isArray(e.alternatives) ? e.alternatives.map(s).filter(Boolean) : [];
      return { ...r, decision, ...(rationale ? { rationale } : {}), ...(alternatives.length ? { alternatives } : {}) };
    })
    .filter((x) => x !== null);

  const pushbacks = list(o.pushbacks)
    .map((e) => {
      const r = resolve(e);
      const humanSaid = s(e.humanSaid);
      return r && humanSaid ? { ...r, humanSaid, aiChanged: s(e.aiChanged) } : null;
    })
    .filter((x) => x !== null)
    .sort(byTurn);

  const openLoops = list(o.openLoops)
    .map((e) => {
      const r = resolve(e);
      const item = s(e.item);
      return r && item ? { ...r, item } : null;
    })
    .filter((x) => x !== null);

  const STATUSES = ['done', 'partial', 'missing', 'unclear'] as const;
  const planVsDiff = list(o.planVsDiff)
    .map((e) => {
      const r = resolve(e);
      const claim = s(e.claim);
      if (!r || !claim) return null;
      const st = s(e.status) as (typeof STATUSES)[number];
      return { ...r, claim, status: STATUSES.includes(st) ? st : ('unclear' as const), evidence: s(e.evidence) };
    })
    .filter((x) => x !== null);

  const riskFlags = list(o.riskFlags)
    .map((e) => {
      const note = s(e.note);
      if (!note) return null;
      const sev = s(e.severity) as keyof typeof SEVERITY_ORDER;
      const severity = sev in SEVERITY_ORDER ? sev : ('medium' as const);
      const r = e.session != null || e.sessionId != null ? resolve(e) : null;
      return { severity, note, ...(r ? { sessionId: r.sessionId, turn: r.turn } : {}) };
    })
    .filter((x) => x !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    intent: s(o.intent),
    approach: s(o.approach),
    timeline,
    decisions,
    pushbacks,
    openLoops,
    assumptions: Array.isArray(o.assumptions) ? o.assumptions.map(s).filter(Boolean) : [],
    planVsDiff,
    riskFlags,
    generatedAt: meta.generatedAt,
    ...(meta.model ? { model: meta.model } : {}),
    promptVersion: meta.promptVersion,
  };
}

/** Pull the JSON object out of a text reply (fallback when structured output is missing). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!);
    } catch {
      // fall through
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return null;
}
