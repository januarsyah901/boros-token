#!/opt/homebrew/bin/python3
import sys
import os
import json
import urllib.request
import threading
import subprocess

def trigger_notification(title, message):
    try:
        # AppleScript to trigger macOS native notification
        apple_script = f'display notification "{message}" with title "{title}"'
        subprocess.run(["osascript", "-e", apple_script], capture_output=True)
    except Exception:
        pass

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
            
            # Check if agent is waiting for permission (state == 'reviewing')
            if payload.get('agent_state') == 'reviewing':
                # Run notification in background thread
                t_notif = threading.Thread(target=trigger_notification, args=("Antigravity CLI", "Agy is waiting for permission request."))
                t_notif.daemon = True
                t_notif.start()
            
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
