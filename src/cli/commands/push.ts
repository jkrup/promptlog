import { repoRoot } from '../../core/git.ts';
import { defaultRemote, pushRefs } from '../../capture/sync.ts';

// pl push [remote]            push refs/promptlog/* (default: the current branch's remote, else origin)
// pl push <remote> --from-hook  used by the pre-push hook: quiet, --no-verify, never fails the user's push
export async function run(args: string[]): Promise<number> {
  const fromHook = args.includes('--from-hook');
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository\n');
    return fromHook ? 0 : 1;
  }
  const remote = args.find((a) => !a.startsWith('-')) ?? defaultRemote(root);
  if (!remote) {
    process.stderr.write('no remote to push to (pass one: pl push <remote>)\n');
    return fromHook ? 0 : 1;
  }
  try {
    const res = pushRefs(root, remote, { noVerify: fromHook });
    if (res.refs === 0) {
      if (!fromHook) process.stdout.write('no sessions to push\n');
      return 0;
    }
    if (!res.ok) {
      process.stderr.write(`promptlog: pushing ${res.refs} session ref(s) to ${remote} failed:\n${res.stderr}`);
      return fromHook ? 0 : 1;
    }
    if (fromHook) process.stderr.write(`promptlog: pushed session refs to ${remote}\n`);
    else process.stdout.write(`pushed ${res.refs} session ref(s) to ${remote}\n${res.stderr}`);
    return 0;
  } catch (err) {
    process.stderr.write(`promptlog: push failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return fromHook ? 0 : 1;
  }
}
