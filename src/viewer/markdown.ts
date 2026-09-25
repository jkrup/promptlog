// Minimal, safe Markdown -> HTML for AI replies. Pure (no Node APIs).
// Safety model: every piece of source text is HTML-escaped before any tag is added, tags come only from
// this file, and link targets must pass safeUrl(). Unsupported syntax degrades to escaped text.
import { escapeHtml, raw, safeUrl, type Safe } from './html.ts';

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^\s{0,3}>/;

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next));
}

export function renderMarkdown(src: string): Safe {
  return raw(blocks(src.replace(/\r\n?/g, '\n').split('\n')));
}

function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < n && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of input)
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : '';
      out.push(`<pre class="code"${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Math.min(6, h[1]!.length + 2); // replies live inside a page; keep headings subordinate
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < n && QUOTE_RE.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const rows: string[] = [line];
      const sep = lines[i + 1]!;
      i += 2;
      while (i < n && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(lines[i++]!);
      out.push(table(rows, sep));
      continue;
    }

    if (LIST_RE.test(line)) {
      const block: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (LIST_RE.test(l) || /^\s+\S/.test(l)) {
          block.push(l);
          i++;
          continue;
        }
        if (!l.trim()) {
          let j = i + 1;
          while (j < n && !lines[j]!.trim()) j++;
          if (j < n && (LIST_RE.test(lines[j]!) || /^\s{2,}\S/.test(lines[j]!))) {
            block.push(...lines.slice(i, j));
            i = j;
            continue;
          }
          break;
        }
        // Lazy continuation: a plain line directly under an item belongs to it.
        if (block.length && block[block.length - 1]!.trim() && !startsBlock(l, lines[i + 1])) {
          block.push(l);
          i++;
          continue;
        }
        break;
      }
      out.push(list(block));
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < n && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) para.push(lines[i++]!);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

function list(block: string[]): string {
  interface Item {
    indent: number;
    tag: 'ul' | 'ol';
    start: number;
    contentIndent: number;
    lines: string[];
  }
  const items: Item[] = [];
  for (const l of block) {
    const m = LIST_RE.exec(l);
    // An indented list marker nests; a continuation line is appended to the current item.
    if (m) {
      const ordered = /\d/.test(m[2]!);
      items.push({ indent: m[1]!.length, tag: ordered ? 'ol' : 'ul', start: ordered ? parseInt(m[2]!, 10) : 1, contentIndent: m[0].length - m[3]!.length, lines: [m[3]!] });
    } else if (items.length) {
      const it = items[items.length - 1]!;
      items[items.length - 1]!.lines.push(l.replace(new RegExp(`^ {0,${it.contentIndent}}`), ''));
    }
  }
  let out = '';
  const stack: { indent: number; tag: 'ul' | 'ol' }[] = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1]!.indent) out += `</li></${stack.pop()!.tag}>`;
    const top = stack[stack.length - 1];
    const open = `<${it.tag}${it.tag === 'ol' && it.start !== 1 ? ` start="${it.start}"` : ''}>`;
    if (!top || it.indent > top.indent) {
      out += open;
      stack.push({ indent: it.indent, tag: it.tag });
    } else if (top.tag !== it.tag) {
      out += `</li></${top.tag}>${open}`;
      top.tag = it.tag;
    } else {
      out += '</li>';
    }
    const body = it.lines.length > 1 && it.lines.some((l) => !l.trim() || FENCE_RE.test(l)) ? blocks(it.lines) : inline(it.lines.join('\n')).replace(/\n/g, '<br>');
    out += `<li>${body}`;
  }
  while (stack.length) out += `</li></${stack.pop()!.tag}>`;
  return out;
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(rows: string[], sep: string): string {
  const aligns = cells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const td = (tag: 'th' | 'td', c: string, i: number) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c)}</${tag}>`;
  const [head, ...body] = rows;
  const thead = `<thead><tr>${cells(head!).map((c, i) => td('th', c, i)).join('')}</tr></thead>`;
  const tbody = body.length ? `<tbody>${body.map((r) => `<tr>${cells(r).map((c, i) => td('td', c, i)).join('')}</tr>`).join('')}</tbody>` : '';
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

/** Inline markdown: code spans, links, autolinks, bold, italic, strikethrough. Returns an HTML string. */
export function inline(text: string): string {
  // Placeholders (\u0001<n>\u0002) protect already-rendered fragments from later passes.
  const tokens: string[] = [];
  const tok = (h: string) => `\u0001${tokens.push(h) - 1}\u0002`;
  let s = text.replace(/[\u0000-\u0002]/g, '');
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => tok(`<code>${escapeHtml(code.replace(/^ ([\s\S]*\S[\s\S]*) $/, '$1'))}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const u = safeUrl(url);
    return u ? tok(`<a href="${u}"${/^https?:/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`) : m;
  });
  s = s.replace(/(^|[^\w"'=/])(https?:\/\/[^\s<\u0001]+)/g, (_m, pre: string, url: string) => {
    const trail = /(?:[.,;:!?)\]]|&quot;|&#39;|&gt;)+$/.exec(url)?.[0] ?? '';
    const u = trail ? url.slice(0, -trail.length) : url;
    return `${pre}${tok(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)}${trail}`;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  for (let pass = 0; pass < 4 && s.includes('\u0001'); pass++) s = s.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => tokens[Number(i)] ?? '');
  return s;
}

/** Plain-text preview of markdown (first line-ish), for one-line summaries. */
export function plainPreview(src: string, max = 160): string {
  const text = src
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
