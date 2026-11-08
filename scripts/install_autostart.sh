#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.boros-token"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
PLUGIN_SRC="$BASE_DIR/agy_swiftbar.5s.py"
PLUGIN_DST="$PLUGIN_DIR/agy_swiftbar.5s.py"

echo "[boros] Base: $BASE_DIR"

# 1. Ensure helper scripts executable
chmod +x "$BASE_DIR"/boros-start.sh "$BASE_DIR"/boros-stop.sh "$BASE_DIR"/boros-restart.sh 2>/dev/null || true
chmod +x "$SCRIPT_DIR"/server_start.sh "$SCRIPT_DIR"/server_stop.sh "$SCRIPT_DIR"/server_restart.sh 2>/dev/null || true
chmod +x "$PLUGIN_SRC" 2>/dev/null || true

# 2. SwiftBar plugin symlink (menu bar)
mkdir -p "$PLUGIN_DIR"
if [ -e "$PLUGIN_DST" ] && [ ! -L "$PLUGIN_DST" ]; then
    echo "[boros] Backing up existing plugin file..."
    mv "$PLUGIN_DST" "$PLUGIN_DST.bak.$(date +%s)"
fi
ln -sf "$PLUGIN_SRC" "$PLUGIN_DST"
echo "[boros] SwiftBar plugin linked: $PLUGIN_DST -> $PLUGIN_SRC"

# 3. Resolve node binary (launchd-native, no detach)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
else
    echo "[boros] ERROR: node not found" >&2
    exit 1
fi
echo "[boros] node: $NODE_BIN"

# 4. Write LaunchAgent plist (launchd manages node directly + KeepAlive)
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$BASE_DIR/dashboard_server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BASE_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BASE_DIR/launchd_stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$BASE_DIR/launchd_stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
echo "[boros] LaunchAgent written: $PLIST"

# 5. Stop detached server (avoid port 4000 conflict), then (re)load LaunchAgent
"$BASE_DIR/boros-stop.sh" 2>/dev/null || true
sleep 0.5
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "[boros] LaunchAgent loaded."

# 6. SwiftBar: open now + add to Login Items
if [ -d "/Applications/SwiftBar.app" ]; then
    open -g -a SwiftBar 2>/dev/null || open -g "/Applications/SwiftBar.app" 2>/dev/null || true
    echo "[boros] SwiftBar launched."
    # Add to login items (idempotent via AppleScript)
    osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/SwiftBar.app", hidden:false}' 2>/dev/null || true
    echo "[boros] SwiftBar added to Login Items (check System Settings > General > Login Items)."
else
    echo "[boros] WARNING: SwiftBar.app not found in /Applications. Install: brew install --cask swiftbar" >&2
fi

# 7. Trigger SwiftBar refresh
sleep 1
open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true

echo ""
echo "[boros] Done. Verifikasi:"
echo "  launchctl list | grep boros"
echo "  curl -s http://localhost:4000/api/health"
echo "  ls -l \"$PLUGIN_DST\""
launchctl list 2>/dev/null | grep -i boros || true
curl -s --max-time 2 http://localhost:4000/api/health || echo "(server belum ready, tunggu 2 detik lalu refresh)"
