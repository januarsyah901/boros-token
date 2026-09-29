#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.boros.pid"

# 1. Stop previous server and poller instances
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.5
        kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
fi

# Fallback cleanup for any orphaned instances
pkill -f "node dashboard_server.js" 2>/dev/null || true
pkill -f "boros-agent-poller.py" 2>/dev/null || true
sleep 0.5

# 2. Ensure port 4000 is free
if lsof -i :4000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PORT_PID=$(lsof -i :4000 -sTCP:LISTEN -t 2>/dev/null | head -n 1)
    if [ -n "$PORT_PID" ]; then
        kill -9 "$PORT_PID" 2>/dev/null || true
        sleep 0.5
    fi
fi

# 3. Start consolidated server
cd "$SCRIPT_DIR"
nohup node dashboard_server.js </dev/null > server_stdout.log 2> server_stderr.log &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

echo "boros token server restarted (PID: $NEW_PID) on http://localhost:4000"
