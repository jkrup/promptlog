# promptlog storage format (schema 1)

All data lives in the repo it describes, under custom refs. Whoever can fetch the repo can read the conversations.

## Refs

`refs/promptlog/sessions/<sessionId>`: one per agent session. It's an append-only commit chain: every capture (each `Stop` hook, plus `SessionEnd`) adds a commit whose parent is the previous capture. Commit message: `turn <N>: <first line of prompt>`.

Push and fetch explicitly:

```
git push origin 'refs/promptlog/*:refs/promptlog/*'
git fetch origin '+refs/promptlog/*:refs/promptlog/*'
```

`promptlog push [remote]` / `promptlog fetch [remote]` run these. `promptlog fetch` puts back any local ref the forced fetch would rewind (a session with unpushed turns).

## Tree of each session commit

```
session.json                   SessionMeta (src/core/types.ts)
turns/000001/meta.json         TurnMeta
turns/000001/transcript.jsonl  raw agent transcript lines belonging to this turn (redacted)
turns/000001/before            tree entry: repo working tree when the prompt was submitted
turns/000001/after             tree entry: repo working tree when the agent stopped
turns/000001/subagents/*.jsonl optional subagent transcripts (agent-<id>.jsonl, plus agent-<id>.meta.json when Claude Code wrote one)
```

- **Turn** = one human prompt plus everything up to the next human prompt. The turn number is the prompt's position in the transcript (`isHumanPrompt` in `src/core/transcript.ts`), so transcript chunks and snapshots always line up.
- **Snapshots** (`before`/`after`) come from a per-session temp index (`GIT_INDEX_FILE`) + `git add -A` + `write-tree`. They include tracked files and untracked files that aren't ignored. `.gitignore`d files (e.g. `.env`) are never included. Snapshot trees share objects with normal history, so they cost little.
- `before(N)` vs `after(N-1)` shows **human edits between turns**. `before(N)` vs `after(N)` shows **what the agent did in turn N**.
- Captures rewrite only the last two turns, because transcripts flush late. Older turn trees are reused as-is. A capture that would change nothing but `updatedAt` writes no commit. Entries other tools add to a turn directory or to the root tree are carried over.
- Files over 5 MB are left out of snapshots (via a pathspec on the snapshot's `git add`, never the user's ignore files).
- A subagent transcript is stored under the turn whose prompt has the same `promptId`; without one, under the latest turn.
- Transcript text passes through a redactor before it's written. A snapshot excludes `.env`, but the transcript can still contain its contents if the agent read the file. Secrets become `[REDACTED:<kind>]`; JSONL stays valid (string values are redacted, ids and signatures are not). Extra patterns: `.promptlog/redact.json` in the repo, e.g. `{"patterns": [{"name": "corp-token", "regex": "corp_[a-z0-9]{32}"}], "disable": ["high-entropy"], "allow": ["..."]}`; a named group `(?<secret>...)` limits redaction to that group.

## Linking conversations to code (many-to-many)

- `TurnMeta.commits` lists the commits created during that turn (`headBefore..headAfter`).
- Commits made while a session is active get a trailer `Promptlog: <sessionId>#<turn>` (one line per session, the latest turn since the last commit, or the turn in progress). `promptlog install` adds `prepare-commit-msg`/`commit-msg`/`post-commit` git hooks for this (and `pre-push` with `--auto-push`), chaining to existing hooks kept as `<name>.pre-promptlog`. This covers commits the human makes by hand after a turn, and it survives squash merges because git carries trailers into squash messages.
- A **review** (the "PR") is a commit range `base..head`. `assembleReview` (`src/core/review.ts`) picks every session with a turn linked to a commit in the range, then slices that session. The slice runs from just after its last turn that committed *outside* the range, through its last in-range committing turn, and on through the trailing discussion. So:
  - several sessions → one review: several slices, ordered by time;
  - one session → several reviews: each review gets its own slice.

## Asks (`refs/promptlog/asks/<sessionId>`)

Reviewers' questions put to a session at a turn (`promptlog ask`), with their answers. See `docs/ask-fork.md`.

- There's one ref per session, separate from `refs/promptlog/sessions/*` because capture rebuilds session trees and would drop anything else. The same refspec pushes and fetches it.
- It's an append-only commit chain. Each commit adds one file and has the message `ask turn <N>: <first line of question>`.
- The tree is flat: `<id>.json` per ask, where `id` is `<UTC yyyymmddThhmmssZ>-<6 hex>` (sortable, unique across machines). Content is a `StoredAsk` (`src/ask/asks.ts`), a superset of `AskResult` (`src/core/types.ts`):

```json
{ "schema": 1, "id": "20260925T191200Z-3fa9c1", "sessionId": "…", "turn": 2,
  "question": "…", "answer": "…", "askedAt": "2026-09-25T19:12:00.123Z", "askedBy": "Rita <rita@example.com>",
  "model": "haiku", "costUsd": 0.02, "forkSessionId": "<Claude Code session that answered>",
  "state": { "source": "after", "commit": "<checked-out commit>", "tree": "<snapshot tree>" } }
```

- Quick asks (`promptlog ask` without `--at`, `docs/quick-ask.md`) have no `state` or `forkSessionId`. They add `quick`: `{ target, verdict?, used, scores, usage, models }` (`QuickAskInfo` in `src/quick/types.ts`), and `turn` is the deciding or most relevant turn.
- `state.source` says which snapshot answered: `after` (turn N's after tree), `next-before` (turn N+1's before tree) or `head-after` (HEAD commit at the end of turn N, when no snapshot exists).
- Writers compare-and-swap the ref (`update-ref <ref> <new> <old>`) and retry. Since file names are unique, two diverged chains merge as the union of their files.

## Local, unpushed state

`<git-dir>/promptlog/`:
- `sessions/<id>.json`: pending turn (before-snapshot, HEAD at prompt time), turns since the last commit (feeds the trailer hook), last captured turn, subagent transcripts not yet stored
- `sessions/<id>.lock`: held while a hook updates that session
- `index-<id>`: temp index used for snapshots
- `errors.log`: hook failures. Hooks never block the agent.
- `fork.json` + `fork-<sessionId>-t<N>.jsonl`: only in worktrees created by `promptlog fork`. Parent `{sessionId, turn}` for capture to record as `SessionMeta.parent`, plus the resumable transcript (see `docs/ask-fork.md`).
- `resume-<sessionId>-t<N>.jsonl`: transcript for an ask's temporary worktree (removed with it).
- `cache/summary-<hash>.json`: cached review summaries (`src/summarize/cache.ts`).
- `cache/map-<sessionId>.json`: quick-ask map, one Gemini note per turn keyed by a hash of the turn (`src/quick/map.ts`, `docs/quick-ask.md`). Not pushed.

`<git-common-dir>/promptlog/worktrees/`: temporary worktrees for `promptlog ask` (removed after answering unless `--keep`).
