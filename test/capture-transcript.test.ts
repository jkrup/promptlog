import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPromptText, isHumanPrompt, normalize, parseEntry, splitByTurn, transcriptFacts } from '../src/core/transcript.ts';
import type { TurnItem } from '../src/core/types.ts';
import { Transcript } from './capture-helpers.ts';

const entry = (line: string) => parseEntry(line)!;

test('isHumanPrompt: typed prompts start turns, injected user entries do not', () => {
  const t = new Transcript();
  t.human('fix the bug');
  t.human('old version prompt', { origin: false });
  t.human('', { origin: false, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] });
  const id = t.toolUse('Bash', { command: 'ls' });
  t.toolResult(id, 'a.txt');
  t.userText('<local-command-stdout>ok</local-command-stdout>');
  t.userText('<system-reminder>be nice</system-reminder>');
  t.userText('Caveat: expanded skill text', { isMeta: true });
  t.userText('This session is being continued...', { isCompactSummary: true });
  t.userText('<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } });
  t.userText('sidechain prompt', { isSidechain: true });
  t.userText('<command-message>review is running</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>');
  t.userText('[Request interrupted by user]');
  t.userText('[Request interrupted by user for tool use]');
  const flags = t.lines.map((l) => isHumanPrompt(entry(l)));
  assert.deepEqual(flags, [true, true, true, false, false, false, false, false, false, false, false, true, false, false]);
});

test('isHumanPrompt: origin.kind wins over text heuristics', () => {
  const t = new Transcript();
  t.userText('<system-reminder>x</system-reminder> typed anyway', { origin: { kind: 'human' } });
  t.userText('looks human', { origin: { kind: 'hook' } });
  assert.deepEqual(t.lines.map((l) => isHumanPrompt(entry(l))), [true, false]);
});

test('cleanPromptText strips injected blocks and turns slash commands into text', () => {
  assert.equal(cleanPromptText('<command-message>x</command-message>\n<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>'), '/review src/a.ts');
  assert.equal(cleanPromptText('<command-name>/clear</command-name>'), '/clear');
  assert.equal(cleanPromptText('hi <system-reminder>secret context</system-reminder>'), 'hi');
});

test('splitByTurn: preamble goes to turn 1, every line lands in exactly one chunk', () => {
  const t = new Transcript();
  t.meta({ type: 'queue-operation', operation: 'enqueue' });
  const p1 = t.human('one');
  t.text('answer one');
  t.userText('<local-command-stdout>x</local-command-stdout>');
  const p2 = t.human('two');
  const id = t.toolUse('Read', { file_path: 'a' });
  t.toolResult(id, 'contents');
  t.lines.push('{"truncated": ');
  const chunks = splitByTurn(t.lines);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.promptUuid, p1);
  assert.equal(chunks[1]!.promptUuid, p2);
  assert.equal(chunks[0]!.lines.length, 4);
  assert.equal(chunks[1]!.lines.length, 4);
  assert.deepEqual(chunks.flatMap((c) => c.lines), t.lines);
  assert.deepEqual(splitByTurn([]), []);
});

test('splitByTurn: queue operations before a prompt belong to that prompt, mid-turn ones stay', () => {
  const t = new Transcript();
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'one' });
  t.meta({ type: 'queue-operation', operation: 'dequeue' });
  t.human('one');
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'typed while working' }); // consumed mid-turn
  t.text('working');
  t.meta({ type: 'queue-operation', operation: 'remove', content: 'typed while working' });
  t.text('done one');
  t.meta({ type: 'cost-state' });
  t.meta({ type: 'queue-operation', operation: 'enqueue', content: 'two' });
  t.meta({ type: 'last-prompt' });
  t.meta({ type: 'queue-operation', operation: 'dequeue' });
  t.human('two');
  t.text('done two');
  const [c1, c2] = splitByTurn(t.lines);
  const kinds = (lines: string[]) => lines.map((l) => { const e = JSON.parse(l); return e.operation ? `q:${e.operation}` : e.type; });
  assert.deepEqual(kinds(c1!.lines), ['q:enqueue', 'q:dequeue', 'user', 'q:enqueue', 'assistant', 'q:remove', 'assistant', 'cost-state']);
  assert.deepEqual(kinds(c2!.lines), ['q:enqueue', 'last-prompt', 'q:dequeue', 'user', 'assistant']);
  assert.ok(!c1!.lines.join('\n').includes('"two"'), "turn 1 doesn't leak turn 2's prompt");
  assert.deepEqual([...c1!.lines, ...c2!.lines], t.lines);
  // A trailing enqueue with no prompt yet stays in the last turn until the prompt arrives.
  const t2 = new Transcript();
  t2.human('only');
  t2.meta({ type: 'queue-operation', operation: 'enqueue', content: 'next' });
  assert.equal(splitByTurn(t2.lines)[0]!.lines.length, 2);
});

