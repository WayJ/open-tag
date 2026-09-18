#!/usr/bin/env bash
# Stop this worktree's dev E2E stack (server + daemon started by dev:e2e:up).
# Usage: npm run dev:e2e:down
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd)"; exit 1; }
HOME_DIR=$(grep -E "^OPEN_TAG_HOME=" .env | head -1 | cut -d= -f2- | sed "s|^\$HOME|$HOME|; s|^~|$HOME|")
RUN="${HOME_DIR:-$HOME/.open-tag}"
PORT=$(grep -E "^PORT=" .env | head -1 | cut -d= -f2-)
kill_tree() { # winpid → taskkill tree, true if killed
  taskkill //F //T //PID "$1" >/dev/null 2>&1
}
for svc in server daemon; do
  f="$RUN/dev-e2e-$svc.pid"
  # Kill the whole process tree, not just the recorded npm-exec parent: `kill $pid` alone orphans the
  # npx → tsx → node children (they keep running, holding the WS open → ghost daemons that cause
  # double-delivery — exactly the ping-pong flaps seen when several zombie daemons share a machine-id).
  # NOTE: the old `pkill -f "$PWD/src/$svc/index.ts"` never matched on Windows — MSYS pkill cannot
  # see native node.exe processes at all. taskkill //T tree-kills; $! in MSYS bash is an msys pid,
  # translated via /proc/<pid>/winpid.
  stopped=0
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    if command -v taskkill >/dev/null 2>&1; then
      wpid=$(cat "/proc/$pid/winpid" 2>/dev/null || echo "$pid")
      kill_tree "$wpid" && stopped=1
    else
      pkill -f "$PWD/src/$svc/index.ts" 2>/dev/null || true
      kill "$pid" 2>/dev/null && stopped=1
    fi
    rm -f "$f"
  fi
  # Belt-and-braces (Windows): the pidfile's wrapper can exit before its node child is recorded
  # under it — kill whoever actually LISTENS on the port (server: $PORT; daemon has none, skip).
  if [ "$stopped" != 1 ] && command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
    case "$svc" in
      server)
        lpid=$(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $NF}' | sort -u | head -1)
        [ -n "$lpid" ] && kill_tree "$lpid" && stopped=1
        ;;
    esac
  fi
  [ "$stopped" = 1 ] && echo "  stopped $svc" || echo "  $svc not running"
done
echo "✅ dev E2E down"
