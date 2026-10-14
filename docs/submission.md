# Submission sheet (Cloudflare "Build the next GitHub", due Wed Oct 14, 11:59 PM PDT)

## Before you submit
1. Make the GitHub repo public: https://github.com/jkrup/promptlog → Settings → General → Danger zone → Change visibility → Public. (Only `main` is on GitHub. Your recorded Claude conversations were never pushed there.)
2. Watch the final video once: `demo/out/promptlog-demo.mp4` (phone copy: `demo/out/promptlog-demo-720p.mp4`).
3. Fill the form with the texts below.

## Links
- Live demo (no key needed): https://promptlog-viewer.mazlix-f8e.workers.dev/review?base=main&head=feature%2Frates&repo=promptlog-demo
- Who's working on what (public demo): https://promptlog-viewer.mazlix-f8e.workers.dev/leases?repo=promptlog-demo
- Homepage: https://promptlog-home.mazlix-f8e.workers.dev
- Repo: https://github.com/jkrup/promptlog

## Project name
PromptLog

## Project vision
(yours, already written)

## How you used Cloudflare
Artifacts is the backbone. Running `promptlog connect` in a project creates a private Artifacts repo for it, and from then on every commit (whether you or an agent made it) pushes itself there in the background, along with the agent conversation that produced it, stored as git refs right next to the code. So the repo holds both the "compiled" code and its "source", the prompts and replies, and any branch can be reviewed as a PR. Each project gets its own repo and its own scoped token, which fits the many-agents-many-repos idea really naturally.

The review site is a Cloudflare Worker. It reads the Artifacts repo through the Artifacts binding, mints short-lived read tokens, and runs the viewer in a Container (backed by a Durable Object), one per repo. There's also a public read-only demo repo anyone can open without a key.

For many agents at once there's a lease system on a Durable Object, one per repo: before an agent edits a function, it claims it. Another agent editing a different function in the same file just keeps going, the same function waits (and is told who has it and what they're working on), and for neighbouring code Clef decides whether the two changes are independent. Every decision shows on a /leases page.

Workers AI does the model work through the Worker's AI binding, so there are no API keys in the container: DeepSeek writes the "what changed and why" overview at the top of each PR (every quote in it is checked against the real conversation in code), and Clef-flash handles the small yes/no and choice calls. We found Clef is really good at narrow questions about small chunks ("are these two edits independent?", "which goes first?") but not at "is this whole PR safe?", so we feed it small pieces and let code make the final call.

## Demo video
Upload `demo/out/promptlog-demo.mp4`.

## Open source repository URL
https://github.com/jkrup/promptlog

## Instructions to run your project
Prerequisites: macOS or Linux, Node 22.18+, git, Claude Code. For the Cloudflare parts: a Cloudflare account on Workers Paid, wrangler logged in (`npx wrangler login`), and Docker running (only to deploy the review page).

Quickest look, nothing to install: open the live demo, https://promptlog-viewer.mazlix-f8e.workers.dev/review?base=main&head=feature%2Frates&repo=promptlog-demo

1. Install: `git clone https://github.com/jkrup/promptlog && cd promptlog && npm install`, then put `bin/promptlog` on your PATH: `ln -s "$PWD/bin/promptlog" ~/.local/bin/promptlog`
2. Try it locally on the bundled demo (3 recorded Claude Code sessions): `git clone -q fixtures/demo.bundle /tmp/demo && cd /tmp/demo && git fetch -q origin '+refs/promptlog/*:refs/promptlog/*' && git checkout -q feature/rates && git branch -f main origin/main && promptlog view main..feature/rates` (opens http://127.0.0.1:4777)
3. Use it on your own project: `cd your-project && promptlog connect` creates a private Cloudflare Artifacts repo, imports your past Claude Code sessions and pushes. Then work with Claude Code (one or many agents) and commit as usual; every commit and its conversation push themselves. `promptlog view main..<branch>` reviews a branch locally; `promptlog leases` shows which agent holds which code.
4. Hosted review page and shared leases on Cloudflare: `cd cloud/viewer && npm install && npx wrangler secret put VIEW_KEY && npx wrangler deploy`, then open `https://<your-worker>.workers.dev/?key=<VIEW_KEY>&repo=<repo-name>` and go to `/review?base=main&head=<branch>`. To share leases across machines, open `/leases?repo=<name>` on that page and run the `promptlog connect --leases … --leases-key …` command it shows in each clone (details in the README).
5. Tests: `npm test` (no network needed).
