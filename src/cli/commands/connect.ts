// promptlog connect [--name <repo>] [--namespace <ns>] [--no-backfill] [--leases <worker-url> --leases-key <key>]
//
// One command from a plain folder to review-ready:
//   1. git init if needed, and promptlog's hooks (Claude Code + git)
//   2. a private Cloudflare Artifacts repo named after the folder, unless an `artifacts` remote already exists
//      (wrangler creates it; a 90-day write token goes to git's credential store, never to the screen or the repo config)
//   2b. with --leases: this clone's agents share the repo's lease table on the review Worker (cloud/viewer) with agents
//      on other machines; the key goes to the macOS Keychain (elsewhere: git config promptlog.leasesKey)
//   3. import the Claude Code sessions this folder already has, linked to the commits they made
//   4. push every branch and the sessions; from then on promptlog pushes each commit (see src/capture/mirror.ts)
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { basename } from 'node:path';
import { gitMaybe, repoRoot } from '../../core/git.ts';
import { backfill } from '../../capture/backfill.ts';
import { checkSharedLeases, useSharedLeases } from '../../capture/leases.ts';
import { PUSH_REFSPEC } from '../../capture/sync.ts';
import { run as install } from './install.ts';

const USAGE = 'usage: promptlog connect [--name <repo>] [--namespace <ns>] [--no-backfill] [--leases <worker-url> --leases-key <key>]\n';
const REMOTE = 'artifacts';
const TOKEN_TTL_S = 90 * 24 * 3600;
/** Artifacts includes 1 GB of storage; leave room for the sessions. */
const MAX_PUSH_BYTES = 900e6;

