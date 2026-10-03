// Unified diff (git diff output) -> structured files -> HTML. Pure (no Node APIs).
import { html, plural, type Safe } from './html.ts';

export type { DiffFile, DiffHunk, DiffLine } from '../core/diff.ts';
export { parseDiff } from '../core/diff.ts';
import { parseDiff, type DiffFile } from '../core/diff.ts';

/** A multi-file diff split per file, keyed by the new path (old path for deletions). */
export function splitDiffText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue;
    const f = parseDiff(part)[0];
    if (f) out.set(f.status === 'D' ? f.oldPath : f.newPath, part);
  }
  return out;
}

export function diffStats(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  return files.reduce((a, f) => ({ files: a.files + 1, additions: a.additions + f.additions, deletions: a.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 });
}

export function statusBadge(status: string): Safe {
  const label: Record<string, string> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed' };
  return html`<span class="st st-${status}" title="${label[status] ?? status}">${status}</span>`;
}

export function counts(additions: number, deletions: number): Safe {
  return html`<span class="num"><span class="plus">+${additions}</span> <span class="minus">−${deletions}</span></span>`;
}

const LARGE_FILE_LINES = 400;

function renderFile(f: DiffFile): Safe {
  const path = f.status === 'R' || f.status === 'C' ? html`${f.oldPath} <span class="arrow">→</span> ${f.newPath}` : html`${f.status === 'D' ? f.oldPath : f.newPath}`;
  const lineCount = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  const body = f.binary
    ? html`<div class="diff-note">Binary file</div>`
    : f.hunks.length === 0
      ? html`<div class="diff-note">${f.modeChange ? `Mode change ${f.modeChange}` : 'No textual changes'}</div>`
      : html`<table class="diff-table">${f.hunks.map(
          (h) => html`<tbody><tr class="hunk"><td class="ln" colspan="2"></td><td class="code">${h.header}</td></tr>${h.lines.map(
            (l) =>
              html`<tr class="${l.type}"><td class="ln" data-n="${l.oldNo ?? ''}"></td><td class="ln" data-n="${l.newNo ?? ''}"></td><td class="code">${l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'ctx' ? ' ' : ''}${l.text}</td></tr>`,
          )}</tbody>`,
        )}</table>`;
  return html`<details class="diff-file"${lineCount <= LARGE_FILE_LINES ? ' open' : ''}>
<summary>${statusBadge(f.status)}<span class="path">${path}</span>${counts(f.additions, f.deletions)}${lineCount > LARGE_FILE_LINES ? html`<span class="muted small">large diff, click to expand</span>` : ''}</summary>
${body}
</details>`;
}

/** Render a whole git diff: a file list header plus one collapsible block per file. */
export function renderDiff(text: string, opts: { emptyText?: string; truncated?: boolean } = {}): Safe {
  const files = parseDiff(text);
  if (files.length === 0) return html`<div class="empty-note">${opts.emptyText ?? 'No changes.'}</div>`;
  const st = diffStats(files);
  return html`<div class="diff">
<div class="diff-summary">${plural(st.files, 'file')} changed ${counts(st.additions, st.deletions)}${opts.truncated ? html` <span class="warn-text">Diff truncated, run <code>git diff</code> for the rest.</span>` : ''}</div>
${files.map(renderFile)}
</div>`;
}
