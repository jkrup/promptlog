import { repoRoot } from '../../core/git.ts';
import { logHookError } from '../../capture/hook.ts';
import { addTrailers, clearAfterCommit, stripIfOnlyTrailers } from '../../capture/trailer.ts';

// Git hook entry points (installed by `promptlog install`). They never fail the commit.
//   promptlog trailer <msg-file> [source] [sha]   prepare-commit-msg: add `Promptlog: <session>#<turn>` trailers
//   promptlog trailer --commit-msg <msg-file>     commit-msg: drop our trailers if the message is otherwise empty
//   promptlog trailer --post-commit               post-commit: reset turns-since-commit
export async function run(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const mode = args[0] === '--commit-msg' ? 'commit-msg' : args[0] === '--post-commit' ? 'post-commit' : 'prepare-commit-msg';
  try {
    const root = repoRoot(cwd);
    if (!root) return 0;
    if (mode === 'post-commit') clearAfterCommit(root);
    else if (mode === 'commit-msg') {
      if (args[1]) stripIfOnlyTrailers(root, args[1]);
    } else if (args[0]) addTrailers(root, args[0], args[1]);
  } catch (err) {
    logHookError(cwd, mode, err);
  }
  return 0;
}
