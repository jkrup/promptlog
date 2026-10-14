// Blocks of code: what a lease covers when we know where an edit lands. The block around an edit is the top-level
// declaration it falls in (function, class, const, ...), or the method or field inside a class. Found with two small,
// language-agnostic heuristics: bracket matching for C-like files (JS/TS, Go, Rust, Java, C, CSS, ...) and indentation
// for Python. Anything else (or an edit between declarations) gets the edited lines ±5.
// No Node imports: the Cloudflare Worker bundles this file (through lease-table.ts).

export interface Block {
  /** What to call it: "getRates()", "class Bridge", "Bridge.connect()", "RATES". Absent for a plain range of lines. */
  name?: string;
  /** First and last line, 1-based, inclusive. Leading comments and decorators are part of the block. */
  start: number;
  end: number;
  /** The text of the block's declaration line, trimmed: how the block is found again after lines move. */
  anchor: string;
  /** The line the anchor is on. */
  anchorLine: number;
}

interface Outlined extends Block {
  members?: Block[];
}

/** Lines around an edit when it isn't inside a block. */
export const FALLBACK_LINES = 5;

const BRACE_EXT = new Set('js mjs cjs jsx ts mts cts tsx java kt kts scala groovy c h cc cpp cxx hpp hh m mm cs go rs swift php dart css scss less'.split(' '));
const PY_EXT = new Set(['py', 'pyi']);

export function blockLanguage(path: string): 'brace' | 'python' | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return BRACE_EXT.has(ext) ? 'brace' : PY_EXT.has(ext) ? 'python' : null;
}

export const splitLines = (text: string) => text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

/** How a block is called in messages. */
export const describeBlock = (b: Block) => b.name ?? `lines ${b.start}-${b.end}`;

// ---------------------------------------------------------------------------
// Per-line facts
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  /** Open brackets at the start of the line. */
  depth: number;
  /** The line starts inside a block comment or a multi-line string. */
  inside: boolean;
  /** Has code outside comments. */
  code: boolean;
  indent: number;
}

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0].replace(/\t/g, '    ').length;

/** Index after a one-line string literal that opens at `k`. */
function skipString(s: string, k: number, q: string): number {
  for (let i = k + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q) return i;
  }
  return s.length;
}

/** C-like files: brackets, // and /* comments, '…' "…" and `…${…}…` strings. Regex literals are not understood. */
function scanBrace(lines: string[]): Line[] {
  const stack: string[] = []; // '{' '(' '[' or '${' (inside a template string)
  let mode: 'code' | 'comment' | 'template' = 'code';
  return lines.map((text) => {
    const line: Line = { text, depth: stack.length, inside: mode !== 'code', code: false, indent: indentOf(text) };
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      const d = text[k + 1];
      if (mode === 'comment') {
        if (c === '*' && d === '/') {
          mode = 'code';
          k++;
        }
        continue;
      }
      if (mode === 'template') {
        if (c === '\\') k++;
        else if (c === '`') mode = 'code';
        else if (c === '$' && d === '{') {
          stack.push('${');
          mode = 'code';
          k++;
        }
        continue;
      }
      if (c === ' ' || c === '\t') continue;
      if (c === '/' && d === '/') break;
      if (c === '/' && d === '*') {
        mode = 'comment';
        k++;
        continue;
      }
      line.code = true;
      if (c === '\\') k++;
      else if (c === '"' || c === "'") k = skipString(text, k, c);
      else if (c === '`') mode = 'template';
      else if (c === '{' || c === '(' || c === '[') stack.push(c);
      else if ((c === '}' || c === ')' || c === ']') && stack.pop() === '${') mode = 'template';
    }
    return line;
  });
}

