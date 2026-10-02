# Quick ask

`promptlog ask` without `--at` answers a reviewer's question from the whole conversation behind a session or a PR. It doesn't run Claude Code or check out a worktree. Code: `src/quick/`.

```
promptlog ask [<session> | <base>..<head>] [--model <gemini model>] [--no-save] [--json] "question"
promptlog map [<session> | <base>..<head>] [--json]
```

With no target it asks about HEAD against main/master, like `review` and `view`.

## Layers

Nothing above layer 0 re-reads the raw chat. Each layer is built once from the one below and cached.

| Layer | What | Built by | Cached in `<git-dir>/promptlog/cache/` |
|---|---|---|---|
| 0 | Raw transcript and per-turn diffs | capture | the session refs |
| 1 | One note per turn: asked, did, beyond the request, decided, deferred, minor | Gemini, from the raw turn | `map-<sessionId>.json`, per turn hash |
| 2 | Why each file changed; changes beyond what was asked (checked against the diff) | Gemini, from layer 1 + per-file diffs | `glance-<hash>.json` |
| 3 | Headline | same call as layer 2 | same |

"Where" lines in the files list come straight from the diff: the replaced line next to its replacement, trimmed to the part that differs. No model is involved.

## At a glance (`promptlog view`)

Session and review pages lead with:
- a headline;
- one "asked / did" pair per key turn, with terminal commands and small talk folded into one line;
- **Beyond what was asked**: changes the diff shows that nobody requested, with Claude's reason or "never mentioned in the conversation";
- an Ask box (quick ask, below);
- **Files changed**: why each file changed and where, expandable to its diff.

The full conversation is collapsed underneath. The page renders a model-free outline first and swaps in the Gemini version when `/api/glance` returns (a few seconds the first time, instant after). With no Gemini key the outline stays and the page says so. The long "deep review" (Claude Code, `src/summarize`) runs only when you click it.

## How a quick ask works

1. **Notes.** Layer 1 above.
2. **Score.** The decision endpoint (Jev, via Dopp here) gets one request per turn: the question plus a small card of the turn. It answers four yes/no questions: is the turn relevant, does it hold usable evidence, does it show the thing was handled, and does it show it was skipped. One more request on the question itself asks whether it's a yes/no question and whether searching the code would help.
3. **Pick.** Code picks up to 4 turns with relevance ≥ 0.45 and evidence ≥ 0.5, else the two best weak matches. Thresholds live in `THRESHOLDS` (`src/quick/ask.ts`).
4. **Search the code** (when it helps, e.g. "did it get every URL?"). Gemini picks up to 5 patterns from the question, the notes and the lines the work removed, so old values are always searched. `git grep` runs them read-only against the PR head, or the session's last snapshot.
5. **Yes/no.** For yes/no questions, Jev answers the question as asked from the notes, the picked turns and the search hits.
6. **Answer.** Gemini writes the answer from the outline, the picked turns in full (with their diffs) and the search hits. The chip follows the written answer and shows whether Jev agreed ("No · Jev leaned yes (64%)").

The ask is saved to `refs/promptlog/asks/<sessionId>` with the scores, verdict and search under `quick`. See `docs/format.md`.

## Keys and cost

- **Where keys live.** Put them in `~/.config/promptlog/config.json`. It's yours and works in every repo; `$XDG_CONFIG_HOME` is respected. Keep it `chmod 600`. A repo's `.promptlog/config.local.json` (gitignored) overrides it field by field. Env vars come last.
  ```json
  { "decision": { "url": "https://dopp.sh/v1/systemone", "apiKey": "us_…" }, "gemini": { "apiKey": "…" } }
  ```
- **Decision calls (Jev-style).** Any `POST /v1/systemone` endpoint with TypeSafe's request and response shape works. This setup uses [Dopp](https://dopp.sh/docs.md), a proxy that forwards to Jev by default and records every request as a training example for the key's project. Without a `decision` entry, calls go straight to TypeSafe with `TYPESAFE_API_KEY` (early access: https://console.typesafe.ai). Jev costs $0.042 per million input tokens, and output is free. A 20-turn PR is about 21 requests and 20–40k tokens. One demo turn with 4 questions was 957 tokens and took 0.6 s through Dopp.
- **Text (Gemini).** Set `"gemini": { "apiKey": "…", "model": "gemini-3.8-flash" }` in the same file (model is optional), or `GEMINI_API_KEY` / `GOOGLE_API_KEY`. Keys come from https://aistudio.google.com/apikey. The default model is `gemini-3.8-flash`. Google bills this per use; your Claude plan doesn't cover it. On the demo PR, one ask used about 4.2k tokens in and 0.7k out, plus a one-time map call per session, and took about 6 s.
- **What leaves the machine.** The decision endpoint gets turn cards: prompt, final reply, tools, files and the map note. Gemini also gets the picked turns' diffs. Transcripts are already redacted at capture. Dopp keys (`us_` + 40 hex) are a built-in redaction rule.

## When to use `--at` instead

A quick ask only sees the conversation and the per-turn diffs. Use `promptlog ask <session> --at <turn>` when the answer needs the code itself: reading other files, grepping, or running something. That runs Claude Code on your plan in a worktree restored to that turn (`docs/ask-fork.md`).

## Tests

`test/quick.test.ts` covers the clients, the map cache, picking and verdicts, and the full pipeline on the demo, all with fake models. `PL_LIVE=1 node --no-warnings --test test/quick.live.test.ts` runs the real thing when both keys are set.
