// Messages that arrive while Claude is still working: Claude Code queues them, then either feeds them into the running
// turn (queue `remove`, reason absorbed_mid_turn, plus a `queued_command` attachment) or makes them the next prompt
// (queue `dequeue`). The first kind belongs to the turn it landed in; the second is the next turn's prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTurn } from '../src/cli/commands/show.ts';
import { loadSession } from '../src/core/store.ts';
import { crossSessionMessage, normalize, splitByTurn } from '../src/core/transcript.ts';
import type { Session as StoredSession, Turn, TurnItem } from '../src/core/types.ts';
import { renderPrPage, type PrPageModel } from '../src/viewer/pr.ts';
import { renderTurn, sessionCtx } from '../src/viewer/render.ts';
import { tempRepo } from './helpers.ts';
import { pl, Session, Transcript } from './capture-helpers.ts';

type Event = Extract<TurnItem, { kind: 'event' }>;
const mids = (t: Turn | undefined): Event[] => (t?.items ?? []).filter((i): i is Event => i.kind === 'event' && i.subtype === 'midturn');

const ENVELOPE = (name: string, body: string) =>
  `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-session="local_x" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`;

/** Lines Claude Code writes when the person types while Claude works and the message goes into the running turn. */
function typedMidTurn(t: Transcript, text: string, id: string, opts: { order?: 'attachment-first' | 'remove-first'; old?: boolean } = {}): void {
  const at = '2026-10-03T05:10:34.019Z';
  t.meta({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: text });
  const attachment = () =>
    t.raw({ type: 'attachment', attachment: { type: 'queued_command', prompt: text, source_uuid: id, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: at } });
  // Older Claude Code: no reason and no id on the removal, and it came before the attachment.
  const remove = () =>
    t.meta({ type: 'queue-operation', operation: 'remove', timestamp: '2026-10-03T05:10:35.252Z', content: text, ...(opts.old ? {} : { reason: 'absorbed_mid_turn', commandUuid: id }) });
  if (opts.order === 'remove-first') {
    remove();
    attachment();
  } else {
    attachment();
    remove();
  }
}

/** The same, for a message another Claude session sent. */
function peerMidTurn(t: Transcript, name: string, body: string): void {
  const content = ENVELOPE(name, body);
  t.meta({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-03T06:35:18.127Z', content });
  t.raw({
    type: 'attachment',
    attachment: { type: 'queued_command', prompt: content, source_uuid: 'peer-1', commandMode: 'prompt', origin: { kind: 'peer', name, body }, timestamp: '2026-10-03T06:35:18.127Z', isMeta: true },
  });
  t.meta({ type: 'queue-operation', operation: 'remove', timestamp: '2026-10-03T06:35:20.194Z', content, reason: 'absorbed_mid_turn', commandUuid: 'peer-1' });
}

test('midturn: a message typed while Claude works stays in that turn, once', () => {
  for (const order of ['attachment-first', 'remove-first'] as const) {
    const t = new Transcript();
    t.human('improve the popup');
    const id = t.toolUse('Bash', { command: 'npm test' });
    typedMidTurn(t, 'can u bump versions while u improve this', 'cmd-1', { order, old: order === 'remove-first' });
    t.toolResult(id, 'ok');
    t.text('Bumped to 0.2.0 and improved the popup.');
    t.human('thanks');
    const turns = normalize(t.lines);
    assert.equal(turns.length, 2, order);
    const m = mids(turns[0]);
    assert.equal(m.length, 1, order);
    assert.equal(m[0]!.text, 'can u bump versions while u improve this');
    assert.equal(m[0]!.from, undefined);
    assert.equal(m[0]!.timestamp, '2026-10-03T05:10:34.019Z', 'when it was sent');
    assert.deepEqual(mids(turns[1]), []);
    assert.equal(turns[0]!.finalResponse, 'Bumped to 0.2.0 and improved the popup.');
    // It sits where Claude read it: after the tool call it was working on.
    assert.deepEqual(turns[0]!.items.map((i) => (i.kind === 'event' ? i.subtype : i.kind)), ['tool', 'midturn', 'text']);
  }
});

test('midturn: a message from another session carries its sender name', () => {
  const t = new Transcript();
  t.human('fix the dropdown');
  t.text('looking');
  peerMidTurn(t, 'Blog SEO audit', 'Retest: TXT is still unreachable.');
  t.text('The retest says TXT is still missing.');
  const [turn] = normalize(t.lines);
  const m = mids(turn);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.from, 'Blog SEO audit');
  assert.equal(m[0]!.text, 'Retest: TXT is still unreachable.');
  assert.equal(turn!.from, undefined, 'the turn itself was started by the person');
});

test('midturn: a queue removal without its attachment still counts; the envelope names the sender', () => {
  const t = new Transcript();
  t.human('go');
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: ENVELOPE('Docs bot', 'Done with the docs.') });
  t.text('working');
  t.meta({ type: 'queue-operation', operation: 'remove', timestamp: '2026-10-03T06:00:00.000Z', content: ENVELOPE('Docs bot', 'Done with the docs.'), reason: 'absorbed_mid_turn' });
  t.text('noted');
  const m = mids(normalize(t.lines)[0]);
  assert.deepEqual(m.map((x) => [x.from, x.text]), [['Docs bot', 'Done with the docs.']]);
  assert.deepEqual(crossSessionMessage('<cross-session-message from-name="A &amp; B">\nhi\n</cross-session-message>'), { from: 'A & B', body: 'hi' });
});

