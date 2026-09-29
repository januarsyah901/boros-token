#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STYLE_FILE="$SCRIPT_DIR/../.menu_style"
CURR=$(cat "$STYLE_FILE" 2>/dev/null || echo "1")

case "$CURR" in
    1) NEXT=2 ;;
    2) NEXT=3 ;;
    3) NEXT=4 ;;
    *) NEXT=1 ;;
esac

echo "$NEXT" > "$STYLE_FILE"
open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true
