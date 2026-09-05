#!/bin/sh
STYLE_FILE="/Users/mrfrog/Downloads/code/project/boros-token/.menu_style"
CURR=$(cat "$STYLE_FILE" 2>/dev/null || echo "2")
if [ "$CURR" = "1" ]; then
    echo 2 > "$STYLE_FILE"
else
    echo 1 > "$STYLE_FILE"
fi
open -g "swiftbar://refreshPlugin?name=agy_swiftbar.5s.py" 2>/dev/null || true