test('midturn: a message that became the next prompt is that turn\'s prompt, not a mid-turn message', () => {
  const t = new Transcript();
  t.human('one');
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'two' }); // typed while turn 1 ran...
  t.text('done one');
  t.meta({ type: 'queue-operation', operation: 'dequeue' }); // ...but only sent after it ended
  t.human('two');
  t.text('done two');
  const turns = normalize(t.lines);
  assert.deepEqual(turns.map((x) => x.prompt), ['one', 'two']);
  assert.deepEqual(turns.flatMap(mids), []);
});

test('midturn: the same words sent twice in one turn show twice', () => {
  const t = new Transcript();
  t.human('go');
  typedMidTurn(t, '?', 'c1');
  t.text('still working');
  typedMidTurn(t, '?', 'c2');
  t.text('done');
  assert.equal(mids(normalize(t.lines)[0]).length, 2);
});

test('midturn: background-task notices and subagent reports are not messages', () => {
  const t = new Transcript();
  t.human('go');
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  t.raw({ type: 'attachment', attachment: { type: 'queued_command', prompt: notice, commandMode: 'task-notification' } });
  t.meta({ type: 'queue-operation', operation: 'remove', content: notice, reason: 'absorbed_mid_turn' });
  const report = '<agent-message from="af56">\n[Subagent hand-back] All fixes are in.\n</agent-message>';
  t.raw({ type: 'attachment', attachment: { type: 'queued_command', prompt: report, commandMode: 'prompt', origin: { kind: 'peer', from: 'af56', body: 'All fixes are in.', handback: true } } });
  t.meta({ type: 'queue-operation', operation: 'remove', content: report, reason: 'absorbed_mid_turn' });
  t.text('done');
  assert.deepEqual(mids(normalize(t.lines)[0]), []);
});

test('midturn: the old leak stays fixed, and mid-turn lines stay in their turn\'s raw log', () => {
  const t = new Transcript();
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'one' });
  t.meta({ type: 'queue-operation', operation: 'dequeue' });
  t.human('one');
  const id = t.toolUse('Bash', { command: 'ls' });
  typedMidTurn(t, 'typed while working', 'c1');
  t.toolResult(id, 'a.txt');
  t.text('done one');
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'two' });
  t.meta({ type: 'last-prompt' });
  t.meta({ type: 'queue-operation', operation: 'dequeue' });
  t.human('two');
  t.text('done two');
  const [c1, c2] = splitByTurn(t.lines);
  assert.ok(!c1!.lines.join('\n').includes('"two"'), "turn 1 doesn't leak turn 2's prompt");
  assert.ok(c1!.lines.some((l) => l.includes('queued_command')), 'the attachment is in turn 1');
  assert.ok(!c2!.lines.some((l) => l.includes('typed while working')));
  assert.deepEqual([...c1!.lines, ...c2!.lines], t.lines);
  // Each turn's own raw log reads the same as the whole transcript.
  assert.deepEqual(mids(normalize(c1!.lines)[0]).map((m) => m.text), ['typed while working']);
  assert.deepEqual(normalize(t.lines).map((x) => mids(x).length), [1, 0]);
});

