#!/usr/bin/env python3
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

# SwiftBar / xbar metadata (sets refresh interval to 5 seconds)
# <bitbar.title>Boros Token Monitor</bitbar.title>
# <bitbar.version>3.0</bitbar.version>
# <bitbar.author>Boros Token</bitbar.author>
# <bitbar.desc>Displays live token usage and cost in macOS Menu Bar with Syrtis-inspired UI</bitbar.desc>
# <bitbar.dependencies>python3</bitbar.dependencies>

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
STYLE_FILE = os.path.join(BASE_DIR, ".menu_style")
ASSETS_DIR = os.path.join(BASE_DIR, "assets", "icons")

SCRIPT_STYLE_A = os.path.join(BASE_DIR, "scripts", "style_a.sh")
SCRIPT_STYLE_B = os.path.join(BASE_DIR, "scripts", "style_b.sh")
SCRIPT_STYLE_C = os.path.join(BASE_DIR, "scripts", "style_c.sh")
SCRIPT_STYLE_D = os.path.join(BASE_DIR, "scripts", "style_d.sh")
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

AGENT_ICON_MAP = {
    "terminal": "antigravity.png",
    "agy": "antigravity.png",
    "antigravity": "antigravity.png",
    "code": "antigravity.png",
    "codex": "codex.png",
    "opencode": "opencode.png",
    "claudecode": "claude.png",
    "claude": "claude.png",
}

# In-memory base64 cache for icons
_ICON_CACHE = {}


def get_icon_base64(icon_name):
    if not icon_name:
        return None
    if icon_name in _ICON_CACHE:
        return _ICON_CACHE[icon_name]
    path = os.path.join(ASSETS_DIR, icon_name)
    if os.path.exists(path):
        try:
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                _ICON_CACHE[icon_name] = b64
                return b64
        except Exception:
            return None
    return None


def get_current_style():
    try:
        if os.path.exists(STYLE_FILE):
            with open(STYLE_FILE, "r") as f:
                val = f.read().strip()
                if val in ("1", "2", "3", "4"):
                    return val
    except Exception:
        pass
    return "1"


def format_k(val):
    val = float(val or 0)
    if val >= 1_000_000:
        val_m = val / 1_000_000
        return f"{int(val_m)}M" if val_m.is_integer() else f"{val_m:.1f}M"
    if val >= 1_000:
        val_k = val / 1_000
        return f"{int(val_k)}k" if val_k.is_integer() else f"{val_k:.1f}k"
    return str(int(val))


def format_currency(val):
    v = float(val or 0)
    if v >= 10.0:
        return f"${v:.2f}"
    if v >= 1.0:
        return f"${v:.3f}"
    if v >= 0.001:
        return f"${v:.4f}"
    if v > 0:
        return f"${v:.5f}"
    return "$0.00"


def extract_model_name(model_raw):
    if isinstance(model_raw, dict):
        return model_raw.get("display_name") or model_raw.get("id") or "Unknown"
    if isinstance(model_raw, str) and model_raw:
        return model_raw
    return "Unknown"


def resolve_provider(model_name):
    name = (model_name or "").lower()
    if any(k in name for k in ("claude", "sonnet", "opus", "haiku")):
        return "Anthropic"
    if "grok" in name:
        return "xAI"
    if "deepseek" in name:
        return "DeepSeek"
    if any(k in name for k in ("gpt", "codex", "o1", "o3")):
        return "OpenAI"
    if any(k in name for k in ("gemini", "flash", "pro")):
        return "Google"
    return "AI Model"


def progress_bar(percentage, width=12):
    pct = max(0.0, min(100.0, float(percentage or 0)))
    filled = int(round((pct / 100.0) * width))
    filled = max(0, min(width, filled))
    return "■" * filled + "□" * (width - filled)


