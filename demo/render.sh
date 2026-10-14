#!/bin/sh
# Re-renders the demo video: demo/out/promptlog-demo.mp4 (+ .srt).
#   demo/render.sh                 everything
#   demo/render.sh review-t13      only these scenes, then re-assemble
#   demo/render.sh --assemble      only re-assemble
# The live scenes need a copy of ~/Projects/browser-use where `main` is the PR's base (main has since
# been fast-forwarded past it), served by the promptlog viewer on [::1]:4812.
set -e
DEMO="$(cd "$(dirname "$0")" && pwd)"
CLONE="$DEMO/build/browser-use"
BASE=43c719ae09f9e5daf6e08d10bb73c4be357b9b11   # main before the PR was merged
HEAD=2982263                                     # clef-visibility-and-safety
if [ ! -d "$CLONE/.git" ]; then
  mkdir -p "$DEMO/build"
  git clone -q --no-checkout "$HOME/Projects/browser-use" "$CLONE"
  git -C "$CLONE" fetch -q origin '+refs/promptlog/*:refs/promptlog/*'
  git -C "$CLONE" branch -f main "$BASE"
  git -C "$CLONE" branch -f clef-visibility-and-safety "$HEAD"
  git -C "$CLONE" checkout -q clef-visibility-and-safety
fi
[ -f "$DEMO/build/lease/deny.json" ] || "$DEMO/lease-capture.sh" > /dev/null
[ -d "$DEMO/node_modules/playwright" ] || (cd "$DEMO" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --silent)
if ! curl -s -g -o /dev/null "http://[::1]:4812/"; then
  node "$DEMO/serve.ts" "$CLONE" 4812 > "$DEMO/build/viewer.log" 2>&1 &
  VIEWER=$!
  trap 'kill $VIEWER 2>/dev/null' EXIT
  i=0; until curl -s -g -o /dev/null "http://[::1]:4812/"; do i=$((i+1)); [ $i -gt 60 ] && { echo "viewer did not start; see demo/build/viewer.log"; exit 1; }; sleep 0.5; done
fi
node "$DEMO/build.mjs" "$@"
