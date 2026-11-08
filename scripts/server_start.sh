#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$BASE_DIR/.boros.pid"

# 1. Resolve node binary even in restricted GUI/SwiftBar PATH
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
else
    for candidate in \
        "/opt/homebrew/bin/node" \
        "/usr/local/bin/node" \
        "$HOME/.nvm/versions/node"/*/bin/node \
        "$HOME/.asdf/shims/node" \
        "$HOME/.local/bin/node"; do
        if [ -x "$candidate" ]; then
            NODE_BIN="$candidate"
            export PATH="$(dirname "$candidate"):$PATH"
            break
        fi
    done
fi

if [ -z "$NODE_BIN" ]; then
    echo "Error: node not found in PATH or standard directories" >&2
    exit 1
fi

# 2. Check if already responding
if curl -s --max-time 1 http://localhost:4000/api/state >/dev/null 2>&1; then
    open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true
    exit 0
fi

# 3. Clean up any stale port 4000 process
if lsof -i :4000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PORT_PID=$(lsof -i :4000 -sTCP:LISTEN -t 2>/dev/null | head -n 1)
    if [ -n "$PORT_PID" ]; then
        kill -9 "$PORT_PID" 2>/dev/null || true
        sleep 0.3
    fi
fi

# 4. Start dashboard server detached in a new session
cd "$BASE_DIR"
python3 -c "import subprocess, sys; p = subprocess.Popen([sys.argv[1], 'dashboard_server.js'], cwd=sys.argv[2], start_new_session=True, stdin=subprocess.DEVNULL, stdout=open('server_stdout.log', 'a'), stderr=open('server_stderr.log', 'a')); open(sys.argv[3], 'w').write(str(p.pid))" "$NODE_BIN" "$BASE_DIR" "$PID_FILE"

# 5. Wait up to 3 seconds for server to come online
for _ in $(seq 1 15); do
    if curl -s --max-time 0.5 http://localhost:4000/api/state >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# 6. Trigger SwiftBar refresh
open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true
