import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../core/git.ts';
import { installGitHooks } from '../../capture/githooks.ts';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd'] as const;

export function hooksConfig(plBin: string) {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `${plBin} hook ${ev}` }] }];
  return hooks;
}

const USAGE = `usage: promptlog install [--user] [--auto-push] [--no-git-hooks]
  --user          install Claude Code hooks in ~/.claude/settings.json instead of this repo's .claude/settings.local.json
  --auto-push     also push refs/promptlog/* whenever you git push (pre-push hook)
  --no-git-hooks  skip the git hooks (commit trailers)
`;

export async function run(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const plBin = fileURLToPath(new URL('../../../bin/promptlog', import.meta.url));
  const user = args.includes('--user');
  const root = repoRoot(process.cwd());
  let target: string;
  if (user) target = join(homedir(), '.claude', 'settings.json');
  else {
    if (!root) {
      process.stderr.write('not inside a git repository (use --user for a global install)\n');
      return 1;
    }
    target = join(root, '.claude', 'settings.local.json');
  }
  const settings = existsSync(target) ? (JSON.parse(readFileSync(target, 'utf8')) as Record<string, any>) : {};
  settings.hooks ??= {};
  for (const [ev, entries] of Object.entries(hooksConfig(plBin))) {
    const existing = (settings.hooks[ev] ?? []) as { hooks?: { command?: string }[] }[];
    const kept = existing.filter((e) => !e.hooks?.some((h) => h.command?.includes(' hook ' + ev) && /\/bin\/(pl|promptlog) hook /.test(h.command)));
    settings.hooks[ev] = [...kept, ...entries];
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  process.stdout.write(`installed promptlog hooks into ${target}\n`);

  if (root && !args.includes('--no-git-hooks')) {
    const res = installGitHooks(root, plBin, { autoPush: args.includes('--auto-push') });
    process.stdout.write(`installed git hooks (${res.installed.join(', ')}) into ${res.dir}\n`);
    for (const name of res.chained) process.stdout.write(`  kept your existing ${name} hook: it now runs from ${name}.pre-promptlog\n`);
  }
  return 0;
}
