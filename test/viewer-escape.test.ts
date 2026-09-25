import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../src/core/types.ts';
import { renderDiff } from '../src/viewer/diff.ts';
import { escapeHtml, html, raw, safeUrl, toHtml } from '../src/viewer/html.ts';
import { renderMarkdown } from '../src/viewer/markdown.ts';
import { makeLabels, renderAskResult, renderRawLog, renderSessionPage, renderSummary, renderTurn, type RenderCtx } from '../src/viewer/render.ts';
import { mockSummary } from '../src/viewer/mock.ts';

const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
const ctx: RenderCtx = { labels: makeLabels(['s1']), single: false, features: { ask: { available: true }, summary: { available: true } }, pathPrefixes: [] };

/** No executable markup from EVIL survives: only escaped forms. */
function assertInert(out: string) {
  assert.doesNotMatch(out, /<script>alert/);
  assert.doesNotMatch(out, /<img src=x/);
  assert.doesNotMatch(out, /onerror=alert\(2\)>/);
}

test('escapeHtml and the html tag', () => {
  assert.equal(escapeHtml(EVIL), '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;');
  assert.equal(toHtml(html`<p title="${EVIL}">${EVIL}</p>`), `<p title="${escapeHtml(EVIL)}">${escapeHtml(EVIL)}</p>`);
  assert.equal(toHtml(html`<b>${raw('<i>ok</i>')}</b>`), '<b><i>ok</i></b>');
  assert.equal(toHtml(html`${['<a>', html`<b>`, null, undefined, false, 0]}`), '&lt;a&gt;<b>0');
});

test('safeUrl rejects script-capable schemes', () => {
  for (const u of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.com']) assert.equal(safeUrl(u), null, u);
  for (const u of ['https://a.b/c', 'http://x', 'mailto:a@b', '#t-1', '/session/x']) assert.equal(safeUrl(u), u);
});

test('markdown escapes first, then formats', () => {
  const out = renderMarkdown(`# Title ${EVIL}\n\nText ${EVIL} with \`<b>code</b>\` and **bold** and *em*.\n\n\`\`\`html\n</code></pre><script>alert(3)</script>\n\`\`\`\n\n- item ${EVIL}\n  - nested\n\n| a | b |\n|---|---|\n| ${EVIL} | 2 |\n\n[click](javascript:alert(4)) [ok](https://example.com/?a=1&b="2") https://x.dev/y.`).__html;
  assertInert(out);
  assert.doesNotMatch(out, /<script>alert\(3\)/);
  assert.doesNotMatch(out, /href="javascript:/i);
  assert.match(out, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<pre class="code" data-lang="html"><code>&lt;\/code&gt;&lt;\/pre&gt;&lt;script&gt;/);
  assert.match(out, /<ul><li>item [^<]*&lt;script&gt;.*<ul><li>nested<\/li><\/ul><\/li><\/ul>/s);
  assert.match(out, /<table>/);
  assert.match(out, /\[click\]\(javascript:alert\(4\)\)/, 'unsafe link stays as text');
  assert.match(out, /<a href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(out, /<a href="https:\/\/x\.dev\/y" [^>]*>https:\/\/x\.dev\/y<\/a>\./, 'autolink drops trailing punctuation');
  assert.doesNotMatch(renderMarkdown('snake_case_name and file_name.ts').__html, /<em>/);
});

test('a hostile transcript renders inert everywhere', () => {
  const session: Session = {
    meta: { schema: 1, sessionId: 's1', agent: 'claude-code', cwd: '', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', title: EVIL, author: { name: EVIL, email: 'x' }, branch: EVIL },
    turns: [
      {
        index: 1,
        prompt: `Please ${EVIL} and \`${EVIL}\``,
        timestamp: '2026-01-01T00:00:00Z',
        model: EVIL,
        items: [
          { kind: 'text', text: EVIL },
          { kind: 'thinking', text: EVIL },
          { kind: 'tool', id: 't1', name: EVIL, input: { file_path: `/r/${EVIL}`, command: EVIL }, result: EVIL, isError: true },
          { kind: 'tool', id: 't2', name: 'Bash', input: { command: EVIL, description: EVIL }, result: EVIL },
          { kind: 'tool', id: 't3', name: 'Edit', input: { file_path: EVIL, old_string: EVIL, new_string: EVIL }, result: EVIL },
          { kind: 'event', subtype: 'command_output', text: EVIL },
        ],
        meta: {
          schema: 1,
          index: 1,
          commits: ['abc1234'],
          filesChanged: [{ path: EVIL, status: 'M', additions: 1, deletions: 0 }],
          stateBefore: 'a',
          stateAfter: 'b',
        },
      },
    ],
  };
  const turn = renderTurn(ctx, session, session.turns[0]!, {
    commits: [{ sha: 'abc1234', subject: EVIL }],
    humanEdits: [{ path: EVIL, status: 'A', additions: 1, deletions: 0 }],
    asks: [{ sessionId: 's1', turn: 1, question: EVIL, answer: EVIL, askedAt: EVIL, askedBy: EVIL }],
  }).__html;
  assertInert(turn);
  // Attribute contexts stay closed: titles carry escaped quotes.
  assert.doesNotMatch(turn, /title="[^"]*"[^ >]*onerror/);
  assertInert(renderSessionPage({ session, extras: {}, features: ctx.features }));
  assertInert(renderAskResult({ sessionId: 's1', turn: 1, question: EVIL, answer: EVIL, askedAt: EVIL, forkSessionId: EVIL }).__html);
});

test('diffs, raw logs and summaries escape their content', () => {
  const diff = `diff --git a/x.html b/x.html\nindex 1..2 100644\n--- a/x.html\n+++ b/x.html\n@@ -1 +1 @@ ${EVIL}\n-${EVIL}\n+${EVIL}\n`;
  const d = renderDiff(diff).__html;
  assertInert(d);
  assert.match(d, /<tr class="add">/);
  assertInert(renderRawLog([JSON.stringify({ type: EVIL, message: { content: EVIL } }), `not json ${EVIL}`], '/api/turn-raw?session=s1&turn=1').__html);

  const s = mockSummary({ base: 'a', head: 'b', mergeBase: 'c', commits: [], slices: [{ sessionId: 's1', fromTurn: 1, toTurn: 1, committingTurns: [1] }], sessions: {} });
  s.intent = EVIL;
  s.approach = `\`${EVIL}\``;
  s.pushbacks[0]!.humanSaid = EVIL;
  s.riskFlags[0]!.note = EVIL;
  s.decisions[0]!.alternatives = [EVIL];
  assertInert(renderSummary(ctx, s).__html);
});