const say = (s: string) => process.stdout.write(s + '\n');
const opt = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export async function run(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const leases = opt(args, '--leases');
  const leasesKey = opt(args, '--leases-key') ?? process.env.PROMPTLOG_LEASES_KEY;
  if (leases && !leasesKey) {
    return fail("--leases needs the repo's lease key too (--leases-key <key>). Open the review page's /leases with your view key: it shows the full command.");
  }
  const cwd = process.cwd();
  let root = repoRoot(cwd);
  if (!root) {
    const init = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
    if (init.status !== 0) return fail(`git init failed: ${init.stderr.trim()}`);
    root = repoRoot(cwd)!;
    say(`Started a git repo in ${root}`);
  }

  // 1. Hooks: record Claude Code sessions, tag commits, push on every commit.
  if ((await install(['--auto-push'])) !== 0) return fail('installing hooks failed');

  // 2. The review repo.
  const remotes = (gitMaybe(['remote'], { cwd: root }) ?? '').split('\n');
  let repoName = (opt(args, '--name') ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (remotes.includes(REMOTE)) {
    say(`Using the existing "${REMOTE}" remote.`);
    const existing = /([^/]+?)(?:\.git)?\/?$/.exec(gitMaybe(['remote', 'get-url', REMOTE], { cwd: root }) ?? '')?.[1];
    if (existing) repoName = existing;
  } else {
    const name = repoName;
    const ns = opt(args, '--namespace') ?? 'promptlog';
    if (!name) return fail('pick a repo name with --name');
    const branch = gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root }) ?? 'main';
    let repo = wrangler(['artifacts', 'repos', 'create', name, '--namespace', ns, '--default-branch', branch, '--json']);
    const created = typeof repo?.remote === 'string';
    if (!created) repo = wrangler(['artifacts', 'repos', 'get', name, '--namespace', ns, '--json']);
    const remote = typeof repo?.remote === 'string' ? repo.remote : '';
    if (!remote) return fail(`couldn't create or find the Artifacts repo "${name}" (is wrangler logged in? try \`npx wrangler login\`)`);
    const tok = wrangler(['artifacts', 'repos', 'issue-token', name, '--namespace', ns, '--scope', 'write', '--ttl', String(TOKEN_TTL_S), '--json']);
    const token = String(tok?.plaintext ?? tok?.token ?? '');
    if (!token) return fail('Artifacts gave no write token');
    const url = new URL(remote);
    url.username = 'x';
    gitMaybe(['remote', 'add', REMOTE, url.toString()], { cwd: root });
    storeCredential(root, url, token);
    say(`${created ? 'Created' : 'Connected to'} the private repo "${name}" on Cloudflare Artifacts (login saved until ${String(tok?.expires_at ?? '').slice(0, 10) || 'it expires'}).`);
  }

  // 2b. The lease table shared with agents on other machines.
  if (leases && leasesKey) {
    const r = connectLeases(root, leases, repoName, leasesKey);
    if (r !== 0) return r;
  }

  // 3. Past sessions.
  if (!args.includes('--no-backfill')) {
    const b = backfill(root, { onWarning: (m) => process.stderr.write(`warning: ${m}\n`) });
    say(b.sessions ? `Brought in ${b.sessions} past Claude Code session(s): ${b.turns} turns, linked to ${b.commitsLinked} commit(s).` : 'No past Claude Code sessions found for this folder.');
    for (const s of b.skipped) process.stderr.write(`skipped ${s}\n`);
  }

  // 4. First push: every branch plus the sessions, unless that's too big.
  const heads = gitMaybe(['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: root });
  if (!heads) {
    say('Nothing committed yet. Your first commit will push itself.');
    return 0;
  }
  const big = pushSize(root);
  if (big.total > MAX_PUSH_BYTES) {
    say(`Not pushing: the history is ${(big.total / 1e9).toFixed(1)} GB and the review repo holds about 1 GB. Biggest files:`);
    for (const f of big.largest) say(`  ${(f.size / 1e6).toFixed(0)} MB  ${f.path}`);
    say('Stop tracking them (git rm --cached, then add them to .gitignore), and rewrite old history if they are in it, then run `promptlog connect` again.');
    return 1;
  }
  // A repo created a moment ago can drop the first push ("RPC failed ... Broken pipe"): try a few times.
  let push;
  for (let attempt = 1; ; attempt++) {
    push = spawnSync('git', ['push', '--no-verify', '--quiet', REMOTE, '+refs/heads/*:refs/heads/*', PUSH_REFSPEC], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PROMPTLOG_PUSHING: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    if (push.status === 0 || attempt === 4) break;
    spawnSync('sleep', [String(3 * attempt)]);
  }
  if (push.status !== 0) return fail(`first push failed: ${push.stderr.trim()}`);
  say(`Pushed ${heads.split('\n').length} branch(es) (${(big.total / 1e6).toFixed(0)} MB). From now on promptlog pushes every commit.`);
  return 0;
}

/**
 * Point this clone's leases at the review Worker. `url` is the Worker (…workers.dev) or the table itself
 * (…/__leases/<repo>); the per-repo key is shown on the Worker's /leases page to people who have the view key.
 */
function connectLeases(root: string, url: string, repoName: string, key: string): number {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail(`--leases needs the review Worker's URL, e.g. https://promptlog-viewer.<you>.workers.dev (got "${url}")`);
  }
  if (!u.pathname.includes('/__leases/')) u = new URL(`/__leases/${repoName}`, u.origin);
  const table = u.origin + u.pathname.replace(/\/+$/, '');
  const where = useSharedLeases(root, table, key);
  const check = checkSharedLeases(root);
  if ('error' in check) {
    say(`Saved the shared lease table (${table}, key in the ${where}), but it didn't answer: ${check.error}. Agents use this machine's own table until it does.`);
    return 0;
  }
  say(`Agents here now share leases with other machines through ${u.origin} (${check.leases.length} file(s) held right now; key saved in the ${where}).`);
  say(`See who's working on what: ${u.origin}/leases?repo=${table.split('/').pop()}`);
  return 0;
}

function fail(msg: string): number {
  process.stderr.write(`promptlog connect: ${msg}\n`);
  return 1;
}

/** Run wrangler (from PATH, else npx) and parse its JSON output. Never prints it: it can hold tokens. */
function wrangler(args: string[]): Record<string, unknown> | null {
  const onPath = spawnSync('wrangler', ['--version'], { encoding: 'utf8' }).status === 0;
  const [cmd, pre] = onPath ? ['wrangler', []] : ['npx', ['--yes', 'wrangler']];
  const res = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = res.stdout ?? '';
  const start = out.indexOf('{');
  if (res.status !== 0 || start < 0) return null;
  try {
    return JSON.parse(out.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Save the token for this one repo URL. On macOS only the Keychain holds it: the URL's helper list is reset first (an
 * empty value), or git would also hand it to globally configured helpers such as `store`, which writes plain text
 * to ~/.git-credentials. Elsewhere it goes to whatever helper the user configured for git.
 */
function storeCredential(root: string, url: URL, token: string): void {
  const key = `credential.${url.protocol}//${url.host}`;
  gitMaybe(['config', `${key}.useHttpPath`, 'true'], { cwd: root });
  const input = `protocol=${url.protocol.replace(':', '')}\nhost=${url.host}\npath=${url.pathname.replace(/^\//, '')}\nusername=x\npassword=${token}\n\n`;
  if (platform() === 'darwin') {
    gitMaybe(['config', '--unset-all', `${key}.helper`], { cwd: root });
    gitMaybe(['config', '--add', `${key}.helper`, ''], { cwd: root });
    gitMaybe(['config', '--add', `${key}.helper`, 'osxkeychain'], { cwd: root });
    spawnSync('git', ['credential-osxkeychain', 'store'], { cwd: root, input, encoding: 'utf8' });
  } else {
    spawnSync('git', ['credential', 'approve'], { cwd: root, input, encoding: 'utf8' });
  }
}

/** Bytes a first push would send (every object reachable from a branch or a session), and the biggest files. */
function pushSize(root: string): { total: number; largest: { path: string; size: number }[] } {
  const objs = spawnSync('git', ['rev-list', '--objects', '--branches', '--glob=refs/promptlog/*'], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const check = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectsize:disk) %(objectsize) %(rest)'], {
    cwd: root,
    input: objs.stdout,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  let total = 0;
  const files: { path: string; size: number }[] = [];
  for (const line of (check.stdout ?? '').split('\n')) {
    const [type, disk, size, ...rest] = line.split(' ');
    if (!type) continue;
    total += Number(disk) || 0;
    if (type === 'blob' && rest.length) files.push({ path: rest.join(' '), size: Number(size) || 0 });
  }
  files.sort((a, b) => b.size - a.size);
  const seen = new Set<string>();
  return { total, largest: files.filter((f) => !seen.has(f.path) && seen.add(f.path)).slice(0, 5) };
}
