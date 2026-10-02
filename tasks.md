# tasks.md: prompt-native code review

Working name: **promptlog** (CLI `promptlog`, git refs `refs/promptlog/*`). The CLI was `pl` until 2026-09-26; renamed because macOS ships `/usr/bin/pl`.

## Vision (one paragraph)

GitHub made code diffs the thing you review. When most code is written by an AI in a conversation, the conversation should be what you review. The code diff stays available, like assembly under a compiler. A reviewer opening a PR sees how it was asked for, what the AI proposed, where the author pushed back and what never got answered. Raw logs are one click away. Every point in a conversation is a live, queryable state: "at turn 14, does this still hardcode Y?" loads that turn's transcript and repo snapshot and answers with one extra prompt. Fork from any turn to keep going.

Assumptions: reviewers have access to the same git repo. "State" means git-visible files only, so nothing gitignored. Claude Code comes first; other agents come later.

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Build our own capture layer, borrowing ideas and code from AgentNote (MIT, TypeScript) and Entire (MIT, Go). Neither ships full transcripts plus per-turn repo state to teammates, and interrogate/fork needs both. | ✅ agreed |
| D2 | TypeScript run directly by Node's type stripping (Node ≥22.18; user runs 24). No build step, zero runtime deps. Infra later: Cloudflare first, GCP (Cloud Run) for long-running work. | ✅ agreed |
| D3 | Storage lives in the same repo under custom refs (`refs/promptlog/sessions/<id>`), pushed and fetched alongside branches. Repo access = conversation access. | ✅ agreed |
| D4 | Summaries and interrogation run on headless `claude -p` (the user's Claude plan). No API key needed until CI. | ✅ agreed |
| D5 | v0 is **local git only**: no GitHub. A "PR" = a commit range `base..head` on local branches; raw git diffs. | ✅ agreed |
| D6 | Snapshots include untracked-but-not-ignored files. | ✅ agreed |
| D7 | Sessions ↔ PRs are many-to-many: linking goes through commits (`TurnMeta.commits` + `Promptlog:` trailers), and reviews slice sessions by commit range. | ✅ built into the core |
| D8 | Cheap asks use **Jev** (TypeSafe AI: typed yes/no judgments, $0.042/Mtok input) to pick turns and verdicts, and **Gemini Flash** to write text. Not Haiku. Both are paid per use via API keys, unlike D4. Decision calls go through **Dopp** (`https://dopp.sh/v1/systemone`, a Jev-compatible proxy that records every request so the user can train their own model), configured in `~/.config/promptlog/config.json` (per-repo override: gitignored `.promptlog/config.local.json`), next to the Gemini key. Full asks at a turn (`--at`) and fork stay on Claude Code. Goal: a hosted page where anyone can interrogate a PR from a phone. | ✅ agreed 2026-09-26 |

## Data model (locked for schema 1; see docs/format.md, which is authoritative)

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

### M0: Foundations ✅ (orchestrator)
- [x] Scaffold single-package TS repo (`src/core`, `src/capture`, `src/viewer`, `src/ask`, `src/summarize`, `src/cli/commands/*`)
- [x] Data model: `docs/format.md` + `src/core/types.ts`
- [x] Git store: per-turn commits, before/after worktree snapshots, idempotent re-capture (`src/core/store.ts`)
- [x] Transcript normalizer + turn splitter (`src/core/transcript.ts`)
- [x] Hook handler + `promptlog install|hook|import|ls|show|review`
- [x] Review assembly: commit range → session slices, many-to-many (`src/core/review.ts`)
- [x] `childClaudeEnv()`: strip parent-session env vars when spawning `claude` from inside Claude Code (found the hard way: nested runs reused the parent's session id)
- [x] Demo fixture `fixtures/demo.bundle`: 3 real captured sessions (pushback turn, 2 sessions → 1 PR, 1 session on another branch). Verified: `promptlog review main..feature/rates` pulls session A turns 1–4 + session B and excludes session C
- [ ] Still needed: a fixture with a subagent and a `/compact`

### M1: Capture (parallel track A) ✅ done
- [x] Claude Code plugin with hooks: `SessionStart`, `UserPromptSubmit`, `Stop` (turn boundary → write turn commit + state snapshot), `SubagentStop`, `SessionEnd`
- [x] Git plumbing writer: temp-index snapshot, tree building, append commit, update-ref (never touches the user's index/worktree). Files > 5 MB skipped; captures are idempotent
- [x] Redaction pass before anything is written (`src/capture/redact.ts`: provider formats, assignments, dotenv entropy; `.promptlog/redact.json` for extra patterns)
- [x] `promptlog push` / `promptlog fetch` (refspec config), optional pre-push hook (`promptlog install --auto-push`)
- [x] Commit trailer hook (`prepare-commit-msg` + `commit-msg` + `post-commit`, chained with existing hooks)
- [x] `promptlog ls` / `promptlog show <session>`
- Perf (2,000 files, ~5 MB transcript): warm Stop ≈ 170 ms in-process, ≈ 300 ms via `bin/promptlog`; `PL_PERF=1 node --test test/capture-perf.test.ts`
- Open: interrupted turns (no Stop) keep their pending snapshot only until the next prompt; `promptlog fetch` keeps local on divergence instead of merging `refs/promptlog/asks/*`

### M2: Review viewer ✅ (`promptlog view`, screenshots in docs/screenshots/)
Follow-ups:
- [ ] Per-file "jump to diff" from turn chips
- [ ] Screenshot/fixture showing the "human edited between turns" marker
- [ ] `promptlog view [branch|PR]` serves a local web UI
- [ ] Conversation-first layout: human turns prominent; AI replies collapsed to one-liners; tool calls collapsed; raw log expandable per turn
- [ ] Code diff as a secondary tab, per turn and cumulative
- [ ] "Ask at this turn" box on every turn (wires to M3)

### M3: Interrogate + fork ✅ (see docs/ask-fork.md)
Live demo: the same question at turn 1 vs turn 2 gets different, correct answers (USD hardcoded/unkeyed cache → `?base=`-keyed Map).
Follow-ups:
- [ ] Merge diverging `refs/promptlog/asks/*` from multiple reviewers (union of files); a forced fetch currently drops unpushed asks
- [ ] Haiku sometimes offers to make changes at the end of an answer. Tighten the framing prompt
- [ ] ~$0.22/ask on haiku (full history re-read, no warm cache). Consider a summary-prefix mode for long sessions
- [ ] `promptlog ask <session> --at <turn> "question"`: materialize the `state/` tree into a temp worktree, write the transcript truncated at that turn (rewrite cwd paths), run `claude -p --resume <file> --fork-session`, return the answer
- [ ] `promptlog fork <session> --at <turn>`: same, but interactive, leaving you in a live session on a new branch
- [ ] Save asks as a thread on the session (`asks/` in the ref) so other reviewers see Q&A

### M3b: Quick ask ✅ (see docs/quick-ask.md)
`promptlog ask [<session>|<base>..<head>] "question"` with no `--at`: Gemini Flash maps each turn (did / decided / deferred, cached per turn), Jev scores each turn against the question, code picks the turns and a verdict, and Flash writes the answer from those turns plus their diffs. `promptlog map` prints the notes. Tests use fake models (`test/quick.test.ts`).
- [x] Decision calls via Dopp (2026-09-26): one live scoring request on the demo's Redis turn answered by jev-1.13.0 in 0.6 s (relevant 0.92, skipped 0.98)
- [x] Live end to end (2026-09-26, `PL_LIVE=1 node --no-warnings --test test/quick.live.test.ts`): Redis question → verdict "no" 98% from session A turn 2, answer quotes the TODO; "separate entry per base?" → "yes" 96%, answer quotes the `Map`. ~6 s, 6 Jev requests (~4.7k tokens), ~4–5k Gemini tokens in. Keys now live in `~/.config/promptlog/config.json`
- [x] Keys in `~/.config/promptlog/config.json` for every repo (2026-09-27); a repo's `.promptlog/config.local.json` overrides field by field. Tests use a temp `XDG_CONFIG_HOME` so they never read real keys
- [ ] Later: a hosted/SaaS option, so reviewers don't need their own keys
- [ ] Tune `THRESHOLDS` on real answers; add quick-ask cases to the eval set
- [ ] Push the map with the sessions (a `refs/promptlog/maps/*` ref) so teammates don't rebuild it; build it in the pre-push hook or CI
- [x] Viewer redesign (2026-09-27, from the user's review of a real session): pages lead with a headline, key turns as "asked / did" (terminal commands folded), **Beyond what was asked** (diff vs requests, with Claude's reason or "never mentioned"), the quick Ask box, and **Files changed** (why + where, expandable diff). Full conversation collapsed. Deep review (claude -p) only on click; per-turn deep ask labelled as using the Claude plan
- [x] Summary layers: raw → per-turn notes → file reasons / beyond-the-ask / headline, each cached; the glance never re-reads the raw chat
- [x] Code search in quick asks: Gemini picks patterns (always the removed/old values), `git grep` at the PR head or last snapshot. Found `limits.mjs:40` still using `TYPESAFE_API_KEY` in askjevs
- [x] Yes/no chip: Jev answers the question as asked; the chip follows the written answer and shows whether Jev agreed
- [ ] Deep ask (`--at`, claude -p) still resumes the full transcript (~$0.40 on Opus for a 4-turn session). Give it the layers instead: notes + picked turns + search, in a worktree at that turn
- [ ] Beyond-the-ask is model-judged and can vary run to run (the hardcoded token was listed once, then treated as requested). Consider a deterministic pass for secrets and removed checks
- [ ] Hosted, phone-friendly review page whose Ask box calls quick ask on a server (Cloudflare Worker)
- [ ] Very long sessions: batch Jev turn cards (up to 64k tokens per request) instead of one request per turn

### M4: The taste layer ✅ (`promptlog summarize`, prompt v4 in src/summarize/prompt.md)
Eval (`npm run eval`, 13 weighted items on the demo PR): v1 58% → v4 ~91% coverage, no false claims. About $0.15 and 90s per summary on sonnet; cached afterwards.
Follow-ups:
- [ ] Eval judge (haiku) is noisy; use a stronger judge or multiple runs
- [ ] Optional `riskFlags[].category`
- [ ] Session-to-session diff (two attempts at the same task; fork vs parent)
- [ ] More eval fixtures beyond the one demo PR
- [ ] Review summary: intent, plan, alternatives considered and rejected, human pushbacks/corrections, open loops (raised and never resolved), assumptions
- [ ] Plan-vs-diff check: what the AI said it would do vs what the code diff actually contains
- [ ] Eval set: 5–10 fixture sessions with hand-written "what a reviewer should notice"
- [ ] Session-to-session diff: two attempts at the same task, or a fork vs its parent

### M5: Meet reviewers where they are
- [ ] GitHub Action: on PR, fetch `refs/promptlog/*`, post/update a summary comment with a link to the viewer
- [ ] `/ask @turn14 …` PR comment trigger runs M3 in CI (needs a Claude token secret)

### Backlog (noticed along the way)
- [ ] `git log --all` shows promptlog capture commits. Document `git log --all --exclude='refs/promptlog/*'` or set `log.excludeDecoration`; consider fewer commits (the Stop and SessionEnd of the same turn both commit today)
- [ ] Getting code off the cloud container: ship `promptlog.bundle` checkpoints to the user (no remote yet)
- [ ] Fixture with a subagent + `/compact` + a human edit between turns
- [ ] `promptlog install` as a proper Claude Code plugin (`plugin/` + marketplace entry) instead of settings.json edits
- [x] Linking a fork's captured session to its parent (`SessionMeta.parent`)
- [x] Bug: `queue-operation` lines leaked the next prompt into turn N (fixed in splitByTurn)
- [ ] An interrupted turn loses its before-snapshot when the next prompt arrives
- [ ] `git commit --amend -m` drops the `Promptlog:` trailer
- [ ] `promptlog fetch` keeps the local ref on divergence instead of merging `refs/promptlog/asks/*` (same issue as the M3 follow-up)

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
