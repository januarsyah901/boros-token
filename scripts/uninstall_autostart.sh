#!/usr/bin/env sh
set -eu

LABEL="com.boros-token"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PLUGIN_DST="$HOME/Library/Application Support/SwiftBar/Plugins/agy_swiftbar.5s.py"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "[boros] LaunchAgent removed: $PLIST"

if [ -L "$PLUGIN_DST" ]; then
    rm -f "$PLUGIN_DST"
    echo "[boros] SwiftBar symlink removed: $PLUGIN_DST"
else
    echo "[boros] No SwiftBar symlink to remove."
fi

echo "[boros] Done. Server dibiarkan jalan; stop manual: ./boros-stop.sh"
echo "[boros] Untuk hapus SwiftBar dari Login Items: System Settings > General > Login Items > SwiftBar > (-)"
