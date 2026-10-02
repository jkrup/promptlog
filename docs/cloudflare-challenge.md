# Plan: Cloudflare "Build the next GitHub" challenge

Researched 2026-10-01. Sources: https://www.cloudflare.com/git-competition/, the official rules PDF linked there, and https://developers.cloudflare.com/artifacts/.

## The rules that matter

- **Deadline:** October 14, 2026, 11:59 PM PDT. Finalists are told October 16.
- **Who can enter:** US or Canada residents, 18 or older. One submission per entrant.
- **What to submit:** an application form, a **5–10 minute demo video**, the **source repo**, and **instructions to run it**.
- **Must use Cloudflare Workers and Artifacts.** The project "must enable multiple agents working on changes concurrently."
- **License:** MIT, Apache 2.0 or BSD, with a `LICENSE` file in the repo. You keep ownership of the code. Cloudflare may use your name, video and slides for promotion.
- **Judging** (each scored 1–5):
  - **50%:** originality and quality of the prototype for agent-oriented software collaboration
  - **25%:** multi-agent concurrency, coordination, **context preservation**, **review**, and **conflict handling**
  - **25%:** ease of use and product experience
- **Finals:** 3 finalists get 10 minutes on stage at Cloudflare Connect, Moscone West, San Francisco, on **October 21**. Travel is covered for up to 2 people. **You must be there in person to win.**
- **Prize:** $25K in Cloudflare credits (valid 12 months) and a VIP dinner invite.

## What Cloudflare Artifacts is

Git repos hosted by Cloudflare. They're made for creating lots of them automatically, e.g. one per agent or per task.
- Normal `git clone` / `git push` over HTTPS with a token. Push works (protocol v1 only).
- From a Worker you can **read** repos (log, commits, trees, files), **create**, **fork** and **delete** them, and issue access tokens. You **can't write** commits from a Worker; writes go through `git push`.
- Every push can fire a `pushed` event (ref, before/after, commit list) into a Cloudflare Queue, and a Worker can react to it.
- **Cost:** it requires the **Workers Paid plan ($5/month)**. That includes 10,000 operations and 1 GB of storage per month, which is plenty for this. Billing starts October 14.

## How promptlog fits

| Judged on | promptlog today | Gap |
|---|---|---|
| Originality, agent collaboration (50%) | Reviewing the conversation behind code is unusual. Asking questions at any turn is unique. | Built around one human and one agent. Needs a multi-agent story. |
| Context preservation | Strong: every turn's chat and files are stored in git. | None. |
| Review | Strong: glance page, summaries, quick asks. | Runs only on your laptop. |
| Concurrency and coordination | Nothing. | Must build. |
| Conflict handling | Nothing. | Must build. |
| Ease of use | Local web page. | Needs to be a hosted page you just open. |
| Runs on Workers + Artifacts | No: it's a local CLI using local git. | Must build. |

## The pitch

**"Every agent's change carries its reasons."**

Many agents work on one repo at the same time. Each agent's code arrives with its conversation: what it was asked, what it decided, and why each file changed. That lets promptlog do two things plain git can't:

1. **Coordinate before conflicts happen.** A live board shows each agent's goal and the files it's touching. When two agents head for the same code, both are warned and each can read the other's intent.
2. **Resolve conflicts with intent, not just text.** When two agents' changes collide, the page shows both changes side by side, each with *why* its agent made it, and proposes a merge that keeps both goals. A human, or a resolver agent, can ask either agent "did you account for X?" at the exact turn it made the change.

The review page you've been building is the third part: the human's view of what all the agents did.

## The demo (what the video shows)

1. Start 3 Claude Code agents on the demo app in parallel: add `/rates` with caching, add rate limiting, write tests. Each works in its own Artifacts fork.
2. The board updates live as they work: goals, files touched, and a warning that two agents are both editing `server.js`.
3. Merge time. One conflict. The conflict view shows agent A's change ("cache rates per currency, because the user runs 20 instances") beside agent B's ("rate-limit by IP"), plus a suggested merge.
4. A reviewer asks agent A: "does your cache account for B's rate limit?" The answer is based on A's code and chat at that turn.
5. Merge. The PR page shows the whole story at a glance.

## Architecture (smallest version that meets the rules)

