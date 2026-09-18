#!/usr/bin/env bash
# Stop this worktree's dev E2E stack (server + daemon started by dev:e2e:up).
# Usage: npm run dev:e2e:down
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd)"; exit 1; }
HOME_DIR=$(grep -E "^OPEN_TAG_HOME=" .env | head -1 | cut -d= -f2- | sed "s|^\$HOME|$HOME|; s|^~|$HOME|")
RUN="${HOME_DIR:-$HOME/.open-tag}"
for svc in server daemon; do
  f="$RUN/dev-e2e-$svc.pid"
  # Kill the whole process tree, not just the recorded npm-exec parent: `kill $pid` alone orphans the
  # npx → tsx → node children (they keep running, holding the WS open → ghost daemons that cause
  # double-delivery — exactly the ping-pong flaps seen when several zombie daemons share a machine-id).
  # NOTE: the old `pkill -f "$PWD/src/$svc/index.ts"` never matched on Windows — $PWD is an MSYS
  # path (/d/...) while node cmdlines carry Windows paths (D:\...). Use taskkill /T (tree kill)
  # on Windows, fall back to kill + the pkill sweep elsewhere.
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    if command -v taskkill >/dev/null 2>&1; then
      taskkill //F //T //PID "$pid" >/dev/null 2>&1 && echo "  stopped $svc (tree $pid)" || echo "  $svc not running"
    else
      pkill -f "$PWD/src/$svc/index.ts" 2>/dev/null || true
      kill "$pid" 2>/dev/null && echo "  stopped $svc ($pid)" || echo "  $svc not running"
    fi
    rm -f "$f"
  else
    # No pidfile (crashed up): still sweep by command line on POSIX; on Windows there is no
    # cheap portable sweep — the tree-kill above is the contract, this is best-effort only.
    pkill -f "$PWD/src/$svc/index.ts" 2>/dev/null || true
  fi
done
echo "✅ dev E2E down"
