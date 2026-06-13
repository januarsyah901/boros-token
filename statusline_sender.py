#!/opt/homebrew/bin/python3
import sys
import os
import json
import urllib.request
import threading

def send_data(payload_str):
    try:
        url = 'http://localhost:4000/api/metadata'
        req = urllib.request.Request(
            url, 
            data=payload_str.encode('utf-8'), 
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        # 0.5 seconds timeout to avoid hanging the CLI if the server is offline
        with urllib.request.urlopen(req, timeout=0.5) as response:
            response.read()
    except Exception:
        # Silently fail if server is offline
        pass

def main():
    try:
        # Read payload from stdin
        data = sys.stdin.read()
        if data.strip():
            # Parse and validate JSON
            payload = json.loads(data)
            
            # Force all events to be tagged as Antigravity CLI.
            payload['product'] = 'terminal'
            
            # Serialize back to string
            updated_data = json.dumps(payload)
            
            # Send the request in a separate thread so it returns immediately
            # and doesn't introduce latency to the CLI status bar
            t = threading.Thread(target=send_data, args=(updated_data,))
            t.daemon = True
            t.start()
            # Wait a tiny fraction of a second to allow thread to start
            t.join(timeout=0.05)
    except Exception:
        pass

if __name__ == "__main__":
    main()
