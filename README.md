# promptlog

Prompt-native code review. GitHub made the code diff the thing you review. When AI writes the code in a conversation, the **conversation** is what should be reviewed. promptlog captures Claude Code sessions into git, shows the conversation behind a branch or PR, and lets you **ask questions at any turn** against that turn's exact repo state.

## Quick start (Node ≥ 22.18, git, Claude Code)

```sh
git clone promptlog.bundle ~/Projects/promptlog && cd ~/Projects/promptlog && npm install
ln -s "$PWD/bin/pl" /usr/local/bin/pl      # or add bin/ to PATH

cd ~/code/your-repo
pl install                 # Claude Code hooks (.claude/settings.local.json) + git commit-trailer hooks
# ...use Claude Code as usual, commit as usual...
pl ls                      # captured sessions
pl review main..my-branch  # the conversations behind a branch (text)
pl view main..my-branch    # the review UI in your browser
pl summarize main..my-branch
pl ask <session> --at 2 "does this still hardcode USD?"
pl fork <session> --at 2 --exec   # continue from turn 2 in a new worktree
pl push / pl fetch         # share refs/promptlog/* with your remote
```

Try it on the demo without installing anything:

```sh
git clone -q fixtures/demo.bundle /tmp/demo && cd /tmp/demo \
  && git fetch -q origin '+refs/promptlog/*:refs/promptlog/*' && git checkout -q feature/rates \
  && git branch -f main origin/main && ~/Projects/promptlog/bin/pl view main..feature/rates
```

## How it works

- Hooks write one git commit per turn to `refs/promptlog/sessions/<id>`. Each holds the redacted transcript and snapshots of the working tree before and after the turn (`.gitignore` respected). Your branch, index and working tree are never touched. See `docs/format.md`.
- Conversations link to code through commits, so sessions and PRs are many-to-many.
- `ask` and `fork` materialize a turn's snapshot into a worktree and resume the conversation up to that point with `claude --resume <file> --fork-session`. See `docs/ask-fork.md`.

Plan and status: `tasks.md`. Conventions: `CLAUDE.md`.
