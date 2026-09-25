// ReviewSummary -> Markdown, ordered by reviewer signal: risks, pushbacks, open loops and plan-vs-diff misses
// come before the recap. Turn references look like `A2` (session A, turn 2) with a legend at the bottom.
import type { ReviewSummary } from '../core/types.ts';

export interface MarkdownOptions {
  /** Heading text; defaults to "Review summary". */
  title?: string;
  /** sessionId -> title, for the legend. */
  sessionTitles?: Record<string, string>;
}

/** Session labels by order of first appearance (timeline is sorted by slice order, so this matches the model's labels). */
export function summaryLabels(s: ReviewSummary): Map<string, string> {
  const labels = new Map<string, string>();
  const name = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : name(Math.floor(i / 26) - 1) + name(i % 26));
  const seen = [
    ...s.timeline.map((x) => x.sessionId),
    ...s.pushbacks.map((x) => x.sessionId),
    ...s.decisions.map((x) => x.sessionId),
    ...s.openLoops.map((x) => x.sessionId),
    ...s.planVsDiff.map((x) => x.sessionId),
    ...s.riskFlags.flatMap((x) => (x.sessionId ? [x.sessionId] : [])),
  ];
  for (const id of seen) if (!labels.has(id)) labels.set(id, name(labels.size));
  return labels;
}

const STATUS_ORDER = { missing: 0, partial: 1, unclear: 2, done: 3 } as const;

export function renderSummaryMarkdown(s: ReviewSummary, opts: MarkdownOptions = {}): string {
  const labels = summaryLabels(s);
  const ref = (sessionId?: string, turn?: number) => (sessionId && turn ? `**${labels.get(sessionId) ?? sessionId.slice(0, 8)}${turn}**` : '');
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(`### ${title}`, '', ...lines, '');
  };

  out.push(`## ${opts.title ?? 'Review summary'}`, '');
  if (s.intent) out.push(`**Intent.** ${s.intent}`, '');
  if (s.approach) out.push(`**Approach.** ${s.approach}`, '');

  section(
    'Risk flags',
    s.riskFlags.map((r) => `- **${r.severity.toUpperCase()}** ${r.note}${r.sessionId && r.turn ? ` (${ref(r.sessionId, r.turn)})` : ''}`),
  );
  section(
    'Pushbacks',
    s.pushbacks.map((p) => `- ${ref(p.sessionId, p.turn)} Human: ${p.humanSaid}${p.aiChanged ? `\n  AI changed: ${p.aiChanged}` : ''}`),
  );
  section(
    'Open loops',
    s.openLoops.map((o) => `- ${ref(o.sessionId, o.turn)} ${o.item}`),
  );
  const plan = [...s.planVsDiff].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  section(
    'Plan vs diff',
    plan.map((p) => `- ${ref(p.sessionId, p.turn)} \`${p.status}\` ${p.claim}${p.evidence ? ` (${p.evidence})` : ''}`),
  );
  section(
    'Decisions',
    s.decisions.map(
      (d) =>
        `- ${ref(d.sessionId, d.turn)} ${d.decision}${d.rationale ? `. Why: ${d.rationale}` : ''}${d.alternatives?.length ? `. Alternatives: ${d.alternatives.join('; ')}` : ''}`,
    ),
  );
  section('Assumptions', s.assumptions.map((a) => `- ${a}`));
  section('Timeline', s.timeline.map((t) => `- ${ref(t.sessionId, t.turn)} ${t.gist}`));

  const legend = [...labels].map(([id, l]) => `${l} = session ${id.slice(0, 8)}${opts.sessionTitles?.[id] ? ` "${opts.sessionTitles[id]}"` : ''}`);
  const prov = [s.model ? `model ${s.model}` : '', `prompt v${s.promptVersion}`, `generated ${s.generatedAt.slice(0, 16).replace('T', ' ')}Z`].filter(Boolean);
  out.push(`<sub>${[...legend, ...prov].join(' · ')}</sub>`, '');
  return out.join('\n');
}
