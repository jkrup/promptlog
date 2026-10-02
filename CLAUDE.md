# promptlog

Prompt-native code review: capture Claude Code conversations into git refs, review the conversation behind a commit range, and interrogate or fork any turn with the exact repo state from that turn. Read `tasks.md` (plan + status) and `docs/format.md` (storage format) first.

## Conventions
- TypeScript run directly by Node's type stripping (Node >= 22.18; user runs Node 24). No build step. Only use erasable syntax: no enums, no namespaces, no parameter properties. Relative imports use `.ts` extensions.
- Zero runtime dependencies so far. Adding one requires a good reason. Dev deps: typescript, @types/node.
- Tests use `node:test` + `node:assert/strict`, in `test/*.test.ts`. Run `npm test` and `npm run typecheck`.
- Git access goes through `src/core/git.ts` (sync spawn). Never touch the user's index or worktree from capture code.
- Hooks must never fail the agent: catch, log to `<git-dir>/promptlog/errors.log`, exit 0.
- CLI subcommands live in `src/cli/commands/<name>.ts` and export `run(args): Promise<number|void>`. They're discovered by filename, so there's no registry to edit.
- Code layout: `src/core` (types, git, transcript, store, review) is shared, so change it carefully. Feature areas: `src/capture`, `src/viewer`, `src/ask`, `src/summarize`, `src/quick` (quick asks: Jev + Gemini Flash over plain HTTPS, no SDKs).
- Viewer HTML is rendered by pure functions (model → HTML string) so it can later run on Cloudflare Workers.

## Fixtures
- `fixtures/demo.bundle`: a demo repo with captured sessions. `fixtures/demo.json` holds the session ids.
  Materialize it with `test/helpers.ts` → `cloneDemo()`, or by hand:
  `git clone -q fixtures/demo.bundle /tmp/x && cd /tmp/x && git fetch -q origin '+refs/promptlog/*:refs/promptlog/*' && git checkout -q feature/rates`
- `fixtures/transcripts/*.jsonl`: raw Claude Code transcripts from those sessions.
- Regenerate with `fixtures/make-demo.sh` (costs Claude turns).