test('midturn: live capture and import both keep them', () => {
  const repo = tempRepo();
  const live = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-mid-')));
  live.prompt('improve the popup');
  const id = live.t.toolUse('Bash', { command: 'ls' });
  typedMidTurn(live.t, 'and bump the version', 'c1');
  peerMidTurn(live.t, 'Blog SEO audit', 'Retest failed.');
  live.t.toolResult(id, 'ok');
  live.t.text('done');
  live.hook('Stop');
  live.prompt('next');
  live.t.text('ok');
  live.hook('Stop');
  const check = (s: StoredSession | null) => {
    assert.ok(s);
    assert.deepEqual(s.turns.map((t) => mids(t).map((m) => [m.from ?? 'person', m.text])), [[['person', 'and bump the version'], ['Blog SEO audit', 'Retest failed.']], []]);
  };
  check(loadSession(repo, live.id));

  const imported = new Session(repo, mkdtempSync(join(tmpdir(), 'pl-mid-')));
  imported.t.human('improve the popup');
  typedMidTurn(imported.t, 'and bump the version', 'c1');
  peerMidTurn(imported.t, 'Blog SEO audit', 'Retest failed.');
  imported.t.text('done');
  imported.t.human('next');
  imported.flush();
  const res = pl(repo, ['import', imported.path, '--session', imported.id]);
  assert.equal(res.status, 0, res.stderr);
  check(loadSession(repo, imported.id));
});

test('midturn: shown in the PR turn card, the session page and `promptlog show`', () => {
  const t = new Transcript();
  t.human('improve the popup');
  typedMidTurn(t, 'your fixes not working and we need a stop button', 'c1');
  peerMidTurn(t, 'Blog SEO audit', 'Retest: TXT is still unreachable.');
  t.text('Added a stop button.');
  const turn = normalize(t.lines)[0]!;

  const base = { sessionId: 's1', turn: 1, who: 'Maz', fromAgent: false, command: false, files: [], additions: 0, deletions: 0, toolCalls: 0, rawHref: '/session/s1#t' };
  const model: PrPageModel = {
    title: 'x',
    base: 'main',
    head: 'feature',
    commits: [],
    coverage: { lines: 0, credited: 0 },
    sessions: [{ sessionId: 's1', title: 'S', color: 0, turns: [{ ...base, ask: 'improve the popup', midTurn: [{ text: 'your fixes not working', who: 'Maz', fromAgent: false, at: '2026-10-03T06:50:07.642Z' }] }, { ...base, turn: 2, ask: 'quiet one', midTurn: [{ text: 'Retest failed.', who: 'Blog SEO audit', fromAgent: true }] }] }],
    files: [],
    repoName: 'r',
    oldHref: '/review-old',
  };
  const page = renderPrPage(model);
  assert.equal(page.split('Arrived while Claude was working').length - 1, 2);
  assert.match(page, /pr-mid">[\s\S]*?<span class="pr-who">Maz<\/span>[\s\S]*?your fixes not working/);
  // A message from another agent is never folded away, even in a turn that wrote no code.
  assert.match(page, /<article class="pr-turn" id="t-s1-2">[\s\S]*?pr-mid from-agent[\s\S]*?Blog SEO audit<\/span><span class="pr-tag">agent<\/span>[\s\S]*?Retest failed\./);

  const session: StoredSession = { meta: { schema: 1, sessionId: 's1', agent: 'claude-code', cwd: '', startedAt: '', updatedAt: '', author: { name: 'Maz', email: 'm@x' } }, turns: [turn] };
  const off = { available: false, reason: 'off' };
  const html = renderTurn(sessionCtx(session, { ask: off, summary: off }), session, turn, undefined).__html;
  assert.match(html, /Arrived while Claude was working[\s\S]*?Maz[\s\S]*?your fixes not working and we need a stop button/);
  assert.match(html, /midturn from-agent[\s\S]*?Blog SEO audit[\s\S]*?another Claude session[\s\S]*?Retest: TXT is still unreachable\./);

  const shown = formatTurn(turn);
  assert.match(shown, /\[arrived while Claude was working\] your fixes not working/);
  assert.match(shown, /\[arrived while Claude was working, from Blog SEO audit\] Retest: TXT/);
});
