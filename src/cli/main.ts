// `promptlog` entry point. Each subcommand lives in ./commands/<name>.ts and exports `run(args): Promise<number | void>`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `promptlog: prompt-native code review

Usage: promptlog <command> [args]

Capture
  install [--user] [--auto-push]  Install Claude Code hooks (repo-local .claude/settings.local.json by default)
                             and git hooks for commit trailers (--auto-push: also push sessions on git push)
  hook <Event>               (internal) handle a Claude Code hook event; reads JSON on stdin
  trailer <msg-file>         (internal) git hook helper for Promptlog commit trailers
  import <transcript.jsonl>  Import an existing Claude Code transcript (no per-turn snapshots)
  push [remote]              Push captured sessions (refs/promptlog/*)
  fetch [remote]             Fetch teammates' sessions (keeps local unpushed turns)

Browse
  ls                         List captured sessions
  show <session> [--raw]     Print a session's turns
  review <base>..<head>      Conversations behind a commit range (a "PR")
  view [<base>..<head>]      Open the review viewer in a browser
  summarize [<base>..<head>] Reviewer summary: pushbacks, open loops, plan vs diff, risks

Interrogate
  ask [<session>|<base>..<head>] "question"  Quick answer from the whole conversation (Dopp + Gemini Flash;
                                         keys: DOPP_TOKEN, GEMINI_API_KEY or ~/.config/promptlog/config.json)
  ask <session> --at <turn> "question"   Ask a question against the conversation + repo state at a turn (Claude Code)
  map [<session>|<base>..<head>]         Per-turn notes quick asks search (what was done, decided, deferred)
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
