// `pl` entry point. Each subcommand lives in ./commands/<name>.ts and exports `run(args): Promise<number | void>`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `pl: prompt-native code review

Usage: pl <command> [args]

Capture
  install [--user]           Install Claude Code hooks (repo-local .claude/settings.local.json by default)
  hook <Event>               (internal) handle a Claude Code hook event; reads JSON on stdin
  import <transcript.jsonl>  Import an existing Claude Code transcript (no per-turn snapshots)

Browse
  ls                         List captured sessions
  show <session> [--raw]     Print a session's turns
  review <base>..<head>      Conversations behind a commit range (a "PR")
  view [<base>..<head>]      Open the review viewer in a browser

Interrogate
  ask <session> --at <turn> "question"   Ask a question against the conversation + repo state at a turn
  asks <session>                         List past questions asked against a session
  fork <session> --at <turn> [--exec]    Continue the conversation from a turn in a new worktree
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (!/^[a-z][a-z-]*$/.test(cmd)) {
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 1;
  }
  const file = fileURLToPath(new URL(`./commands/${cmd}.ts`, import.meta.url));
  if (!existsSync(file)) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  }
  const mod = (await import(file)) as { run: (args: string[]) => Promise<number | void> };
  return (await mod.run(rest)) ?? 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
