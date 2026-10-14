// Blocks of code, the unit an Edit's lease covers: found by bracket matching (C-like files) or indentation (Python).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLanguage, blocksFor, editRanges, outline, relocate, type Block } from '../src/capture/blocks.ts';

const JS = `import express from 'express';

const app = express();
const RATES = { usd: 1, eur: 0.9 };

/** Rates for a currency. */
export async function getRates(cur) {
  const r = RATES[cur];
  const s = \`rate \${cur} is \${r ? \`\${r}\` : '}'} {\`;
  return { cur, r, s }; // a } in a comment
}

export const formatRates = (rates) =>
  Object.entries(rates)
    .map(([k, v]) => \`\${k}: \${v}\`)
    .join('\\n');

app.get('/rates', (req, res) => {
  res.json(getRates(req.query.cur));
});

/* a block comment { */
export class Cache extends Base {
  #store = new Map();
  @memo()
  get(k) {
    return this.#store.get(k);
  }

  set(k, v) {
    this.#store.set(k, v);
  }
}

app.listen(3000);
`;

const names = (bs: Block[] | null) => (bs ?? []).map((b) => `${b.name ?? '?'} ${b.start}-${b.end}`);

test('C-like files: top-level declarations by bracket matching, comments and decorators included', () => {
  const o = outline('src/server.js', JS)!;
  assert.deepEqual(names(o), ['? 1-1', 'app 3-3', 'RATES 4-4', 'getRates() 6-11', 'formatRates() 13-16', 'app.get("/rates") 18-20', 'class Cache 22-33', 'app.listen() 35-35']);
  const getRates = o[3]!;
  assert.equal(getRates.anchor, 'export async function getRates(cur) {');
  assert.equal(getRates.anchorLine, 7, 'the doc comment above belongs to the block, the anchor is the declaration');
  assert.deepEqual(names(o[6]!.members!), ['Cache.#store 24-24', 'Cache.get() 25-28', 'Cache.set() 30-32']);
});

test('the block around an edit: the declaration, or the class member it stays inside', () => {
  const at = (s: number, e = s) => names(blocksFor('src/server.js', JS, s, e));
  assert.deepEqual(at(9), ['getRates() 6-11']);
  assert.deepEqual(at(15), ['formatRates() 13-16']);
  assert.deepEqual(at(27), ['Cache.get() 25-28'], 'inside a method: just the method');
  assert.deepEqual(at(27, 31), ['Cache.get() 25-28', 'Cache.set() 30-32']);
  assert.deepEqual(at(23), ['class Cache 22-33'], 'the class line itself: the whole class');
  assert.deepEqual(at(10, 14), ['getRates() 6-11', 'formatRates() 13-16'], 'an edit across two blocks holds both');
  // Between blocks (a blank line): the edited lines ±5, anchored on a line with text.
  const gap = blocksFor('src/server.js', JS, 12, 12);
  assert.deepEqual(names(gap), ['? 7-17']);
  assert.equal(gap[0]!.anchor, '');
});

test('TypeScript and Go shapes get names too', () => {
  const ts = `export interface Lease {\n  path: string;\n}\n\ntype Op =\n  | { op: 'list' }\n  | { op: 'claim' };\n\nexport default {\n  async fetch() {}\n};\n`;
  assert.deepEqual(names(outline('a.ts', ts)), ['interface Lease 1-3', 'type Op 5-7', 'export default 9-11']);
  const go = `package main\n\nfunc (s *Server) Handle(w http.ResponseWriter) {\n\tw.Write(nil)\n}\n\nfunc main() {\n}\n`;
  assert.deepEqual(names(outline('main.go', go)), ['? 1-1', 'Server.Handle() 3-5', 'main() 7-8']);
});

const PY = `"""Module docstring."""
import os

RATES = {"usd": 1}


@cache
def get_rates(cur):
    x = RATES[cur]

    s = """
def not_a_function():
"""
    return s


class Bridge(Base):
    port = 80

    def __init__(self):
        self.a = 1

    @property
    def connect(self):
        pass

def format_rates(r):
    return r
if __name__ == "__main__":
    main()
else:
    pass
`;

test('Python: blocks by indentation, blank lines and strings inside a function stay in it', () => {
  const o = outline('rates.py', PY)!;
  assert.deepEqual(names(o), ['? 1-1', '? 2-2', 'RATES 4-4', 'get_rates() 7-14', 'class Bridge 17-25', 'format_rates() 27-28', 'if __name__ == "__main__" 29-32']);
  assert.deepEqual(names(o[4]!.members!), ['Bridge.port 18-18', 'Bridge.__init__() 20-21', 'Bridge.connect() 23-25']);
  assert.deepEqual(names(blocksFor('rates.py', PY, 12, 12)), ['get_rates() 7-14']);
  assert.deepEqual(names(blocksFor('rates.py', PY, 25, 25)), ['Bridge.connect() 23-25']);
  assert.equal(blockLanguage('notes.md'), null);
});

test('files we cannot parse, and edits at the edges: the edited lines ±5', () => {
  const md = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(outline('README.md', md), null);
  assert.deepEqual(blocksFor('README.md', md, 2, 3), [{ start: 1, end: 8, anchor: 'line 2', anchorLine: 2 }]);
  assert.deepEqual(blocksFor('README.md', md, 29, 40), [{ start: 24, end: 30, anchor: 'line 29', anchorLine: 29 }]);
  assert.deepEqual(blocksFor('a.js', '', 1, 1), [{ start: 1, end: 1, anchor: '', anchorLine: 1 }]);
});

test('where an edit lands: the lines of its old string', () => {
  assert.deepEqual(editRanges(JS, '  const r = RATES[cur];\n  const s'), [{ start: 8, end: 9 }]);
  assert.deepEqual(editRanges(JS, 'getRates('), [{ start: 7, end: 7 }], 'the first match');
  assert.deepEqual(editRanges(JS, 'getRates(', true), [{ start: 7, end: 7 }, { start: 19, end: 19 }]);
  assert.deepEqual(editRanges(JS, 'app.listen(3000);\n'), [{ start: 35, end: 35 }], 'a trailing newline adds no line');
  assert.equal(editRanges(JS, 'not in the file'), null);
  assert.equal(editRanges(JS, ''), null);
});

test('drift: a block is found again by its anchor after lines move, and re-measured', () => {
  const getRates = outline('src/server.js', JS)![3]!;
  const moved = `// ten new lines\n${'\n'.repeat(9)}${JS.replace('  return { cur, r, s };', '  if (!r) return null;\n  return { cur, r, s };')}`;
  assert.deepEqual(relocate(getRates, 'src/server.js', moved), { ...getRates, start: 16, end: 22, anchorLine: 17 });
  // The anchor line itself was edited: the block keeps its old lines.
  assert.deepEqual(relocate(getRates, 'src/server.js', JS.replace('getRates(cur)', 'getRates(cur, opts)')), getRates);
  // A plain range of lines moves with its anchor; with two matches, the nearer one wins.
  const range: Block = { start: 3, end: 7, anchor: 'b', anchorLine: 5 };
  assert.deepEqual(relocate(range, 'notes.md', 'b\nx\nx\nx\nx\nx\nx\nb\n'), { ...range, start: 6, end: 10, anchorLine: 8 });
});
