#!/usr/bin/env python3
import json
import sys
import threading
import urllib.request

SERVER_URL = "http://localhost:4000/api/metadata"
SOURCE_NAME = "opencode"


def send_data(payload_str):
    try:
        req = urllib.request.Request(
            SERVER_URL,
            data=payload_str.encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=0.5) as response:
            response.read()
    except Exception:
        pass


def main():
    try:
        data = sys.stdin.read()
        if not data.strip():
            return

        payload = json.loads(data)
        payload["agent"] = SOURCE_NAME
        payload["source"] = SOURCE_NAME
        payload.setdefault("product", SOURCE_NAME)

        updated_data = json.dumps(payload)
        t = threading.Thread(target=send_data, args=(updated_data,))
        t.daemon = True
        t.start()
        t.join(timeout=0.05)
    except Exception:
        pass


if __name__ == "__main__":
    main()
