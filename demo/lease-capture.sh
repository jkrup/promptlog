#!/bin/sh
# Records real output for the "leases" scene: two simulated agent sessions in one file (two worktrees of one repo).
#   1. A edits getRates(), B edits health() in the same file: both go ahead.
#   2. B tries to edit getRates(): refused, told who holds it and what they're doing.
#   3. B edits formatRates(), right under getRates(): Clef decides (allowed with a heads-up, or refused).
# Leases go to a shared table on Cloudflare when LEASES_URL (the Worker's origin) and LEASES_KEY_FILE (a file holding
# that repo's lease key) are set; Clef runs there. Otherwise the machine's own table is used, and step 3 asks the
# decision model from ~/.config/promptlog/config.json (none: refused, to be safe).
# Writes demo/build/lease/{a-edit,b-health,deny,clef}.json and leases.txt.
set -e
D="$(cd "$(dirname "$0")" && pwd)/build/lease"
PL="$(cd "$(dirname "$0")/.." && pwd)/bin/promptlog"
rm -rf "$D" && mkdir -p "$D" && cd "$D"
git init -q -b main rates-api && cd rates-api
mkdir src
cat > src/server.js <<'EOF'
import express from 'express';

const RATES = { usd: 1, eur: 0.92, gbp: 0.79 };
const app = express();

export function getRates(currency) {
  return { base: 'usd', rate: RATES[currency] };
}
export function formatRates(rates) {
  return Object.entries(rates).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function health() {
  return { ok: true };
}

app.get('/rates/:cur', (req, res) => res.json(getRates(req.params.cur)));
app.get('/health', (req, res) => res.json(health()));
app.listen(3000);
EOF
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
git switch -q -c feature/rates
git worktree add -q -b feature/format ../rates-api-format
A="$D/rates-api"; B="$D/rates-api-format"
export PL_LEASES_KEYCHAIN=off
if [ -n "$LEASES_URL" ] && [ -n "$LEASES_KEY_FILE" ]; then
  git config promptlog.leases "$LEASES_URL/__leases/${LEASES_REPO:-promptlog-demo}"
  git config promptlog.leasesKey "$(cat "$LEASES_KEY_FILE")"
  "$PL" leases release --all > /dev/null
  echo "shared lease table: $LEASES_URL/leases?repo=${LEASES_REPO:-promptlog-demo}"
fi
hook() { # <cwd> <session> <event> <json-tail>
  (cd "$1" && printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s",%s}' "$2" "$1" "$3" "$4" | "$PL" hook "$3")
}
edit() { # <cwd> <session> <old_string> <new_string>
  node -e 'const [cwd, sid, o, n] = process.argv.slice(1); process.stdout.write(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: cwd + "/src/server.js", old_string: o, new_string: n } }).slice(1, -1))' "$@" > "$D/.tail"
  hook "$1" "$2" PreToolUse "$(cat "$D/.tail")"
}
SA=aaaaaaaa-0000-4000-8000-000000000001; SB=bbbbbbbb-0000-4000-8000-000000000002
hook "$A" $SA UserPromptSubmit '"prompt":"add a per-currency cache to getRates","transcript_path":"/dev/null"'
hook "$B" $SB UserPromptSubmit '"prompt":"show rates with two decimals, and make /health report uptime","transcript_path":"/dev/null"'

edit "$A" $SA "  return { base: 'usd', rate: RATES[currency] };" "  return cache.get(currency) ?? cache.set(currency, { base: 'usd', rate: RATES[currency] }).get(currency);" > "$D/a-edit.json"
edit "$B" $SB "  return { ok: true };" "  return { ok: true, uptime: process.uptime() };" > "$D/b-health.json"
edit "$B" $SB "  return { base: 'usd', rate: RATES[currency] };" "  return { base: 'usd', rate: Number(RATES[currency].toFixed(2)) };" > "$D/deny.json"
t0=$(node -e 'process.stdout.write(String(Date.now()))')
edit "$B" $SB '`${k}: ${v}`' '`${k}: ${v.toFixed(2)}`' > "$D/clef.json"
t1=$(node -e 'process.stdout.write(String(Date.now()))')
(cd "$B" && "$PL" leases) > "$D/leases.txt"

echo "1. A edits getRates(): $(wc -c < "$D/a-edit.json" | tr -d ' ') bytes of output (empty = allowed)"
echo "   B edits health() in the same file: $(wc -c < "$D/b-health.json" | tr -d ' ') bytes (empty = allowed)"
echo "2. B edits getRates():"; cat "$D/deny.json"; echo
echo "3. B edits formatRates(), next to getRates() ($((t1 - t0)) ms):"; cat "$D/clef.json"; echo
echo "4. promptlog leases:"; cat "$D/leases.txt"
