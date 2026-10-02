// "Did it change it everywhere?" without a model: names the work took out of the code (env vars like
// TYPESAFE_API_KEY, hosts like api.typesafe.ai), then `git grep` for each one in the code as it ended up.
// Hits are places the change may have missed; no hits means it's gone everywhere.
import { repoRedactor } from '../capture/redact.ts';
import type { Leftover } from '../core/types.ts';
import { grepAt } from './codesearch.ts';

export type { Leftover } from '../core/types.ts';

const ENV = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

const count = (lines: string[], name: string) => lines.reduce((n, l) => n + l.split(name).length - 1, 0);

/**
 * Env-var-style names and URL hosts that appear more often on removed lines than on added ones, with the files
 * they were taken out of. Most-removed first, at most `max`.
 */
export function removedNames(diff: string, max = 6): { name: string; removedFrom: string[] }[] {
  const removed: { path: string; text: string }[] = [];
  const added: string[] = [];
  let path = '';
  for (const l of diff.split('\n')) {
    const m = /^diff --git a\/.* b\/(.*)$/.exec(l);
    if (m) path = m[1]!;
    else if (l.startsWith('---') || l.startsWith('+++')) continue;
    else if (l.startsWith('-')) removed.push({ path, text: l.slice(1) });
    else if (l.startsWith('+')) added.push(l.slice(1));
  }
  const names = new Set<string>();
  for (const { text } of removed) {
    for (const m of text.matchAll(ENV)) if (m[0].length >= 6) names.add(m[0]);
    for (const m of text.matchAll(URL_HOST)) names.add(m[1]!.toLowerCase());
  }
  const out: { name: string; removedFrom: string[]; n: number }[] = [];
  const removedText = removed.map((r) => r.text);
  for (const name of names) {
    const n = count(removedText, name);
    if (n <= count(added, name)) continue;
    out.push({ name, removedFrom: [...new Set(removed.filter((r) => r.text.includes(name)).map((r) => r.path))], n });
  }
  return out
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(({ name, removedFrom }) => ({ name, removedFrom }));
}

/** New-side line numbers of the lines the diff added, per file. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let path = '';
  let n = 0;
  for (const l of diff.split('\n')) {
    const f = /^diff --git a\/.* b\/(.*)$/.exec(l);
    if (f) path = f[1]!;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) n = Number(h[1]);
    else if (l.startsWith('+++') || l.startsWith('---') || !n) continue;
    else if (l.startsWith('+')) {
      out.set(path, (out.get(path) ?? new Set()).add(n));
      n++;
    } else if (!l.startsWith('-') && !l.startsWith('\\')) n++;
  }
  return out;
}

/**
 * Each removed name, and where `rev` (the PR head or the session's last snapshot) still has it. Lines the change
 * wrote itself are marked `wrote` and listed last: the ones it never touched are the possible misses.
 * Hit text goes through the capture redactor, so a key left in the code isn't shown in full.
 */
export function findLeftovers(cwd: string, diff: string, rev: string | undefined): Leftover[] {
  if (!rev) return [];
  const names = removedNames(diff);
  if (!names.length) return [];
  const wrote = addedLines(diff);
  const redact = repoRedactor(cwd);
  return names.map(({ name, removedFrom }) => {
    const r = grepAt(cwd, rev, { text: name, regex: false }, 8);
    const stillIn = r.hits
      .map((h) => ({ ...h, text: redact(h.text), wrote: wrote.get(h.path)?.has(h.line) ?? false }))
      .sort((a, b) => Number(a.wrote) - Number(b.wrote));
    return { name, removedFrom, stillIn, more: r.total - r.hits.length };
  });
}