/** Python: brackets, # comments, one-line and triple-quoted strings. */
function scanPython(lines: string[]): Line[] {
  let depth = 0;
  let triple: string | null = null;
  return lines.map((text) => {
    const line: Line = { text, depth, inside: triple !== null, code: false, indent: indentOf(text) };
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      if (triple) {
        if (c === '\\') k++;
        else if (text.startsWith(triple, k)) {
          triple = null;
          k += 2;
        }
        continue;
      }
      if (c === ' ' || c === '\t') continue;
      if (c === '#') break;
      line.code = true;
      if (text.startsWith('"""', k) || text.startsWith("'''", k)) {
        triple = text.slice(k, k + 3);
        k += 2;
      } else if (c === '"' || c === "'") k = skipString(text, k, c);
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    return line;
  });
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

interface Seg {
  start: number;
  anchorLine: number;
  end: number;
}

/**
 * Split lines [from, to] (0-based) into statements that start where `atLevel` holds and run while `continues` does.
 * Comment lines and decorators right above a statement belong to it.
 */
function segment(ls: Line[], from: number, to: number, atLevel: (i: number) => boolean, continues: (j: number, s: number) => boolean): Seg[] {
  const segs: Seg[] = [];
  let lead = -1;
  for (let i = from; i <= to; ) {
    const l = ls[i]!;
    const t = l.text.trim();
    if (!t && !l.inside) {
      lead = -1;
      i++;
      continue;
    }
    if (l.inside || !l.code) {
      if (lead < 0) lead = i;
      i++;
      continue;
    }
    if (!atLevel(i) || /^[)\]}]/.test(t)) {
      lead = -1;
      i++;
      continue;
    }
    let j = i + 1;
    while (j <= to && continues(j, i)) j++;
    let end = j - 1;
    while (end > i && !ls[end]!.text.trim()) end--;
    if (t.startsWith('@')) {
      if (lead < 0) lead = i; // a decorator leads into the next statement
    } else {
      segs.push({ start: lead >= 0 ? lead : i, anchorLine: i, end });
      lead = -1;
    }
    i = j;
  }
  return segs;
}

const CONTINUATION = /^(?:[)\]}.?:,]|&&|\|\||\+|-|\*|=>|\|)/;

function braceSegments(ls: Line[], from: number, to: number, level: number): Seg[] {
  return segment(
    ls,
    from,
    to,
    (i) => ls[i]!.depth === level && !ls[i]!.inside,
    (j, s) => {
      const l = ls[j]!;
      if (l.depth > level || l.inside) return true;
      if (l.depth < level) return false;
      const t = l.text.trim();
      return !!t && (CONTINUATION.test(t) || l.indent > ls[s]!.indent);
    },
  );
}

function pythonSegments(ls: Line[], from: number, to: number, indent: number): Seg[] {
  const deeper = (k: number) => ls[k]!.depth > 0 || ls[k]!.inside || ls[k]!.indent > indent;
  return segment(
    ls,
    from,
    to,
    (i) => ls[i]!.depth === 0 && !ls[i]!.inside && ls[i]!.indent === indent,
    (j) => {
      const l = ls[j]!;
      if (!l.text.trim() && !l.inside) {
        let k = j + 1;
        while (k <= to && !ls[k]!.text.trim() && !ls[k]!.inside) k++;
        return k <= to && deeper(k);
      }
      return deeper(j) || /^(?:else|elif|except|finally)\b/.test(l.text.trim());
    },
  );
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'new', 'await', 'throw', 'typeof', 'sizeof', 'do', 'try', 'with', 'yield', 'delete', 'case']);
const MODS = '(?:(?:export|default|declare|abstract|public|private|protected|internal|static|final|sealed|partial|open|data|inline)\\s+)*';

