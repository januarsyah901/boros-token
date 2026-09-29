#!/bin/sh
# Boros Token Antigravity Statusline Hook
# Fast, non-blocking telemetry sender

CACHE_FILE="$HOME/.gemini/antigravity-cli/agy_status.json"

# Write stdin immediately to cache file
cat > "$CACHE_FILE" 2>/dev/null

# Send async POST to Boros Token server with nohup so it survives script exit
nohup curl -s -X POST http://localhost:4000/api/metadata \
  -H "Content-Type: application/json" \
  -d @"$CACHE_FILE" \
  --connect-timeout 0.5 \
  --max-time 1.0 >/dev/null 2>&1 &

exit 0
