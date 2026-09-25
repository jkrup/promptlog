import { listSessions, readStoredSession } from '../../core/store.ts';

export async function run(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const rows = listSessions(cwd)
    .map((s) => readStoredSession(cwd, s.sessionId))
    .filter((s) => s !== null)
    .sort((a, b) => (a.meta.updatedAt < b.meta.updatedAt ? 1 : -1));
  if (rows.length === 0) {
    process.stdout.write('no sessions captured yet (run `pl install`, then use Claude Code in this repo)\n');
    return 0;
  }
  for (const s of rows) {
    const commits = s.turns.reduce((n, t) => n + (t.meta.commits?.length ?? 0), 0);
    process.stdout.write(`${s.meta.sessionId.slice(0, 8)}  ${s.meta.updatedAt.slice(0, 16).replace('T', ' ')}  ${String(s.turns.length).padStart(3)} turns  ${String(commits).padStart(2)} commits  ${s.meta.branch ?? '-'}  ${s.meta.title ?? ''}\n`);
  }
  return 0;
}
