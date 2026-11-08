#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if curl -s --max-time 1 http://localhost:4000/api/state >/dev/null 2>&1; then
    "$SCRIPT_DIR/server_stop.sh"
else
    "$SCRIPT_DIR/server_start.sh"
fi
