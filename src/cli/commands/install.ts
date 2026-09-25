import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../core/git.ts';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;

export function hooksConfig(plBin: string) {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `${plBin} hook ${ev}` }] }];
  return hooks;
}

export async function run(args: string[]): Promise<number> {
  const plBin = fileURLToPath(new URL('../../../bin/pl', import.meta.url));
  const user = args.includes('--user');
  let target: string;
  if (user) target = join(homedir(), '.claude', 'settings.json');
  else {
    const root = repoRoot(process.cwd());
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
    const kept = existing.filter((e) => !e.hooks?.some((h) => h.command?.includes(' hook ' + ev) && h.command.includes('/bin/pl')));
    settings.hooks[ev] = [...kept, ...entries];
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  process.stdout.write(`installed promptlog hooks into ${target}\n`);
  return 0;
}
