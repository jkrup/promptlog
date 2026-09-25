import { repoRoot } from '../../core/git.ts';
import { defaultRemote, fetchRefs } from '../../capture/sync.ts';

// pl fetch [remote]   fetch refs/promptlog/* (default: the current branch's remote, else origin)
export async function run(args: string[]): Promise<number> {
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository\n');
    return 1;
  }
  const remote = args.find((a) => !a.startsWith('-')) ?? defaultRemote(root);
  if (!remote) {
    process.stderr.write('no remote to fetch from (pass one: pl fetch <remote>)\n');
    return 1;
  }
  const res = fetchRefs(root, remote);
  if (!res.ok) {
    process.stderr.write(`fetching sessions from ${remote} failed:\n${res.stderr}`);
    return 1;
  }
  process.stdout.write(`fetched from ${remote}: ${res.updated.length} session ref(s) new or updated\n`);
  for (const k of res.kept) {
    const why = k.reason === 'ahead' ? 'local copy has unpushed turns' : 'local and remote histories differ; kept local';
    process.stdout.write(`  kept ${k.ref.replace('refs/promptlog/', '')}: ${why}\n`);
  }
  return 0;
}
