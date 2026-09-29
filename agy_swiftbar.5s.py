#!/usr/bin/env python3
import json
import os
import sys
import urllib.request

# SwiftBar / xbar metadata (sets refresh interval to 5 seconds)
# <bitbar.title>Boros Token Monitor</bitbar.title>
# <bitbar.version>2.3</bitbar.version>
# <bitbar.author>Boros Token</bitbar.author>
# <bitbar.desc>Displays live token usage in macOS Menu Bar with switchable UI styles</bitbar.desc>
# <bitbar.dependencies>python3</bitbar.dependencies>

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
STYLE_FILE = os.path.join(BASE_DIR, ".menu_style")

SCRIPT_STYLE_A = os.path.join(BASE_DIR, "scripts", "style_a.sh")
SCRIPT_STYLE_B = os.path.join(BASE_DIR, "scripts", "style_b.sh")
SCRIPT_TOGGLE = os.path.join(BASE_DIR, "scripts", "style_toggle.sh")

AGENT_BADGES = {
    "terminal": "AGY",
    "agy": "AGY",
    "antigravity": "AGY",
    "code": "AGY IDE",
    "codex": "CODEX",
    "opencode": "OPEN",
    "claudecode": "CLAUDE",
    "claude": "CLAUDE",
}

AGENT_LABELS = {
    "terminal": "Antigravity CLI",
    "agy": "Agy CLI",
    "antigravity": "Antigravity",
    "code": "Antigravity IDE",
    "codex": "Codex",
    "opencode": "OpenCode",
    "claudecode": "Claude Code",
    "claude": "Claude Code",
}


def get_current_style():
    try:
        if os.path.exists(STYLE_FILE):
            with open(STYLE_FILE, "r") as f:
                val = f.read().strip()
                if val in ("1", "A", "a"):
                    return "1"
                if val in ("2", "B", "b"):
                    return "2"
    except Exception:
        pass
    return "2"


def format_k(val):
    val = float(val or 0)
    if val >= 1_000_000:
        val_m = val / 1_000_000
        return f"{int(val_m)}M" if val_m.is_integer() else f"{val_m:.1f}M"
    if val >= 1_000:
        val_k = val / 1_000
        return f"{int(val_k)}k" if val_k.is_integer() else f"{val_k:.1f}k"
    return str(int(val))


def extract_model_name(model_raw):
    if isinstance(model_raw, dict):
        return model_raw.get("display_name") or model_raw.get("id") or "Gemini"
    if isinstance(model_raw, str) and model_raw:
        return model_raw
    return "Gemini"


def progress_bar(percentage, width=10):
    filled = int(round((percentage / 100.0) * width))
    filled = max(0, min(width, filled))
    return "■" * filled + "□" * (width - filled)


def main():
    current_style = get_current_style()

    try:
        req = urllib.request.Request("http://localhost:4000/api/state", method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as response:
            data = json.loads(response.read().decode("utf-8"))

        state = data.get("latestState")

        if state:
            cw = state.get("context_window", {})
            total_in = cw.get("total_input_tokens", 0)
            total_out = cw.get("total_output_tokens", 0)
            percentage = cw.get("used_percentage", 0)
            context_size = cw.get("context_window_size", 0)
            current_usage = cw.get("current_usage", {})
            cache_read = current_usage.get("cache_read_input_tokens", 0)

            agent_state = (state.get("agent_state") or "idle").lower()
            model_name = extract_model_name(state.get("model"))
            agent_raw = str(state.get("source") or state.get("agent") or state.get("product") or "").lower()

            badge = AGENT_BADGES.get(agent_raw, agent_raw.upper() if agent_raw else "BT")
            label = AGENT_LABELS.get(agent_raw, agent_raw.capitalize() if agent_raw else "Agent")

            # Status color in dropdown
            if agent_state == "working":
                state_color = "#22c55e"
            elif agent_state in ("tool_use", "reviewing"):
                state_color = "#eab308"
            else:
                state_color = "#94a3b8"

            # Render Main Menu Bar text according to selected style
            if current_style == "1":
                # Style A (Option 1): Monokrom Dot + Arrows + Percentage
                if agent_state == "working":
                    dot = "●"
                elif agent_state in ("tool_use", "reviewing"):
                    dot = "◐"
                else:
                    dot = "○"
                print(f"{dot} ↑ {format_k(total_in)} ↓ {format_k(total_out)} ({percentage:.1f}%)")
            else:
                # Style B (Option 2): Identifier Badge + Arrows (clean, without percentage)
                print(f"{badge}  ↑ {format_k(total_in)}  ↓ {format_k(total_out)}")

            # Dropdown menu items
            print("---")
            print(f"Agent: {label} | font=Menlo")
            print(f"Model: {model_name} | color=#3b82f6 font=Menlo")
            print(f"State: {agent_state.upper()} | color={state_color} font=Menlo")
            print("---")
            print(f"↑ Input Tokens  : {total_in:,} | font=Menlo")
            print(f"↓ Output Tokens : {total_out:,} | font=Menlo")
            if cache_read > 0:
                print(f"⚡ Cache Read   : {cache_read:,} | color=#94a3b8 font=Menlo")
            if context_size > 0:
                print(f"Context Window  : {percentage:.2f}% of {format_k(context_size)} | font=Menlo")
            else:
                print(f"Context Window  : {percentage:.2f}% | font=Menlo")
            print(f"[{progress_bar(percentage)}] {percentage:.1f}% used | font=Menlo")
            print("---")

            # Direct Clickable Style Options
            check_1 = "✓ " if current_style == "1" else "    "
            check_2 = "✓ " if current_style == "2" else "    "
            print(f"{check_1}Style A · Dot (● ↑ 84k ↓ 30k 8%) | bash={SCRIPT_STYLE_A} terminal=false refresh=true font=Menlo")
            print(f"{check_2}Style B · Badge (AGY ↑ 84k ↓ 30k) | bash={SCRIPT_STYLE_B} terminal=false refresh=true font=Menlo")
            print(f"⇄ Toggle Style (A ⇄ B) | bash={SCRIPT_TOGGLE} terminal=false refresh=true font=Menlo")

            print("---")
            print("Open Web Dashboard | href=http://localhost:4000")
            print("Refresh Now | refresh=true")
        else:
            if current_style == "1":
                print("○  idle")
            else:
                print("BT  idle")
            print("---")
            print("No active agent session yet. | color=#94a3b8 font=Menlo")
            print("---")
            check_1 = "✓ " if current_style == "1" else "    "
            check_2 = "✓ " if current_style == "2" else "    "
            print(f"{check_1}Style A · Dot | bash={SCRIPT_STYLE_A} terminal=false refresh=true font=Menlo")
            print(f"{check_2}Style B · Badge | bash={SCRIPT_STYLE_B} terminal=false refresh=true font=Menlo")
            print(f"⇄ Toggle Style (A ⇄ B) | bash={SCRIPT_TOGGLE} terminal=false refresh=true font=Menlo")
            print("---")
            print("Open Web Dashboard | href=http://localhost:4000")
            print("Refresh Now | refresh=true")
    except Exception:
        if current_style == "1":
            print("×  offline")
        else:
            print("BT  offline")
        print("---")
        print("🔴 Dashboard Offline | color=#ef4444 font=Menlo")
        print("Server is not responding on port 4000. | color=#94a3b8 font=Menlo")
        print("Start it with: ./boros-restart.sh | color=#94a3b8 font=Menlo")
        print("---")
        print("Open Web Dashboard | href=http://localhost:4000")
        print("Refresh Now | refresh=true")


if __name__ == "__main__":
    main()
