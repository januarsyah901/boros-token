#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$BASE_DIR/.boros.pid"

# Stop via PID file if present
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.3
        kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
fi

# Fallback cleanup for any orphaned instances
pkill -f "node dashboard_server.js" 2>/dev/null || true
pkill -f "boros-agent-poller.py" 2>/dev/null || true
sleep 0.3

# Free port 4000 if still held
if lsof -i :4000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PORT_PID=$(lsof -i :4000 -sTCP:LISTEN -t 2>/dev/null | head -n 1)
    if [ -n "$PORT_PID" ]; then
        kill -9 "$PORT_PID" 2>/dev/null || true
        sleep 0.3
    fi
fi

# Refresh SwiftBar
open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true
