#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/server_stop.sh"
sleep 0.5
"$SCRIPT_DIR/server_start.sh"
