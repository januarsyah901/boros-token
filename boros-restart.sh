#!/usr/bin/env sh
set -eu

pkill -f "node dashboard_server.js" 2>/dev/null || true
pkill -f "boros-agent-poller.py" 2>/dev/null || true
nohup node dashboard_server.js > server_stdout.log 2> server_stderr.log &
echo "boros token server restarted on http://localhost:4000"
