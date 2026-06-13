#!/usr/bin/env python3
import json
import os
import re
import sqlite3
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, ".boros_poller_state.json")
SERVER_URL = "http://localhost:4000/api/metadata"
CODEX_DB = os.path.expanduser("~/.codex/logs_2.sqlite")
OPENCODE_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def save_state(state):
    tmp_path = STATE_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
    os.replace(tmp_path, STATE_FILE)


def post(payload):
    try:
        req = urllib.request.Request(
            SERVER_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=0.5) as response:
            response.read()
        return True
    except Exception:
        return False


def parse_kv(body, key):
    match = re.search(rf'{re.escape(key)}=("[^"]*"|[^ ]+)', body or "")
    if not match:
        return None
    value = match.group(1)
    return value[1:-1] if value.startswith('"') and value.endswith('"') else value


def parse_int(body, key):
    value = parse_kv(body, key)
    try:
        return int(value) if value is not None else 0
    except ValueError:
        return 0


def poll_codex(state):
    if not os.path.exists(CODEX_DB):
        return

    last_id = int(state.get("codex_last_log_id") or 0)
    query = """
        select id, ts, feedback_log_body
        from logs
        where id > ?
          and target = 'codex_otel.trace_safe'
          and feedback_log_body like '%event.name="codex.sse_event"%'
          and feedback_log_body like '%event.kind=response.completed%'
          and feedback_log_body like '%input_token_count=%'
        order by id asc
        limit 20
    """
    first_run_query = """
        select id, ts, feedback_log_body
        from logs
        where target = 'codex_otel.trace_safe'
          and feedback_log_body like '%event.name="codex.sse_event"%'
          and feedback_log_body like '%event.kind=response.completed%'
          and feedback_log_body like '%input_token_count=%'
        order by id desc
        limit 1
    """

    try:
        conn = sqlite3.connect(f"file:{CODEX_DB}?mode=ro", uri=True)
        rows = conn.execute(first_run_query if last_id == 0 else query, () if last_id == 0 else (last_id,)).fetchall()
        conn.close()
    except Exception:
        return

    rows = list(reversed(rows)) if last_id == 0 else rows

    for row_id, ts, body in rows:
        conversation_id = parse_kv(body, "conversation.id") or f"codex-{row_id}"
        model = parse_kv(body, "model") or parse_kv(body, "slug") or "codex"
        input_tokens = parse_int(body, "input_token_count")
        output_tokens = parse_int(body, "output_token_count")
        cache_read = parse_int(body, "cached_token_count")
        context_size = max(input_tokens + output_tokens + cache_read, 1)

        sent = post({
            "agent": "codex",
            "source": "codex",
            "product": "codex",
            "session_id": conversation_id,
            "conversation_id": conversation_id,
            "cwd": parse_kv(body, "cwd") or os.getcwd(),
            "model": {"id": model, "display_name": model},
            "agent_state": "idle",
            "context_window": {
                "total_input_tokens": input_tokens + cache_read,
                "total_output_tokens": output_tokens,
                "context_window_size": context_size,
                "used_percentage": min(100, ((input_tokens + output_tokens) / context_size) * 100),
                "current_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_input_tokens": cache_read,
                },
            },
        })
        if sent:
            state["codex_last_log_id"] = row_id


def poll_opencode(state):
    if not os.path.exists(OPENCODE_DB):
        return

    last_time = int(state.get("opencode_last_time") or 0)
    query = """
        select m.id, m.session_id, m.time_created, m.data, s.directory
        from message m
        left join session s on s.id = m.session_id
        where m.time_created > ?
          and json_extract(m.data, '$.role') = 'assistant'
          and json_extract(m.data, '$.tokens.input') is not null
          and (json_extract(m.data, '$.tokens.input') > 0 or json_extract(m.data, '$.tokens.output') > 0)
        order by m.time_created asc
        limit 20
    """
    first_run_query = """
        select m.id, m.session_id, m.time_created, m.data, s.directory
        from message m
        left join session s on s.id = m.session_id
        where json_extract(m.data, '$.role') = 'assistant'
          and json_extract(m.data, '$.tokens.input') is not null
          and (json_extract(m.data, '$.tokens.input') > 0 or json_extract(m.data, '$.tokens.output') > 0)
        order by m.time_created desc
        limit 1
    """

    try:
        conn = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True)
        rows = conn.execute(first_run_query if last_time == 0 else query, () if last_time == 0 else (last_time,)).fetchall()
        conn.close()
    except Exception:
        return

    rows = list(reversed(rows)) if last_time == 0 else rows

    for message_id, session_id, created, raw_data, directory in rows:
        try:
            data = json.loads(raw_data)
        except Exception:
            continue

        tokens = data.get("tokens") or {}
        cache = tokens.get("cache") or {}
        input_tokens = int(tokens.get("input") or 0)
        output_tokens = int(tokens.get("output") or 0)
        cache_read = int(cache.get("read") or 0)
        total_tokens = int(tokens.get("total") or (input_tokens + output_tokens + cache_read) or 1)
        model = data.get("modelID") or (data.get("model") or {}).get("modelID") or "opencode"

        sent = post({
            "agent": "opencode",
            "source": "opencode",
            "product": "opencode",
            "session_id": session_id,
            "conversation_id": session_id,
            "cwd": directory or (data.get("path") or {}).get("cwd") or os.getcwd(),
            "model": {"id": model, "display_name": model},
            "agent_state": "idle",
            "context_window": {
                "total_input_tokens": input_tokens + cache_read,
                "total_output_tokens": output_tokens,
                "context_window_size": max(total_tokens, 1),
                "used_percentage": min(100, ((input_tokens + output_tokens) / max(total_tokens, 1)) * 100),
                "current_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_input_tokens": cache_read,
                },
            },
        })
        if sent:
            state["opencode_last_time"] = max(int(created), int(state.get("opencode_last_time") or 0))


def main():
    while True:
        state = load_state()
        poll_codex(state)
        poll_opencode(state)
        save_state(state)
        time.sleep(5)


if __name__ == "__main__":
    main()