- **Agents:** local Claude Code sessions in git worktrees, as today. promptlog's hooks push code plus `refs/promptlog/*` to the agent's own Artifacts fork after every turn.
- **Ingest Worker:** receives `pushed` events from a Queue, reads the new turn through the Artifacts binding, writes per-turn notes (Gemini Flash / Jev, as in D8), and stores them in D1 or KV.
- **Web Worker:** serves the board, the conflict view and the review page. The viewer already renders HTML with pure functions so it can run on Workers. What's missing is a data source that reads from the Artifacts binding instead of local `git`.
- **Conflict detection:** inside the Worker, compare the changed line ranges of each agent's branch against main. The merge itself runs locally with git (Workers can't write to Artifacts), and the result is pushed back.
- **Asks:** quick asks (Gemini) run in the Worker. Full asks at a turn stay local (Claude Code); running them on Cloudflare's Sandbox SDK is a stretch goal.

## Clef (Cloudflare's Jev clone): the judgment layer

Clef is Cloudflare's open-source decision model, API-compatible with Jev: state + typed questions (noul / choice / score) in, probabilities out, no text. `@cf/cloudflare/clef` (27B, ~210 ms median) and `@cf/cloudflare/clef-flash` (9B, ~40 ms median), 64k context, on Workers AI. It reads images. Pricing: not found yet; check before relying on it heavily. Sources: https://blog.cloudflare.com/clef-decision-models/, https://developers.cloudflare.com/ai/models/.

Role in the pitch: **Clef makes the routine calls so humans only see what it flags.** That's what lets one person oversee many agents.
1. **Push triage.** On every push: beyond what was asked? removed a check or test? touched config/secrets? matches the agent's goal? Clean pushes auto-merge; flagged ones go to a human.
2. **Collision check.** When two agents touch the same file: do their goals conflict? can both changes coexist? which goes first? does a human need to decide?
3. **Routing.** A new task goes to the agent whose current goal is closest (a `choice` over agents), to reuse context.
4. **Quick asks.** Swap Jev for Clef in `src/quick` (should only need a new URL and key; the Workers AI path is `/accounts/<id>/ai/run/@cf/cloudflare/clef`, so a small adapter may be needed).
5. **Stretch, vision.** Screenshot changed pages before/after (Browser Rendering) and ask Clef "does the visible change match the ask?" and "anything broken?"

