#!/bin/sh
# Records real output for the "leases" scene: two simulated agent sessions on one repo
# (two worktrees), the second one refused when it tries to edit the file the first holds.
# Writes demo/build/lease/{deny.json,leases.txt}.
set -e
D="$(cd "$(dirname "$0")" && pwd)/build/lease"
PL="$(cd "$(dirname "$0")/.." && pwd)/bin/promptlog"
rm -rf "$D" && mkdir -p "$D" && cd "$D"
git init -q -b main rates-api && cd rates-api
mkdir src && printf 'export function getRates() {}\n' > src/server.js && printf 'export {}\n' > src/health.js
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
git switch -q -c feature/rates
git worktree add -q -b feature/health ../rates-api-health
A="$D/rates-api"; B="$D/rates-api-health"
hook() { # <cwd> <session> <event> <json-tail>
  (cd "$1" && printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s",%s}' "$2" "$1" "$3" "$4" | "$PL" hook "$3")
}
SA=aaaaaaaa-0000-4000-8000-000000000001; SB=bbbbbbbb-0000-4000-8000-000000000002
hook "$A" $SA UserPromptSubmit '"prompt":"add a per-currency cache to getRates","transcript_path":"/dev/null"'
hook "$B" $SB UserPromptSubmit '"prompt":"add a /health endpoint that reports cache status","transcript_path":"/dev/null"'
hook "$A" $SA PreToolUse "\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$A/src/server.js\"}" > "$D/a-edit.json"
hook "$B" $SB PreToolUse "\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$B/src/server.js\"}" > "$D/deny.json"
hook "$B" $SB PreToolUse "\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$B/src/health.js\"}" > "$D/b-health.json"
(cd "$B" && "$PL" leases) > "$D/leases.txt"
echo "A edit output: $(wc -c < "$D/a-edit.json") bytes; B health output: $(wc -c < "$D/b-health.json") bytes"
cat "$D/deny.json"; echo; cat "$D/leases.txt"
