// Synthetic Claude Code transcripts and hook drivers for capture/store tests.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleHook, type HookOptions, type HookPayload } from '../src/capture/hook.ts';
import { ROOT } from './helpers.ts';

export const PL = join(ROOT, 'bin/promptlog');

export function sh(cwd: string, cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).replace(/\n$/, '');
}
export const gitc = (cwd: string, ...args: string[]) => sh(cwd, 'git', args);

/** test/lease-server.ts in a child process: a stand-in for the lease table on Cloudflare. */
export async function leaseServer(key: string, ...flags: string[]): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'test/lease-server.ts'), key, ...flags], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((ok, fail) => {
    child.stdout.once('data', (d) => ok(String(d).trim()));
    child.once('exit', (code) => fail(new Error(`lease server exited (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** Run `bin/promptlog` with stdin; returns status and output. */
export function pl(cwd: string, args: string[], input = '', env: Record<string, string> = {}) {
  const r = spawnSync(PL, args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let clock = Date.parse('2026-01-01T00:00:00Z');
const ts = () => new Date((clock += 1000)).toISOString();

/** Builds a Claude Code-shaped JSONL transcript. Methods return the entry's uuid (or tool id). */
export class Transcript {
  readonly lines: string[] = [];
  readonly sessionId: string;
  cwd: string;
  promptId?: string;
  private last: string | null = null;
  private tool = 0;

  constructor(sessionId: string = randomUUID(), cwd = '/repo') {
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  raw(obj: Record<string, unknown>): string {
    const uuid = (obj.uuid as string | undefined) ?? randomUUID();
    const e = { parentUuid: this.last, isSidechain: false, ...obj, uuid, timestamp: ts(), sessionId: this.sessionId, cwd: this.cwd, version: '2.1.0', gitBranch: 'main' };
    this.lines.push(JSON.stringify(e));
    this.last = uuid;
    return uuid;
  }

  /** A typed human prompt. `origin: false` omits the origin tag (older Claude Code versions). */
  human(text: string, opts: { origin?: boolean; content?: unknown } = {}): string {
    this.promptId = randomUUID();
    return this.raw({
      type: 'user',
      promptId: this.promptId,
      ...(opts.origin === false ? {} : { origin: { kind: 'human' } }),
      message: { role: 'user', content: opts.content ?? text },
    });
  }

  userText(text: string, extra: Record<string, unknown> = {}): string {
    return this.raw({ type: 'user', promptId: this.promptId, message: { role: 'user', content: text }, ...extra });
  }

  assistant(blocks: unknown[], opts: { msgId?: string; model?: string; sidechain?: boolean } = {}): string {
    return this.raw({
      type: 'assistant',
      isSidechain: !!opts.sidechain,
      message: { id: opts.msgId ?? `msg_${randomUUID()}`, role: 'assistant', model: opts.model ?? 'claude-test-1', content: blocks, usage: { input_tokens: 1, output_tokens: 2 } },
    });
  }

  text(text: string, opts: { msgId?: string; model?: string } = {}): string {
    return this.assistant([{ type: 'text', text }], opts);
  }

  toolUse(name: string, input: unknown, opts: { msgId?: string; sidechain?: boolean } = {}): string {
    const id = `toolu_${++this.tool}_${randomUUID().slice(0, 8)}`;
    this.assistant([{ type: 'tool_use', id, name, input }], opts);
    return id;
  }

  toolResult(id: string, content: string, opts: { isError?: boolean; sidechain?: boolean } = {}): string {
    return this.raw({
      type: 'user',
      isSidechain: !!opts.sidechain,
      promptId: this.promptId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!opts.isError }] },
      toolUseResult: { stdout: content, stderr: '' },
    });
  }

  meta(obj: Record<string, unknown>): void {
    this.lines.push(JSON.stringify({ ...obj, sessionId: this.sessionId }));
  }

  toString(): string {
    return this.lines.map((l) => l + '\n').join('');
  }

  write(path: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.toString());
    return path;
  }

  /** Append lines added since `from` (simulates Claude Code flushing more of the transcript). */
  appendSince(path: string, from: number): void {
    appendFileSync(path, this.lines.slice(from).map((l) => l + '\n').join(''));
  }
}

/** Drives the capture hooks for one session like Claude Code would. */
export class Session {
  readonly t: Transcript;
  readonly repo: string;
  readonly path: string;
  written = 0;

  constructor(repo: string, dir: string, sessionId?: string) {
    this.repo = repo;
    this.t = new Transcript(sessionId, repo);
    this.path = join(dir, `${this.t.sessionId}.jsonl`);
    writeFileSync(this.path, '');
  }

  get id(): string {
    return this.t.sessionId;
  }

  flush(): void {
    this.t.appendSince(this.path, this.written);
    this.written = this.t.lines.length;
  }

  hook(event: string, extra: Partial<HookPayload> = {}, opts: HookOptions = {}): void {
    this.flush();
    handleHook(event, { session_id: this.id, transcript_path: this.path, cwd: this.repo, hook_event_name: event, ...extra }, opts);
  }

  /** UserPromptSubmit, then the prompt line lands in the transcript. */
  prompt(text: string): void {
    this.hook('UserPromptSubmit', { prompt: text });
    this.t.human(text);
    this.flush();
  }
}
