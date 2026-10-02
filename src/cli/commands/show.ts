import { listSessions, loadSession, readStoredSession } from '../../core/store.ts';
import type { Turn } from '../../core/types.ts';

export function resolveSessionId(cwd: string, prefix: string): string | null {
  const matches = listSessions(cwd).filter((s) => s.sessionId.startsWith(prefix));
  return matches.length === 1 ? matches[0]!.sessionId : null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export function formatTurn(t: Turn): string {
  const lines = [`── turn ${t.index} ${t.timestamp ?? ''} ${t.model ?? ''}`.trimEnd(), `> ${t.prompt.replace(/\n/g, '\n> ')}`];
  const tools = t.items.filter((i) => i.kind === 'tool');
  if (tools.length) lines.push(`  [${tools.length} tool calls: ${[...new Set(tools.map((x) => x.name))].join(', ')}]`);
  if (t.finalResponse) lines.push(clip(t.finalResponse.trim(), 600).replace(/^/gm, '  '));
  const m = t.meta;
  if (m?.filesChanged?.length) lines.push(`  files: ${m.filesChanged.map((f) => `${f.status} ${f.path} +${f.additions}/-${f.deletions}`).join(', ')}`);
  if (m?.commits?.length) lines.push(`  commits: ${m.commits.map((c) => c.slice(0, 8)).join(', ')}`);
  return lines.join('\n');
}

export async function run(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const id = args[0] && resolveSessionId(cwd, args[0]);
  if (!id) {
    process.stderr.write('usage: promptlog show <session-id-prefix> [--raw]\n');
    return 1;
  }
  if (args.includes('--raw')) {
    const stored = readStoredSession(cwd, id)!;
    for (const t of stored.turns) process.stdout.write(t.transcript.join('\n') + '\n');
    return 0;
  }
  const s = loadSession(cwd, id)!;
  process.stdout.write(`session ${s.meta.sessionId}  ${s.meta.title ?? ''}\nbranch ${s.meta.branch ?? '-'}  agent ${s.meta.agent} ${s.meta.agentVersion ?? ''}\n\n`);
  for (const t of s.turns) process.stdout.write(formatTurn(t) + '\n\n');
  return 0;
}