def time_ago(iso_str):
    if not iso_str:
        return ""
    try:
        t = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        now = datetime.now(t.tzinfo)
        diff_sec = int((now - t).total_seconds())
        if diff_sec < 60:
            return f"{diff_sec}s ago"
        diff_min = diff_sec // 60
        if diff_min < 60:
            return f"{diff_min}m ago"
        diff_hr = diff_min // 60
        if diff_hr < 24:
            return f"{diff_hr}h ago"
        diff_day = diff_hr // 24
        return f"{diff_day}d ago"
    except Exception:
        return ""


def main():
    current_style = get_current_style()
    text_style = "font=Menlo color=#0f172a,#f8fafc"
    sub_style = "font=Menlo color=#475569,#94a3b8"

    try:
        req = urllib.request.Request("http://localhost:4000/api/state", method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as response:
            data = json.loads(response.read().decode("utf-8"))

        state = data.get("latestState")
        latest_states = data.get("latestStates", {})
        history = data.get("history", [])

        if state:
            cw = state.get("context_window", {})
            total_in = cw.get("total_input_tokens", 0)
            total_out = cw.get("total_output_tokens", 0)
            percentage = cw.get("used_percentage", 0)
            context_size = cw.get("context_window_size", 0)
            current_usage = cw.get("current_usage", {})
            cache_read = current_usage.get("cache_read_input_tokens", 0)
            turn_input = current_usage.get("input_tokens", 0)
            turn_output = current_usage.get("output_tokens", 0)

            agent_state = (state.get("agent_state") or "idle").lower()
            model_name = extract_model_name(state.get("model"))
            provider = resolve_provider(model_name)
            agent_raw = str(state.get("source") or state.get("agent") or state.get("product") or "").lower()

            badge = AGENT_BADGES.get(agent_raw, agent_raw.upper() if agent_raw else "BT")
            label = AGENT_LABELS.get(agent_raw, agent_raw.capitalize() if agent_raw else "Agent")
            icon_file = AGENT_ICON_MAP.get(agent_raw, "brandmark.png")
            icon_b64 = get_icon_base64(icon_file)

            # Estimate turn cost from state or latest matching history item
            turn_cost = 0.0
            if history:
                for h in reversed(history):
                    if (h.get("source") == agent_raw or h.get("agent") == agent_raw) and "cost" in h:
                        turn_cost = float(h.get("cost", 0.0))
                        break

            # Today total cost calculation
            today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            today_cost = 0.0
            today_tokens = 0
            for h in history:
                ts = h.get("timestamp", "")
                if ts.startswith(today_str):
                    today_cost += float(h.get("cost", 0.0))
                    today_tokens += int(h.get("current_input", 0)) + int(h.get("current_output", 0))

            # Status dot and color
            if agent_state == "working":
                dot = "●"
                state_color = "#15803d,#4ade80"
                state_text = "WORKING"
            elif agent_state in ("tool_use", "reviewing"):
                dot = "◐"
                state_color = "#b45309,#fbbf24"
                state_text = "TOOL USE"
            else:
                dot = "○"
                state_color = "#334155,#cbd5e1"
                state_text = "IDLE"

            # ----------------------------------------------------
            # 1. Main Menu Bar Line (Adapted Syrtis display modes)
            # ----------------------------------------------------
            title_icon_param = f"| image={icon_b64}" if icon_b64 else ""

            if current_style == "1":
                # Style A: Syrtis Classic Dot + Tokens + Percent
                print(f"{dot} ↑ {format_k(total_in)} ↓ {format_k(total_out)} ({percentage:.1f}%) {title_icon_param}".strip())
            elif current_style == "2":
                # Style B: Agent Badge + Tokens
                print(f"{badge} ↑ {format_k(total_in)} ↓ {format_k(total_out)} {title_icon_param}".strip())
            elif current_style == "3":
                # Style C: Cost Focus (Syrtis Today Cost Mode)
                cost_display = format_currency(turn_cost if turn_cost > 0 else today_cost)
                print(f"{dot} {cost_display} ({format_k(total_in + total_out)}) {title_icon_param}".strip())
            else:
                # Style D: Quota Focus (Syrtis Quota Window Mode)
                cost_display = format_currency(turn_cost if turn_cost > 0 else today_cost)
                print(f"{dot} {percentage:.1f}% · {cost_display} {title_icon_param}".strip())

            # ----------------------------------------------------
            # 2. Syrtis Header Card: Active Agent & Model
            # ----------------------------------------------------
            print("---")
            agent_img_param = f"image={icon_b64}" if icon_b64 else ""
            print(f"{label} · {state_text} | {text_style} color={state_color} {agent_img_param}".strip())
            print(f"{model_name} ({provider}) | color=#1d4ed8,#60a5fa font=Menlo")

            # ----------------------------------------------------
            # 3. Syrtis Quota & Context Gauge Card
            # ----------------------------------------------------
            print("---")
            gauge_str = progress_bar(percentage)
            print(f"Context: [{gauge_str}] {percentage:.1f}% | {text_style}")
            if context_size > 0:
                rem_tok = max(0, context_size - (total_in + total_out))
                print(f"Used {format_k(total_in + total_out)} / {format_k(context_size)} ({format_k(rem_tok)} left) | {sub_style}")
            else:
                print(f"Total Session Tokens: {format_k(total_in + total_out)} | {sub_style}")

            # ----------------------------------------------------
            # 4. Token & Cost Details Card (Syrtis Metrics)
            # ----------------------------------------------------
            print("---")
            print(f"↑ Prompt Input   : {total_in:,} | {text_style}")
            print(f"↓ Output Tokens  : {total_out:,} | {text_style}")
            if cache_read > 0:
                cache_pct = (cache_read / max(1, total_in + cache_read)) * 100
                print(f"⚡ Cache Read    : {cache_read:,} ({cache_pct:.0f}% hit) | color=#0284c7,#38bdf8 font=Menlo")
            if turn_cost > 0:
                print(f"💰 Est. Turn Cost : {format_currency(turn_cost)} | color=#d97706,#f59e0b font=Menlo")
            if today_cost > 0:
                print(f"📅 Today's Spend  : {format_currency(today_cost)} ({format_k(today_tokens)} tok) | {sub_style}")

            # ----------------------------------------------------
            # 5. Multi-Agent Overview (Syrtis DashboardTabs)
            # ----------------------------------------------------
            active_sessions = []
            for s_key, s_val in latest_states.items():
                s_agent = str(s_val.get("source") or s_val.get("agent") or "").lower()
                s_cw = s_val.get("context_window", {})
                s_in = s_cw.get("total_input_tokens", 0)
                s_out = s_cw.get("total_output_tokens", 0)
                s_model = extract_model_name(s_val.get("model"))
                s_label = AGENT_LABELS.get(s_agent, s_agent.capitalize() or "Agent")
                s_state = (s_val.get("agent_state") or "idle").upper()
                s_icon = AGENT_ICON_MAP.get(s_agent)
                active_sessions.append((s_label, s_model, s_in + s_out, s_state, s_icon))

            if len(active_sessions) > 1:
                print("---")
                print(f"Active Agents ({len(active_sessions)}) | {sub_style}")
                for a_lbl, a_mod, a_tok, a_st, a_ic in active_sessions:
                    img_opt = f"image={get_icon_base64(a_ic)}" if a_ic and get_icon_base64(a_ic) else ""
                    print(f"--{a_lbl}: {a_mod} · {format_k(a_tok)} tok [{a_st}] | {text_style} {img_opt}".strip())

            # ----------------------------------------------------
            # 6. Syrtis Recent Turns Trace (Last 5 events)
            # ----------------------------------------------------
            if history:
                print("---")
                print(f"Recent Activity ({min(5, len(history))}) | {sub_style}")
                for h in reversed(history[-5:]):
                    h_src = AGENT_LABELS.get(h.get("source", ""), h.get("source", "Agent"))
                    h_mod = h.get("model", "")
                    h_tot = (h.get("current_input", 0) or 0) + (h.get("current_output", 0) or 0)
                    h_cost = float(h.get("cost", 0.0))
                    h_time = time_ago(h.get("timestamp"))
                    cost_str = f" · {format_currency(h_cost)}" if h_cost > 0 else ""
                    print(f"--{h_time} · {h_src} (+{format_k(h_tot)} tok{cost_str}) | {text_style}")
                    print(f"----Model: {h_mod} | {sub_style}")
                    print(f"----Tokens: In {h.get('current_input',0):,} / Out {h.get('current_output',0):,} | {sub_style}")

            # ----------------------------------------------------
            # 7. Menu Bar Styles & Control (Syrtis Tray Settings)
            # ----------------------------------------------------
            print("---")
            chk_1 = "✓ " if current_style == "1" else "    "
            chk_2 = "✓ " if current_style == "2" else "    "
            chk_3 = "✓ " if current_style == "3" else "    "
            chk_4 = "✓ " if current_style == "4" else "    "

            print(f"Display Mode | {sub_style}")
            print(f"--{chk_1}Style A · Dot + Tokens (● ↑ 15k ↓ 2.5k 8%) | bash={SCRIPT_STYLE_A} terminal=false refresh=true {text_style}")
            print(f"--{chk_2}Style B · Agent Badge (CLAUDE ↑ 15k ↓ 2.5k) | bash={SCRIPT_STYLE_B} terminal=false refresh=true {text_style}")
            print(f"--{chk_3}Style C · Cost Focus (● $0.08 · 17k) | bash={SCRIPT_STYLE_C} terminal=false refresh=true {text_style}")
            print(f"--{chk_4}Style D · Quota Focus (● 8.8% · $0.08) | bash={SCRIPT_STYLE_D} terminal=false refresh=true {text_style}")
            print(f"--⇄ Cycle Mode (A ⇄ B ⇄ C ⇄ D) | bash={SCRIPT_TOGGLE} terminal=false refresh=true {text_style}")

            print("---")
            brandmark_b64 = get_icon_base64("brandmark.png")
            dash_img = f"image={brandmark_b64}" if brandmark_b64 else ""
            print(f"Open Web Dashboard | href=http://localhost:4000 {text_style} {dash_img}".strip())
            print(f"Refresh Now | refresh=true {text_style}")

        else:
            # Idle state
            if current_style == "1":
                print("○ idle")
            elif current_style == "2":
                print("BT idle")
            else:
                print("○ $0.00")
            print("---")
            print(f"No active AI agent session. | {sub_style}")
            print("---")
            chk_1 = "✓ " if current_style == "1" else "    "
            chk_2 = "✓ " if current_style == "2" else "    "
            chk_3 = "✓ " if current_style == "3" else "    "
            chk_4 = "✓ " if current_style == "4" else "    "
            print(f"Display Mode | {sub_style}")
            print(f"--{chk_1}Style A · Dot + Tokens | bash={SCRIPT_STYLE_A} terminal=false refresh=true {text_style}")
            print(f"--{chk_2}Style B · Badge | bash={SCRIPT_STYLE_B} terminal=false refresh=true {text_style}")
            print(f"--{chk_3}Style C · Cost | bash={SCRIPT_STYLE_C} terminal=false refresh=true {text_style}")
            print(f"--{chk_4}Style D · Quota | bash={SCRIPT_STYLE_D} terminal=false refresh=true {text_style}")
            print("---")
            print(f"Open Web Dashboard | href=http://localhost:4000 {text_style}")
            print(f"Refresh Now | refresh=true {text_style}")

    except Exception as e:
        print("🔴 Offline")
        print("---")
        print(f"🔴 Dashboard Server Offline | color=#dc2626,#f87171 font=Menlo")
        print(f"Server is not responding on port 4000. | {sub_style}")
        print(f"Start it with: ./boros-restart.sh | color=#15803d,#4ade80 font=Menlo")
        print("---")
        print(f"Open Web Dashboard | href=http://localhost:4000 {text_style}")
        print(f"Refresh Now | refresh=true {text_style}")


if __name__ == "__main__":
    main()
