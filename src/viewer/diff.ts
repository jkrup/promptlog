// Unified diff (git diff output) -> structured files -> HTML. Pure (no Node APIs).
import { html, plural, type Safe } from './html.ts';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'A' | 'D' | 'M' | 'R' | 'C';
  binary: boolean;
  modeChange?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function unquote(p: string): string {
  const q = /^"(.*)"$/.exec(p);
  const s = q ? q[1]!.replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n') : p;
  return s.replace(/\t$/, '').replace(/^[ab]\//, '');
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', status: 'M', binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'A';
      else if (line.startsWith('deleted file mode')) file.status = 'D';
      else if (line.startsWith('rename from ')) {
        file.status = 'R';
        file.oldPath = unquote(line.slice(12));
      }
      else if (line.startsWith('rename to ')) file.newPath = unquote(line.slice(10));
      else if (line.startsWith('copy from ')) {
        file.status = 'C';
        file.oldPath = unquote(line.slice(10));
      }
      else if (line.startsWith('copy to ')) file.newPath = unquote(line.slice(8));
      else if (line.startsWith('old mode ')) file.modeChange = line.slice(9);
      else if (line.startsWith('new mode ')) file.modeChange = `${file.modeChange ?? ''} → ${line.slice(9)}`;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = unquote(line.slice(4));
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.newPath = unquote(line.slice(4));
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === '+') {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (c === '-') {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (c === ' ') {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === '\\') {
      hunk.lines.push({ type: 'meta', text: line });
    }
  }
  return files;
}

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