test('normalize: turn numbering matches splitByTurn and prompts are cleaned', () => {
  const t = new Transcript();
  t.human('first');
  t.text('ok');
  t.userText('<command-message>c</command-message>\n<command-name>/review</command-name>\n<command-args></command-args>');
  t.human('third <system-reminder>noise</system-reminder>');
  const turns = normalize(t.lines);
  assert.deepEqual(turns.map((x) => [x.index, x.prompt]), [[1, 'first'], [2, '/review'], [3, 'third']]);
  assert.equal(splitByTurn(t.lines).length, turns.length);
});

test('normalize: assistant blocks split across lines with the same message.id stay in order', () => {
  const t = new Transcript();
  t.human('go');
  t.assistant([{ type: 'thinking', thinking: 'hmm', signature: 'sig' }], { msgId: 'msg_1', model: 'claude-a' });
  t.assistant([{ type: 'text', text: 'Let me look.' }], { msgId: 'msg_1', model: 'claude-a' });
  const id = t.toolUse('Bash', { command: 'ls' }, { msgId: 'msg_1' });
  t.toolResult(id, 'boom', { isError: true });
  t.assistant([{ type: 'text', text: 'Done.' }], { msgId: 'msg_2', model: 'claude-b' });
  const [turn] = normalize(t.lines);
  assert.deepEqual(turn!.items.map((i) => i.kind), ['thinking', 'text', 'tool', 'text']);
  const tool = turn!.items[2] as Extract<TurnItem, { kind: 'tool' }>;
  assert.equal(tool.result, 'boom');
  assert.equal(tool.isError, true);
  assert.equal(turn!.finalResponse, 'Done.');
  assert.equal(turn!.model, 'claude-b');
});

test('normalize: sidechain tool calls are kept (flagged), sidechain text is not', () => {
  const t = new Transcript();
  t.human('delegate');
  const task = t.toolUse('Task', { prompt: 'explore' });
  t.assistant([{ type: 'text', text: 'subagent musing' }], { sidechain: true });
  const inner = t.toolUse('Grep', { pattern: 'x' }, { sidechain: true });
  t.toolResult(inner, 'found', { sidechain: true });
  t.toolResult(task, 'report');
  const [turn] = normalize(t.lines);
  const tools = turn!.items.filter((i) => i.kind === 'tool');
  assert.deepEqual(tools.map((x) => [x.name, x.sidechain, x.result]), [['Task', false, 'report'], ['Grep', true, 'found']]);
  assert.ok(!turn!.items.some((i) => i.kind === 'text'));
});

test('normalize: events for command output, interrupts and compaction; system reminders dropped', () => {
  const t = new Transcript();
  t.human('go');
  t.userText('<local-command-stdout>Set model</local-command-stdout>');
  t.userText('[Request interrupted by user]');
  t.userText('<system-reminder>hidden</system-reminder>');
  t.raw({ type: 'system', subtype: 'compact_boundary' });
  t.userText('Summary of earlier conversation', { isCompactSummary: true });
  const [turn] = normalize(t.lines);
  assert.deepEqual(turn!.items.map((i) => (i.kind === 'event' ? i.subtype : i.kind)), ['command_output', 'interrupt', 'compact_boundary', 'compact_summary']);
});

test('transcriptFacts: title, version, model, branch', () => {
  const t = new Transcript();
  t.human('hello');
  t.text('hi', { model: 'claude-x' });
  t.meta({ type: 'ai-title', aiTitle: 'Greeting' });
  const f = transcriptFacts(t.lines);
  assert.equal(f.title, 'Greeting');
  assert.equal(f.version, '2.1.0');
  assert.equal(f.model, 'claude-x');
  assert.equal(f.branch, 'main');
});
