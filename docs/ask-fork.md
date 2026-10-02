# Ask and fork: resuming a conversation at turn N

`promptlog ask` and `promptlog fork` load a captured session **as of turn N**: the transcript up to and including turn N, and the repo exactly as it was at the end of turn N. Code: `src/ask/`. Storage for asks: `docs/format.md` ("Asks"). For a cheap answer from the whole conversation without a worktree, `promptlog ask` without `--at` uses Jev + Gemini Flash instead: see `docs/quick-ask.md`.

```
promptlog ask  <session> --at <turn> [--model m] [--keep] [--no-save] [--json] "question"
promptlog asks <session> [--at <turn>] [--json]
promptlog fork <session> --at <turn> [--branch name] [--dir path] [--model m] [--exec]
```

API (`src/ask/index.ts`): `ask()`, `listAsks()`, `materialize()`, `fork()`, `execFork()`, `readForkMarker()`.

## The resume recipe (found empirically, Claude Code 2.1.282)

1. **Materialize the state.** Turn N's `after` snapshot tree. If it's missing, fall back to turn N+1's `before`, then to the tree of `headAfter`. Wrap the tree in a commit with `git commit-tree <tree> -p <headAfter|headBefore>` (fixed identity and the turn's timestamp, so it's deterministic). If the tree equals the parent's tree, check out the parent itself. Then run `git worktree add --detach <dir> <commit>`, or `-b <branch>` for a fork.
2. **Write the transcript.** Take `transcriptUpTo(stored, N)`, then:
   - drop `queue-operation` lines;
   - rewrite the author's absolute repo root to the worktree root in every JSON string;
   - drop a trailing `tool_use` that has no `tool_result`.

   Write the result to any absolute `.jsonl` path. We use `<worktree-git-dir>/promptlog/…`, which is removed along with the worktree.
3. **Resume.** Run `claude --resume <absolute-path> --fork-session` with the worktree as cwd, for both `-p` and interactive mode.

That's all. Claude Code copies the lines into a **new** session under `~/.claude/projects/<munged-worktree-path>/<new-id>.jsonl`, rewriting `sessionId` and `cwd` and **keeping message uuids**.

### What the experiments showed

| Question | Finding |
|---|---|
| Must the file live under `~/.claude/projects/<munged-cwd>/`? | No. Any absolute path works, in `-p` and interactive mode. |
| Must `sessionId` be rewritten / the file named `<uuid>.jsonl`? | No. `--fork-session` assigns a fresh id. The truncated file wins even when the original session id exists on the same machine. |
| Must `cwd` fields be rewritten? | Not for resume to work: it succeeds even when the original cwd doesn't exist. We rewrite anyway, see below. |
| Dangling `tool_use` at the end? | Claude Code tolerates it and treats the call as interrupted. We drop it anyway so the history ends cleanly and the snapshot is the only source of truth. |
| `queue-operation` lines? | The store files the *next* prompt's `enqueue` line under the previous turn, so a turn-N transcript contains turn N+1's prompt text. They're not replayed as messages, but we drop them so the future prompt can't leak. |
| Resume by id later? | `claude --resume <forkSessionId>` finds the session from any directory. Its worktree is gone unless `promptlog ask --keep`. |

**Why rewrite paths.** Tool inputs and results in the transcript carry absolute paths such as `/home/dana/repo/src/server.js`. On the author's own machine that path exists, but it holds the *current* state, not turn N's. A resumed model that reuses a path from history would read the wrong state, and a forked session would **edit the author's real checkout**. Rewriting the root (whole path prefixes only) makes every path in history point at the worktree.

**Why ask worktrees live under `.git/` and fork worktrees don't.** Asks use `<git-common-dir>/promptlog/worktrees/<sid8>-t<N>-<rand>`: hidden, and removed after the answer. Claude Code gates **every edit under a `.git/` path** behind a manual approval, even with `--permission-mode acceptEdits`. That doesn't matter for read-only asks and adds a layer of safety there, but it makes an interactive fork unusable. So forks default to a sibling of the main worktree, `<main-root>-fork-<sid8>-t<N>`, which `--dir` overrides.

## ask

`claude -p --output-format json --resume <path> --fork-session` plus:

| Flag | Why |
|---|---|
| `--tools Read,Grep,Glob,Bash` | Only these built-in tools exist in the session. |
| `--allowedTools Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(ls:*),Bash(cat:*)` | Read-only git/shell. |
| `--disallowedTools Edit,Write,NotebookEdit` | Belt and braces. |
| `--permission-mode dontAsk` | Anything not pre-approved is denied, not prompted. A `sed -i` attempt was denied in testing. |
| `--settings '{"disableAllHooks":true}'` | Don't capture the ask as a new promptlog session, and don't run the user's other hooks. Verified: a planted Stop hook fires without this flag and not with it. |
| `--append-system-prompt …` | Reviewer framing: state at turn N, the worktree is restored, later turns haven't happened, cite files, don't modify, don't offer changes. |

The user message is `[Reviewer question about the state at turn N. Answer it; do not change anything or offer to.]` followed by the question. Without that line, the resumed coding assistant tends to end with "Should I update it…?". The stored question is the raw text.

The process is spawned asynchronously (`runClaudeJsonAsync` in `src/ask/run.ts`) with `childClaudeEnv()`, so the viewer's HTTP handler doesn't block, and a nested run can't hijack a parent Claude Code session. The worktree is removed afterwards unless `keep` is set. Claude's own session file for the ask is left alone, so `claude --resume <forkSessionId>` keeps working.

## fork

`promptlog fork` does the following:
- materializes turn N into a new worktree on branch `promptlog/fork-<sid8>-t<N>`, running checkout hooks as usual;
- writes the transcript to `<worktree-git-dir>/promptlog/fork-<sessionId>-t<N>.jsonl`;
- writes the marker below;
- copies `.claude/settings.local.json` into the worktree when it's absent there, because repo-local promptlog hooks live in that normally gitignored file;
- prints `cd <worktree> && claude --resume <path> --fork-session`, or runs it with `--exec`. Hooks stay **on**, so the fork gets captured like any other session.

**Parent marker** (`<worktree-git-dir>/promptlog/fork.json`, i.e. `localDir(worktreeRoot)/fork.json`; `readForkMarker(cwd)`):

```json
{ "schema": 1, "parent": { "sessionId": "<id>", "turn": 2 }, "parentPromptUuid": "<uuid of turn 2's prompt>",
  "transcriptPath": "…", "branch": "promptlog/fork-e2741880-t2", "commit": "<sha>", "source": "after", "createdAt": "…" }
```

Capture can set `SessionMeta.parent` from it when a session in that worktree has `parentPromptUuid` in its transcript. `--fork-session` keeps message uuids, so a fork's transcript contains the parent's turns 1..N verbatim, as its own turns 1..N. The marker is deleted together with the worktree (`git worktree remove`).

## Known limitations

- Asks refs from two reviewers diverge. Fetching with `+refs/promptlog/*` overwrites local unpushed asks, and pushing a diverged ref is rejected. Ask file names are unique, so a merge is a plain union of tree entries, but it isn't automated yet.
- "State" means git-visible files. Gitignored files (`.env`, `node_modules/`) aren't in the worktree, so answers about runtime behaviour can't execute anything, and asks are read-only anyway.
- If Claude Code's `.git/` edit protection ever changes, the fork location rationale should be revisited.
- Ask worktrees left behind by a crash stay under `<git-common-dir>/promptlog/worktrees/` until `git worktree remove` or `git worktree prune` after deleting the directory.
