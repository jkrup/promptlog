// promptlog leases                  which agent sessions are working on which files right now
// promptlog leases release <path>…  free files (whoever holds them), e.g. after a session crashed
// promptlog leases release --all    free everything
import { repoRoot } from '../../core/git.ts';
import { leaseTtlMs, listLeases, release, repoPath, sharedLeasesUrl } from '../../capture/leases.ts';

const USAGE = 'usage: promptlog leases [release <path>… | release --all] [--json]\n';

export async function run(args: string[]): Promise<number> {
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository\n');
    return 1;
  }
  if (args[0] === 'release') {
    const rest = args.slice(1);
    if (!rest.length) {
      process.stderr.write(USAGE);
      return 1;
    }
    const paths = rest.includes('--all') ? undefined : rest.map((p) => repoPath(root, process.cwd(), p) ?? p);
    const n = release(root, null, paths);
    process.stdout.write(`released ${n} lease${n === 1 ? '' : 's'}\n`);
    return 0;
  }
  if (args.length && args[0] !== '--json') {
    process.stderr.write(USAGE);
    return 1;
  }
  const leases = listLeases(root);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(leases, null, 2) + '\n');
    return 0;
  }
  if (!leases.length) {
    process.stdout.write('no agent is holding any file right now\n');
    return 0;
  }
  const min = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  const bySession = new Map<string, typeof leases>();
  for (const l of leases) bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);
  for (const [sid, ls] of bySession) {
    const l = ls[0]!;
    process.stdout.write(`session ${sid.slice(0, 8)}${l.branch ? ` on ${l.branch}` : ''}, active ${min(l.renewedAt)} min ago${l.ask ? `: "${l.ask}"` : ''}\n`);
    for (const x of ls) process.stdout.write(`  ${x.path}\n`);
  }
  process.stdout.write(`(leases end when a session ends, or after ${Math.round(leaseTtlMs() / 60_000)} min without activity)\n`);
  const shared = sharedLeasesUrl(root);
  if (shared) process.stdout.write(`(shared with agents on other machines: ${shared.replace('/__leases/', '/leases?repo=')})\n`);
  return 0;
}
