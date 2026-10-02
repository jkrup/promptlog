#!/usr/bin/env bash
# Generates fixtures/demo.bundle: a small git repo whose Claude Code sessions were captured by promptlog hooks.
# Scenario: feature branch built over two sessions (one with a pushback), plus a later session on another branch.
# Usage: fixtures/make-demo.sh [workdir]   (costs a few Claude turns)
set -euo pipefail
PL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
REPO="$WORK/demo-rates"
MODEL="${DEMO_MODEL:-sonnet}"
rm -rf "$REPO" && mkdir -p "$REPO" && cd "$REPO"
git init -q -b main
git config user.name "Dana Dev" && git config user.email "dana@example.com"
mkdir -p src
cat > package.json <<'J'
{ "name": "demo-rates", "type": "module", "scripts": { "test": "node --test" } }
J
cat > src/server.js <<'J'
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.statusCode = 404; res.end();
});
server.listen(process.env.PORT ?? 3000);
J
echo "node_modules/" > .gitignore
echo "EXCHANGE_API_KEY=sk_test_fixture_not_real" > .env && echo ".env" >> .gitignore
git add -A && git commit -qm "initial server"
git checkout -qb feature/rates

cat > "$WORK/settings.json" <<J
{ "hooks": {
  "SessionStart": [{"hooks": [{"type": "command", "command": "$PL_ROOT/bin/promptlog hook SessionStart"}]}],
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "$PL_ROOT/bin/promptlog hook UserPromptSubmit"}]}],
  "Stop": [{"hooks": [{"type": "command", "command": "$PL_ROOT/bin/promptlog hook Stop"}]}],
  "SessionEnd": [{"hooks": [{"type": "command", "command": "$PL_ROOT/bin/promptlog hook SessionEnd"}]}]
} }
J
# When generated from inside another Claude Code session, drop the parent's session identity so nested runs
# get their own session ids and don't stream into the parent session.
ISOLATE=(env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_REMOTE_SESSION_ID -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_CHILD_SESSION
  -u CLAUDE_CODE_SYNC_SESSION_REFS -u CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 -u CLAUDE_CODE_TEE_SDK_STDOUT
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDECODE -u CLAUDE_CODE_USE_CCR_V2
  -u CLAUDE_CODE_REMOTE_SEND_KEEPALIVES -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_WORKER_EPOCH -u CLAUDE_PID -u CLAUDE_CODE_SYNC_SKILLS)
CL=("${ISOLATE[@]}" claude -p --model "$MODEL" --settings "$WORK/settings.json" --output-format json
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(node:*),Bash(npm test:*),Bash(ls:*),Bash(mkdir:*)")
# Prompts go through stdin because --allowedTools is variadic and would swallow a positional prompt.
run() { local prompt="$1"; shift; printf '%s' "$prompt" | "${CL[@]}" "$@"; }
sid() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).session_id))'; }

say() { echo "--- $*" >&2; }
say "session A turn 1"
SID=$(run "Add a /rates endpoint to src/server.js that returns currency exchange rates from https://api.exchangerate.host/latest. Cache the upstream response so we don't hit the API on every request. Briefly state your approach before implementing. Keep it dependency-free." | sid)
echo "session A: $SID" >&2
say "session A turn 2 (pushback)"
run "Hmm, we run ~20 instances behind a load balancer so a per-process in-memory cache means 20x upstream calls and inconsistent rates between instances. Don't build Redis now, but: make the TTL configurable via env, don't hardcode USD as the base currency (accept ?base=), and leave a clear TODO about the shared cache. Also what happens if the upstream is down?" --resume "$SID" > /dev/null
say "session A turn 3 (commit)"
run "Looks good. Commit this with a descriptive message." --resume "$SID" > /dev/null
say "session A turn 4 (trailing discussion)"
run "Quick question, no code changes: does the cache key include the base currency?" --resume "$SID" > /dev/null

say "session B (same PR, second session)"
SID_B=$(run "Add a node:test test file for the /rates handler logic in test/rates.test.js. Stub fetch so no network is used. Run the tests, then commit." | sid)
echo "session B: $SID_B" >&2

say "session C (different branch = different PR)"
git checkout -q main && git checkout -qb feature/health
SID_C=$(run "Make /health return JSON {status:'ok', uptime:<seconds>} instead of plain text, then commit." | sid)
echo "session C: $SID_C" >&2
git checkout -q feature/rates

git bundle create "$PL_ROOT/fixtures/demo.bundle" --all 2>/dev/null
mkdir -p "$PL_ROOT/fixtures/transcripts"
for id in $SID $SID_B $SID_C; do
  f=$(ls ~/.claude/projects/*demo-rates/"$id".jsonl | head -1); cp "$f" "$PL_ROOT/fixtures/transcripts/$id.jsonl"
done
printf '{ "sessionA": "%s", "sessionB": "%s", "sessionC": "%s" }\n' "$SID" "$SID_B" "$SID_C" > "$PL_ROOT/fixtures/demo.json"
echo "done: $REPO" >&2
