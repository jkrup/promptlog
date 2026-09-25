# tasks.md: prompt-native code review

Working name: **promptlog** (CLI `pl`, git refs `refs/promptlog/*`). Placeholder; rename is cheap until M1 ships.

## Vision (one paragraph)

GitHub made code diffs the thing you review. When most code is written by an AI in a conversation, the conversation should be what you review. The code diff stays available, like assembly under a compiler. A reviewer opening a PR sees how it was asked for, what the AI proposed, where the author pushed back and what never got answered. Raw logs are one click away. Every point in a conversation is a live, queryable state: "at turn 14, does this still hardcode Y?" loads that turn's transcript and repo snapshot and answers with one extra prompt. Fork from any turn to keep going.

Assumptions: reviewers have access to the same git repo. "State" means git-visible files only, so nothing gitignored. Claude Code comes first; other agents come later.

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Build our own capture layer, borrowing ideas and code from AgentNote (MIT, TypeScript) and Entire (MIT, Go). Neither ships full transcripts plus per-turn repo state to teammates, and interrogate/fork needs both. | Proposed, needs a thumbs-up |
| D2 | TypeScript on Node 22, published to npm. Matches AgentNote, so we can lift its prompt sanitizer and PR-report ideas. | Proposed, needs a thumbs-up |
| D3 | Storage lives in the same repo under custom refs (`refs/promptlog/sessions/<id>`), pushed and fetched alongside branches. Repo access = conversation access. | Proposed |
| D4 | Summaries and interrogation run on headless `claude -p` (the user's Claude plan). No API key needed until CI. | Proposed |
| D5 | v0 is local-first: CLI plus a local web viewer. PR comment/Action comes next. Hosted/social comes later. | Proposed |

## Data model (draft, to lock in M0)

One append-only commit chain per session, one commit per turn, at `refs/promptlog/sessions/<session-id>`. Each commit's tree:

```
meta.json            session id, agent, model, CC version, author, branch, base commit,
                     repo-relative cwd, parent session + fork turn (if forked)
turns/0001.jsonl     only the transcript lines new in this turn (O(n) storage, not a full copy per turn)
turns/0001.meta.json turn index, HEAD at turn end, commits made this turn, files touched
state/               the repo working tree at end of this turn, as a git tree
                     (temp index + `git add -A` + write-tree, so .gitignore is respected
                     and objects are shared with normal history)
summary.json         (optional, cached) generated review summary
```

Linking: record the HEAD and commits per turn. Add a `Promptlog-Session: <id>` trailer on commits (via git hook, same approach as Entire/AgentNote). The PR maps to a branch, which maps to its sessions. Squash/rebase: match by trailer, falling back to branch, falling back to patch-id.

## Milestones

### M0: Foundations (blocks everything; do first, mostly me)
- [ ] Create repo, attach to session, scaffold TS monorepo (`packages/core`, `packages/cli`, `packages/viewer`, `packages/plugin`)
- [ ] Lock the data model above in `docs/format.md` plus TypeScript types in `core`
- [ ] Collect fixtures: real Claude Code transcripts (dogfood this repo's own sessions), including a subagent, a `/compact` and a multi-session PR
- [ ] Transcript normalizer: Claude Code JSONL → `Turn[]` (human prompt, assistant text, tool calls/results, subagent refs). Defensive, because the format is internal and changes between versions

### M1: Capture (parallel track A)
- [ ] Claude Code plugin with hooks: `SessionStart`, `UserPromptSubmit`, `Stop` (turn boundary → write turn commit + state snapshot), `SubagentStop`, `SessionEnd`
- [ ] Git plumbing writer: temp-index snapshot, tree building, append commit, update-ref (never touches the user's index/worktree)
- [ ] Redaction pass before anything is written (regex + entropy; study Entire `redact/` and AgentNote's sanitizer). Needed because the transcript can contain `.env` contents even though snapshots exclude the file
- [ ] `pl push` / `pl fetch` (refspec config), optional pre-push hook
- [ ] Commit trailer hook (`prepare-commit-msg`)
- [ ] `pl ls` / `pl show <session>`

### M2: Review viewer (parallel track B, builds against fixtures from M0)
- [ ] `pl view [branch|PR]` serves a local web UI
- [ ] Conversation-first layout: human turns prominent; AI replies collapsed to one-liners; tool calls collapsed; raw log expandable per turn
- [ ] Code diff as a secondary tab, per turn and cumulative
- [ ] "Ask at this turn" box on every turn (wires to M3)

### M3: Interrogate + fork (parallel track C)
- [ ] `pl ask <session> --at <turn> "question"`: materialize the `state/` tree into a temp worktree, write the transcript truncated at that turn (rewrite cwd paths), run `claude -p --resume <file> --fork-session`, return the answer
- [ ] `pl fork <session> --at <turn>`: same, but interactive, leaving you in a live session on a new branch
- [ ] Save asks as a thread on the session (`asks/` in the ref) so other reviewers see Q&A

### M4: The taste layer: summaries and diffs (parallel track D; prompt work first, UI after)
- [ ] Review summary: intent, plan, alternatives considered and rejected, human pushbacks/corrections, open loops (raised and never resolved), assumptions
- [ ] Plan-vs-diff check: what the AI said it would do vs what the code diff actually contains
- [ ] Eval set: 5–10 fixture sessions with hand-written "what a reviewer should notice"
- [ ] Session-to-session diff: two attempts at the same task, or a fork vs its parent

### M5: Meet reviewers where they are
- [ ] GitHub Action: on PR, fetch `refs/promptlog/*`, post/update a summary comment with a link to the viewer
- [ ] `/ask @turn14 …` PR comment trigger runs M3 in CI (needs a Claude token secret)

### Later
- Hosted viewer, profiles, discovery (only for redacted prompt cards; Amp shut down public discovery over secret leakage)
- Other agents: Codex, Cursor, Gemini CLI; Agent Trace interop; import from Entire/AgentNote refs
- Compression: distill a session into a reusable prompt or skill

## Parallelization plan
M0 is serial and blocking, about one session. After the data model and fixtures land, fan out subagents on A (capture), B (viewer), C (ask/fork) and D (summary prompts + evals). They share only `core` types and fixtures.

## Open questions
- Name?
- Per-turn snapshots include untracked-but-not-ignored files. Is that OK, or tracked files only?
- Privacy/culture: a "draft/private" flag so people can keep a session off the PR?
- Should asks/forks by reviewers be visible to the author by default?

## Prior art (read before building the matching piece)
- AgentNote (MIT, TS): https://github.com/wasabeef/AgentNote. Git notes per commit, PR summary + hidden reviewer context, dashboard. Stores only a pointer to the transcript, so reviewers can't see raw logs or interrogate.
- Entire CLI (MIT, Go): https://github.com/entireio/cli. Full transcripts in `refs/entire/checkpoints/*`, `Entire-Checkpoint` trailers, squash handling, redaction, `why`, `rewind`, `review`. Mid-session code snapshots stay on local shadow branches and are never pushed.
- simonw/claude-code-transcripts: HTML rendering of Claude Code JSONL (viewer reference).
- Claude Code docs: hooks (`transcript_path`, `agent_transcript_path`, `last_assistant_message`), `--resume <path>`, `--fork-session`.
