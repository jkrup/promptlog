// pl view [<base>..<head> | <branch>] [--port 4777]: serve the review viewer on 127.0.0.1.
import { repoRoot } from '../../core/git.ts';
import { parseRange } from '../../core/review.ts';
import { isSafeRev } from '../../viewer/model.ts';
import { reviewUrl } from '../../viewer/render.ts';
import { startServer } from '../../viewer/server.ts';

const USAGE = `usage: pl view [<base>..<head> | <branch>] [--port <n>]

Serves the review viewer on http://127.0.0.1 (never on other interfaces).
With a range or branch, prints the review URL; without, the index of branches and sessions.
`;

export async function run(args: string[]): Promise<number> {
  let port: number | undefined;
  let spec: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    const m = /^--port(?:=(.*))?$/.exec(a);
    if (m) {
      const v = m[1] ?? args[++i];
      port = Number(v);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`invalid --port: ${v}\n`);
        return 1;
      }
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`unknown option: ${a}\n${USAGE}`);
      return 1;
    }
    spec = a;
  }

  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('pl view: not inside a git repository\n');
    return 1;
  }
  let path = '/';
  if (spec) {
    const { base, head } = parseRange(root, spec);
    if (!isSafeRev(base) || !isSafeRev(head)) {
      process.stderr.write(`pl view: invalid range: ${spec}\n`);
      return 1;
    }
    path = reviewUrl(base, head);
  }

  const srv = await startServer({ cwd: root, port: port ?? 4777, portFallback: port === undefined });
  process.stdout.write(`promptlog viewer: ${srv.url}${path}\n${path !== '/' ? `all sessions:     ${srv.url}/\n` : ''}(Ctrl-C to stop)\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await srv.close();
  return 0;
}
