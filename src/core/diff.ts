// Unified diff (git diff output) -> structured files. Pure, shared by core (attribution) and the viewer.

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
