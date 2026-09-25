# promptlog storage format (schema 1)

All data lives in the repo it describes, under custom refs. Whoever can fetch the repo can read the conversations.

## Refs

`refs/promptlog/sessions/<sessionId>`: one per agent session. It's an append-only commit chain: every capture (each `Stop` hook, plus `SessionEnd`) adds a commit whose parent is the previous capture. Commit message: `turn <N>: <first line of prompt>`.

Push and fetch explicitly:

```
git push origin 'refs/promptlog/*:refs/promptlog/*'
git fetch origin '+refs/promptlog/*:refs/promptlog/*'
```

## Tree of each session commit

```
session.json                   SessionMeta (src/core/types.ts)
turns/000001/meta.json         TurnMeta
turns/000001/transcript.jsonl  raw agent transcript lines belonging to this turn (redacted)
turns/000001/before            tree entry: repo working tree when the prompt was submitted
turns/000001/after             tree entry: repo working tree when the agent stopped
turns/000001/subagents/*.jsonl optional subagent transcripts
```

- **Turn** = one human prompt plus everything up to the next human prompt. The turn number is the prompt's position in the transcript (`isHumanPrompt` in `src/core/transcript.ts`), so transcript chunks and snapshots always line up.
- **Snapshots** (`before`/`after`) come from a per-session temp index (`GIT_INDEX_FILE`) + `git add -A` + `write-tree`. They include tracked files and untracked files that aren't ignored. `.gitignore`d files (e.g. `.env`) are never included. Snapshot trees share objects with normal history, so they cost little.
- `before(N)` vs `after(N-1)` shows **human edits between turns**. `before(N)` vs `after(N)` shows **what the agent did in turn N**.
- Captures rewrite only the last two turns, because transcripts flush late. Older turn trees are reused as-is.
- Transcript text passes through a redactor before it's written. A snapshot excludes `.env`, but the transcript can still contain its contents if the agent read the file.

## Linking conversations to code (many-to-many)

- `TurnMeta.commits` lists the commits created during that turn (`headBefore..headAfter`).
- Commits made while a session is active get a trailer `Promptlog: <sessionId>#<turn>` (one line per session). This covers commits the human makes by hand after a turn, and it survives squash merges because git carries trailers into squash messages.
- A **review** (the "PR") is a commit range `base..head`. `assembleReview` (`src/core/review.ts`) picks every session with a turn linked to a commit in the range, then slices that session. The slice runs from just after its last turn that committed *outside* the range, through its last in-range committing turn, and on through the trailing discussion. So:
  - several sessions → one review: several slices, ordered by time;
  - one session → several reviews: each review gets its own slice.

## Local, unpushed state

`<git-dir>/promptlog/`:
- `sessions/<id>.json`: pending turn (before-snapshot, HEAD at prompt time) and turns since the last commit (feeds the trailer hook)
- `index-<id>`: temp index used for snapshots
- `errors.log`: hook failures. Hooks never block the agent.
