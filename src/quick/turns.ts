// How a turn is shown to the quick-ask models: a compact card for Jev (it does best with small, focused state)
// and fuller evidence for Gemini (prompt, every AI reply, tools, and the turn's code diff).
import { gitMaybe } from '../core/git.ts';
import type { Turn } from '../core/types.ts';
import { clipEnd, clipMiddle, toolSummary, truncateDiff } from '../summarize/render.ts';
import type { TurnNote } from './types.ts';

export const oneLine = (s: string, max: number) => clipEnd(s.replace(/\s+/g, ' ').trim(), max);

export function aiTexts(t: Turn): string[] {
  return t.items.flatMap((i) => (i.kind === 'text' && i.text.trim() ? [i.text.trim()] : []));
}

/** One line per main-thread tool call, capped at `max` lines. */
export function toolLines(t: Turn, max: number): string[] {
  const lines = t.items.flatMap((i) => (i.kind === 'tool' && !i.sidechain ? [clipEnd(toolSummary(i.name, i.input), 200) + (i.isError ? ' (failed)' : '')] : []));
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
}

export function fileLines(t: Turn, max: number): string[] {
  const lines = (t.meta?.filesChanged ?? []).map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} +${f.additions}/-${f.deletions}`);
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
}

/** Jev's view of a turn. Descriptive keys, since Jev reads literally. */
export function turnCard(t: Turn, note?: TurnNote): Record<string, unknown> {
  return {
    ...(t.from ? { message_from_session: t.from } : {}),
    human_prompt: clipMiddle(t.prompt, 1500),
    ai_final_reply: clipMiddle(t.finalResponse ?? '', 1500),
    tools_used: toolLines(t, 15),
    files_changed: fileLines(t, 30),
    ...(note ? { summary: { what_the_ai_did: note.did, decisions: note.decided, deferred_or_skipped: note.deferred } } : {}),
  };
}

/** The code the agent changed during the turn (its before/after snapshots), or '' when unknown. */
export function turnDiff(cwd: string, t: Turn): string {
  const m = t.meta;
  if (!m?.stateBefore || !m?.stateAfter || m.stateBefore === m.stateAfter) return '';
  return gitMaybe(['diff', '--no-color', '-M', m.stateBefore, m.stateAfter], { cwd }) ?? '';
}

/** Gemini's view of a turn picked as evidence. */
export function turnEvidence(label: string, t: Turn, note: TurnNote | undefined, diff: string, diffTokens = 2500): string {
  const out = [`### ${label}${t.timestamp ? ` (${t.timestamp.slice(0, 16).replace('T', ' ')})` : ''}`, '', t.from ? `Message from another Claude session (${t.from}):` : 'Human prompt:', clipMiddle(t.prompt, 4000), ''];
  const texts = aiTexts(t);
  if (texts.length) out.push('AI replies, in order:', clipMiddle(texts.join('\n\n'), 6000), '');
  const tools = toolLines(t, 30);
  if (tools.length) out.push('Tools used:', ...tools.map((l) => `- ${l}`), '');
  const files = fileLines(t, 40);
  if (files.length) out.push('Files changed:', ...files.map((l) => `- ${l}`), '');
  if (note) {
    out.push(`Map note: ${note.did}`);
    if (note.decided.length) out.push(`Decided: ${note.decided.join('; ')}`);
    if (note.deferred.length) out.push(`Deferred or skipped: ${note.deferred.join('; ')}`);
    out.push('');
  }
  const d = truncateDiff(diff, diffTokens);
  if (d.trim()) out.push('Code diff for this turn:', '```diff', d.trimEnd(), '```', '');
  return out.join('\n');
}