**Decision (2026-10-01, revised): Workers AI only, no credits.** Text: `@cf/deepseek-ai/deepseek-v4-flash-0731`; decisions: `@cf/cloudflare/clef-flash`; both bill to the Workers plan. Gemini via AI Gateway is the optional upgrade below. **Earlier version: all-Cloudflare billing, Gemini quality.** Text (goals, summaries, ask answers): Gemini 3.8 Flash through **AI Gateway** (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/google-ai-studio/v1/models/gemini-3.8-flash:generateContent`), paid via Unified Billing (`cf-aig-authorization: Bearer <token>`, no Google key). `src/quick/gemini.ts` already speaks this API; only the URL and auth header change. Decisions: `@cf/cloudflare/clef-flash` on Workers AI (Clef for harder calls). Cheaper fallback for text: `@cf/deepseek-ai/deepseek-v4-flash-0731`. Source: https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/

Prices per M tokens (2026-10-01): DeepSeek V4 Flash $0.44 in / $1.32 out; Llama 3.1 8B fast $0.045 / $0.38; Gemini 3.8 Flash $0.75 / $3.75 until 2026-12-31, then $1.50 / $7.50. Decisions (input only): Jev $0.042, Clef-flash $0.09, Clef $0.24. Workers AI includes 10,000 neurons/day free. A quick ask (~4.2k in, 0.7k out) is ~$0.003 on DeepSeek V4 Flash vs ~$0.006 on Gemini.

## Leases: explicit claims plus predicted collisions

Two signals, used together.

**Leases (explicit, the hard signal)**
- An agent claims a file, or a symbol inside it (function, class), with a one-line reason: `server.js getRates: adding per-currency cache`. Symbols over line ranges, since lines drift.
- Automatic: a Claude Code `PreToolUse` hook on Edit/Write claims the file on the agent's first edit. If another agent holds it, the hook denies the edit and returns who holds it and why. Agents can also claim up front (`promptlog lease claim <path>[#symbol] --why "…"`) and check (`promptlog lease check <path>`).
- A blocked agent can wait, ask the holder (quick ask against its conversation), work on another symbol, or request a handoff.

**Expiry**
- Hard TTL (start at 15 min), renewed by any push or turn touching the leased file; released on merge.
- Early release: while a lease is alive but quiet, Clef-flash reads the holder's last few turns and answers a `choice`: still working / stuck / done with it. "Done" or "stuck" releases it.

**Predicted collisions (implicit, the soft signal)**
- For unleased files, Clef scores the probability that two agents' goals and recent edits collide in a file or symbol. High scores warn both agents before they edit.

**Storage:** one Durable Object per repo holds leases, so claims are atomic (two agents can't both win) and it adds a third Cloudflare product.

**Demo moment:** agent B tries to edit `getRates`, is stopped with "agent A holds this: adding per-currency cache", and moves to another function.

## Timeline (13 days)

| Days | Work | Done when |
|---|---|---|
| Oct 1–2 | **Spikes.** Workers Paid account. Create an Artifacts repo, `git push` code **and** `refs/promptlog/*` (unknown whether custom refs survive; fallback is a normal branch). Read it from a Worker. Receive a `pushed` event in a Queue. | All four work, or a fallback is chosen. |
| Oct 3–5 | **Hosted review page.** A data layer that reads sessions from the Artifacts binding. Deploy the existing viewer to a Worker. Ingest Worker writes per-turn notes. | The demo PR's review page loads from a workers.dev URL. |
| Oct 6–8 | **Multi-agent.** A command that starts N agents, each in its own worktree and Artifacts fork. The live board page shows goals, files touched and overlap warnings. | 3 agents run at once and the board shows them live. |
| Oct 9–10 | **Conflicts.** Conflict view with both agents' reasons and a suggested merge. Ask either agent from that view. | The demo conflict shows up and resolves cleanly. |
| Oct 11 | **Polish and open source.** README run instructions, `LICENSE` (MIT), redaction check on everything in the repo and fixtures. | A stranger can run it from the README. |
| Oct 12 | **Record the video** (5–10 min), following the demo script above. | Video uploaded. |
| Oct 13–14 | **Buffer and submit.** Submit by Oct 14, 11:59 PM PDT; don't leave it to the last hour. | Submitted. |

Cut first if time runs out: suggested merges (just show both reasons), Sandbox asks, live updates (refresh instead).

## Costs

- Workers Paid plan: **$5/month**. Required.
- Artifacts: within the included allowance.
- Gemini 3.8 Flash via AI Gateway (text, ~$0.006 per quick ask) and Clef-flash on Workers AI (decisions): under a cent per PR, billed by Cloudflare.
- The demo agents run on your Claude plan.

## Risks

- **Custom refs on Artifacts.** Unknown whether `refs/promptlog/*` can be pushed. Check on day 1.
- **The code assumes local git.** `src/core/git.ts` spawns the `git` CLI, which doesn't exist in Workers. Porting the read side to the Artifacts binding is the biggest single job.
- **Uncommitted work.** The repo has a lot of uncommitted changes from the 2026-09-26/27 sessions (rename to `promptlog`, quick asks, glance page). Commit them before starting.
- **Scope.** 13 days, solo. The timeline has one buffer day plus a cut list.

## Answers (2026-10-01)

1. Lives near SF and can attend October 21.
2. Open-source under MIT: yes.
3. Already has Workers Paid.
4. Solo.

## Spike log

- **2026-10-01: custom refs work.** Created Artifacts repo `promptlog/demo-spike` and pushed the demo's branches plus `refs/promptlog/sessions/*` with plain `git push`. `git ls-remote` shows all of them. No fallback needed.
- **2026-10-01: a Worker can read everything, but not custom refs by name.** Spike Worker `promptlog-spike` (binding `ARTIFACTS`, namespace `promptlog`) results:
  - Works: `log({ref})` with a branch short name (`feature/rates`) or a commit SHA; `readCommit(sha)`; `readTree(treeHash)`. So the whole session tree (session.json, turns/…) is readable once we know the session's head SHA.
  - Doesn't work: `log({ref})` with `refs/promptlog/sessions/<id>`, `promptlog/sessions/<id>`, or even `refs/heads/main`. All return `[]`. Custom refs aren't resolvable by name through the binding.
  - Ways to get a session's head SHA: (a) the `pushed` event carries `ref` + `after`, so the ingest Worker stores ref → SHA in KV/D1; (b) the Worker calls git smart HTTP `GET …/info/refs?service=git-upload-pack` with a read token, which lists every ref (`git ls-remote` already showed the custom refs). Plan: (a) for live updates, (b) as backfill.
- **2026-10-01: push events work, including for promptlog refs.** Queue `promptlog-spike-events`, subscription on repo `promptlog/demo-spike`, consumer = the spike Worker. One push of a branch plus a `refs/promptlog/sessions/*` ref produced **one event per ref**, each with `ref`, `before`, `after` (new commit SHA); the custom ref's event has an empty `commits` list. Delivered about 1.5 s after the push. This solves the custom-ref lookup: the ingest Worker records ref → `after` SHA.
  - Setup gotchas: `wrangler queues subscription create` can't name a repo (the API requires `source.namespace` and `source.repo_name`), so create it with `POST /accounts/<id>/event_subscriptions/subscriptions`. The event name in that call is `pushed`, not `cf.artifacts.repo.pushed` (that's the `type` inside the delivered message). One subscription per repo, so creating a repo per agent must also create its subscription; an account-level `artifacts` source may cover all repos (untested).
- **2026-10-01: review page on Cloudflare, phone-ready.** `cloud/viewer/`: a Worker in front of a Cloudflare Container that runs the stock `promptlog view` against a clone fetched from the Artifacts repo. No promptlog code changed. The Worker checks a secret link key (cookie after first visit), mints a 1-hour read token through the Artifacts binding, and passes it to the container per request; the container re-fetches at most every 10 s. URL: https://promptlog-viewer.mazlix-f8e.workers.dev (key in `wrangler secret`, VIEW_KEY). Cold start ~5 s, warm ~1 s. Missing: the Gemini summary (no key in the container yet; next: route through AI Gateway).
  - Gotchas: a running container keeps its old image after `wrangler deploy`; open `/__restart` (with the key) to swap it. git refuses to fetch into the branch HEAD points at, so fetch with `--update-head-ok`. execFileSync errors include the command line, i.e. the token: report git's stderr only.
- **2026-10-01: AI without keys in the container.** The Worker serves `/__ai/systemone` (Jev-shaped, runs `@cf/cloudflare/clef-flash` via the `AI` binding) and `/__ai/gemini/<model>:generateContent` (Gemini-shaped, runs `google/<model>` via `env.AI.run(…, { gateway: { id: "default" } })`, Unified Billing). The container writes `~/.config/promptlog/config.json` pointing promptlog's existing quick-ask clients there (new optional `gemini.url` in `src/quick/config.ts` + `gemini.ts`). The key is HMAC(VIEW_KEY, "ai-proxy"). Clef-flash verified (265 tokens). Gemini verified up to "2021: Insufficient AI Gateway credits": needs Unified Billing credits bought in the dashboard. Model id is `google/gemini-3.8-flash` (`google-ai-studio/…` gives 7003). The "default" gateway is created automatically.
- **2026-10-01: text on Workers AI, no credits.** The hosted page's "at a glance" summary now works end to end (about 14 s the first time, cached after). Text model: `@cf/deepseek-ai/deepseek-v4-flash-0731` (about 2.6 s for a turn note). Tried `@cf/qwen/qwen3.8-27b`: 25–50 s per call even with thinking off (`chat_template_kwargs.enable_thinking=false`), which hits promptlog's 90 s HTTP limit across several calls. `qwen3-30b-a3b-fp8` returned an empty message; Llama 3.3 70B fast was about 2.1 s. Workers AI takes a single system message only, and JSON mode isn't universal, so the Worker states the schema in the system prompt and cuts the outermost `{…}` from the reply. Gemini through AI Gateway stays available by setting `TEXT_MODEL` in the container (needs Unified Billing credits).
- Note: remote `HEAD` pointed at `feature/health`, not `main`, despite `--default-branch main`. Minor; watch for it.

## Inspiration: Blume (2026-10-02)

https://x.com/BlumeDotCodes/status/2105962386566107281: "Let your agents work in parallel and force them to provide visual evidence that they completed the task and did not regress unrelated functionality." An established product, not a contest entrant; used here as inspiration only.

What to borrow:
- **The unit is a goal ("delivery"), not a PR,** split into build / test / review tasks with agents assigned.
- **Agents bring evidence:** acceptance scenarios with screenshots, pass/fail, pinned to a commit.
- **The human appears only at the end:** a "Needs you" state with one "review and approve this revision" action, plus a timeline of revisions.

How it maps onto promptlog: Blume's evidence is proof it works; ours is why and how (the conversation). Pitch both: **every agent change carries its reasons and its proof.** That means the Clef vision check (screenshot before/after: "matches the ask?", "anything unrelated broken?") and a "Needs you" state on the board for whatever Clef triage flags. Keep the demo led by what's unique to us: asking an agent at any past turn, leases, and conflicts shown with both sides' reasons.

## Optional idea

Export a PR's review as a CodeTour file (the format Tourminal and VS Code's CodeTour use): one stop per key change, with the agent's reason as the text. Cheap, and it speaks to people who think in "agents explain code to humans, attached to exact lines".
