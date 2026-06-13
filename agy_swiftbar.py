#!/usr/bin/env python3
import json
import urllib.request

# SwiftBar / xbar metadata
# <bitbar.title>Boros Token Multi-Agent Monitor</bitbar.title>
# <bitbar.version>v2.0</bitbar.version>
# <bitbar.author>Boros Token</bitbar.author>
# <bitbar.desc>Displays latest turn token usage for Codex, OpenCode, and Agy CLI</bitbar.desc>
# <bitbar.dependencies>python3</bitbar.dependencies>

AGENT_ORDER = ["codex", "opencode", "agy", "terminal"]
AGENT_ALLOWED = set(AGENT_ORDER)
AGENT_LABELS = {
    "codex": "Codex",
    "opencode": "OpenCode",
    "agy": "Agy CLI",
    "terminal": "Agy CLI",
}


def format_k(value):
    value = int(value or 0)
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def source_key(item):
    return str((item or {}).get("source") or (item or {}).get("agent") or (item or {}).get("product") or "unknown").lower()


def timestamp(item):
    return (item or {}).get("_receivedAt") or (item or {}).get("timestamp") or ""


def state_to_turn(state):
    context = (state or {}).get("context_window") or {}
    usage = context.get("current_usage") or {}
    model = (state or {}).get("model") or {}
    return {
        "source": source_key(state),
        "input": usage.get("input_tokens") or 0,
        "output": usage.get("output_tokens") or 0,
        "cache": usage.get("cache_read_input_tokens") or 0,
        "state": (state or {}).get("agent_state") or "idle",
        "model": model.get("display_name") or model.get("id") or "Unknown Model",
        "timestamp": timestamp(state),
    }


def event_to_turn(event):
    return {
        "source": source_key(event),
        "input": (event or {}).get("current_input") or 0,
        "output": (event or {}).get("current_output") or 0,
        "cache": (event or {}).get("current_cache_read") or 0,
        "state": (event or {}).get("state") or "idle",
        "model": (event or {}).get("model") or "Unknown Model",
        "timestamp": timestamp(event),
    }


def collect_agents(data):
    latest_states = data.get("latestStates") or {}
    history = data.get("history") or []
    agents = {}

    for state in latest_states.values():
        turn = state_to_turn(state)
        key = turn["source"]
        if key == "unknown" or key not in AGENT_ALLOWED:
            continue
        if key not in agents or turn["timestamp"] > agents[key]["timestamp"]:
            agents[key] = turn

    for event in history:
        turn = event_to_turn(event)
        key = turn["source"]
        if key == "unknown" or key not in AGENT_ALLOWED:
            continue
        if (turn["input"] > 0 or turn["output"] > 0) and (key not in agents or turn["timestamp"] > agents[key]["timestamp"]):
            agents[key] = turn

    ordered = []
    for key in AGENT_ORDER:
        if key in agents:
            ordered.append((key, agents[key]))
    for key in sorted(k for k in agents if k not in AGENT_ORDER):
        ordered.append((key, agents[key]))
    return ordered


def state_icon(agent_state):
    if agent_state == "working":
        return "G"
    if agent_state == "tool_use":
        return "T"
    return "I"


def main():
    try:
        req = urllib.request.Request("http://localhost:4000/api/state", method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as response:
            data = json.loads(response.read().decode("utf-8"))

        agents = collect_agents(data)
        active = [(key, turn) for key, turn in agents if turn["input"] > 0 or turn["output"] > 0]

        if active:
            parts = []
            for key, turn in active[:3]:
                label = AGENT_LABELS.get(key, key).split()[0]
                parts.append(f"{label}:{format_k(turn['input'])}/{format_k(turn['output'])}")
            print("BT " + " ".join(parts))
        else:
            print("BT idle")

        print("---")
        if not agents:
            print("No agent activity yet. | color=#94a3b8")
        for key, turn in agents:
            label = AGENT_LABELS.get(key, key)
            print(f"{label} [{state_icon(turn['state'])}] | font=Menlo")
            print(f"Latest In/Out: {format_k(turn['input'])} / {format_k(turn['output'])} tokens | font=Menlo")
            print(f"Cache Read: {format_k(turn['cache'])} tokens | font=Menlo")
            print(f"Model: {turn['model']} | font=Menlo")
            print("---")
        print("Open Web Dashboard | href=http://localhost:4000")
        print("Refresh Now | refresh=true")
    except Exception:
        print("BT offline")
        print("---")
        print("Dashboard server is not running on port 4000.")
        print("Start it with: ./boros-restart.sh")


if __name__ == "__main__":
    main()