type Namer = [RegExp, (m: RegExpExecArray) => string | null];
const BRACE_NAMES: Namer[] = [
  [new RegExp(`^${MODS}(?:async\\s+)?function\\b\\s*\\*?\\s*([\\w$]+)`), (m) => `${m[1]}()`],
  [new RegExp(`^${MODS}class\\s+([\\w$]+)`), (m) => `class ${m[1]}`],
  [/^export\s+default\b/, () => 'export default'],
  [/^module\.exports\b/, () => 'module.exports'],
  [/^(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace|struct|object|trait)\s+([\w$.]+)/, (m) => `${m[1]} ${m[2]}`],
  [/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)\b[^=]*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>)/, (m) => `${m[1]}()`],
  [/^(?:export\s+)?(?:declare\s+)?(?:const|let|var|val)\s+([\w$]+)/, (m) => m[1]!],
  [/^func\s+\(\s*\w+\s+\*?(\w+)[^)]*\)\s*(\w+)/, (m) => `${m[1]}.${m[2]}()`],
  [/^(?:func|fun|def)\s+(\w+)/, (m) => `${m[1]}()`],
  [/^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, (m) => `${m[1]}()`],
  [/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|union)\s+(\w+)/, (m) => `${m[1]} ${m[2]}`],
  [/^impl\b(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w:]+)/, (m) => `impl ${m[1]}`],
  // C, Java, C#: a signature with a return type, not ending in ";".
  [/^(?:[\w$<>[\],.?*&:]+\s+)+?\**([A-Za-z_$][\w$]*)\s*\([^;]*$/, (m) => (NOT_A_NAME.has(m[1]!) || /^(?:return|new|await|throw|else)\b/.test(m[0]) ? null : `${m[1]}()`)],
  // Calls such as test("…", () => {…}) or app.get("/rates", …).
  [/^([\w$.]+)\s*\(\s*(['"`])([^'"`]{1,80})\2/, (m) => (NOT_A_NAME.has(m[1]!) ? null : `${m[1]}("${clip(m[3]!, 40)}")`)],
  [/^([\w$.]+)\s*\(/, (m) => (NOT_A_NAME.has(m[1]!) ? null : `${m[1]}()`)],
];

const MEMBER_NAMES: Namer[] = [
  [/^(?:(?:public|private|protected|internal|static|async|readonly|override|abstract|declare|final|virtual|get|set)\s+)*\*?\s*(#?[\w$]+)\s*(?:<[^>]*>)?\s*\(/, (m) => (NOT_A_NAME.has(m[1]!) ? null : `${m[1]}()`)],
  [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, (m) => `${m[1]}()`],
  [/^(?:[\w$<>[\],.?*&:]+\s+)+?\**([A-Za-z_$][\w$]*)\s*\([^;]*$/, (m) => (NOT_A_NAME.has(m[1]!) ? null : `${m[1]}()`)],
  [/^(?:(?:public|private|protected|internal|static|readonly|override|declare|final)\s+)*(#?[\w$]+)\s*[?!]?\s*[:=;]/, (m) => m[1]!],
];

const PY_NAMES: Namer[] = [
  [/^(?:async\s+)?def\s+(\w+)/, (m) => `${m[1]}()`],
  [/^class\s+(\w+)/, (m) => `class ${m[1]}`],
  [/^if\s+__name__\s*==/, () => 'if __name__ == "__main__"'],
  [/^(\w+)\s*(?::[^=]+)?=(?!=)/, (m) => m[1]!],
];

function nameOf(anchor: string, namers: Namer[]): string | undefined {
  for (const [re, f] of namers) {
    const m = re.exec(anchor);
    const n = m && f(m);
    if (n) return n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

/** A file's top-level blocks, with the members of each class. Null for languages we don't know. */
export function outline(path: string, text: string): Outlined[] | null {
  const lang = blockLanguage(path);
  if (!lang) return null;
  const lines = splitLines(text);
  const ls = lang === 'brace' ? scanBrace(lines) : scanPython(lines);
  const last = ls.length - 1;
  const css = /\.(?:css|scss|less)$/i.test(path);
  const block = (s: Seg, name: string | undefined): Block => ({
    ...(name ? { name } : {}),
    start: s.start + 1,
    end: s.end + 1,
    anchor: lines[s.anchorLine]!.trim(),
    anchorLine: s.anchorLine + 1,
  });
  const top = lang === 'brace' ? braceSegments(ls, 0, last, 0) : pythonSegments(ls, 0, last, 0);
  return top.map((s) => {
    const anchor = lines[s.anchorLine]!.trim();
    const name = css ? clip(anchor.replace(/\s*\{.*$/, ''), 60) || undefined : nameOf(anchor, lang === 'brace' ? BRACE_NAMES : PY_NAMES);
    const b: Outlined = block(s, name);
    const cls = name && /^(?:class|impl) (.+)$/.exec(name)?.[1];
    if (cls && s.end > s.anchorLine) {
      let members: Seg[];
      if (lang === 'brace') {
        const close = /^[}\]]/.test(lines[s.end]!.trim()) ? s.end - 1 : s.end; // the class's closing brace
        members = braceSegments(ls, s.anchorLine + 1, close, ls[s.anchorLine]!.depth + 1);
      } else {
        const first = ls.findIndex((l, i) => i > s.anchorLine && i <= s.end && l.code && !l.inside);
        members = first > 0 ? pythonSegments(ls, s.anchorLine + 1, s.end, ls[first]!.indent) : [];
      }
      b.members = members.map((m) => {
        const n = nameOf(lines[m.anchorLine]!.trim(), lang === 'brace' ? MEMBER_NAMES : PY_NAMES);
        return block(m, n ? `${cls}.${n.replace(/^class /, '')}` : undefined);
      });
    }
    return b;
  });
}

/** The edited lines ±5, anchored on the first edited line that has text. */
function around(lines: string[], start: number, end: number): Block {
  const n = Math.max(1, lines.length);
  const s = Math.min(Math.max(1, start), n);
  const e = Math.min(Math.max(s, end), n);
  let a = s;
  while (a < e && !lines[a - 1]?.trim()) a++;
  return { start: Math.max(1, s - FALLBACK_LINES), end: Math.min(n, e + FALLBACK_LINES), anchor: (lines[a - 1] ?? '').trim(), anchorLine: a };
}

/**
 * The blocks an edit of lines [start, end] (1-based) touches: the top-level blocks it overlaps, or the class members
 * when it stays inside them. An edit outside every block (or in a language we don't know) gets its lines ±5.
 */
export function blocksFor(path: string, text: string, start: number, end: number, out: Outlined[] | null = outline(path, text)): Block[] {
  const hit = (b: Block) => b.start <= end && b.end >= start;
  const tops = (out ?? []).filter(hit);
  if (!tops.length) return [around(splitLines(text), start, end)];
  return tops.flatMap((b): Block[] => {
    const { members, ...top } = b;
    const m = (members ?? []).filter(hit);
    return m.length && Math.max(start, b.start) >= m[0]!.start && Math.min(end, b.end) <= m[m.length - 1]!.end ? m : [top];
  });
}

/**
 * Where `block` is now in `text`: found again by its anchor (the matching line nearest to where it was), then
 * re-measured. Unchanged when the anchor is gone (e.g. its first line was edited).
 */
export function relocate(block: Block, path: string, text: string, out: Outlined[] | null = outline(path, text)): Block {
  const lines = splitLines(text);
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== block.anchor) continue;
    if (found < 0 || Math.abs(i + 1 - block.anchorLine) < Math.abs(found - block.anchorLine)) found = i + 1;
  }
  if (found < 0) return block;
  if (block.name) {
    for (const b of out ?? []) {
      const { members, ...top } = b;
      if (top.anchorLine === found) return { ...top, name: block.name };
      const m = members?.find((x) => x.anchorLine === found);
      if (m) return { ...m, name: block.name };
    }
  }
  const delta = found - block.anchorLine;
  return { ...block, start: Math.max(1, block.start + delta), end: Math.max(1, block.end + delta), anchorLine: found };
}

/** Lines (1-based, inclusive) that `old` covers in `text`: the first match, or every match with `all`. Null if absent. */
export function editRanges(text: string, old: string, all = false): { start: number; end: number }[] | null {
  if (!old) return null;
  const out: { start: number; end: number }[] = [];
  const span = (old.match(/\n/g)?.length ?? 0) - (old.endsWith('\n') ? 1 : 0);
  for (let at = text.indexOf(old); at >= 0; at = all ? text.indexOf(old, at + old.length) : -1) {
    const start = (text.slice(0, at).match(/\n/g)?.length ?? 0) + 1;
    out.push({ start, end: start + Math.max(0, span) });
    if (out.length > 50) break;
  }
  return out.length ? out : null;
}

/** A block's current code, clipped to `max` characters. */
export function blockCode(text: string, b: Block, max = 1200): string {
  const code = splitLines(text).slice(b.start - 1, b.end).join('\n');
  return code.length > max ? code.slice(0, max) + '\n…' : code;
}
