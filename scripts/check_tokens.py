#!/usr/bin/env python3
import os
import json
import re
import sqlite3

def decode_varint(data, pos):
    val = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        val |= (b & 0x7f) << shift
        pos += 1
        if not (b & 0x80):
            break
        shift += 7
    return val, pos

def get_text_from_blob(blob):
    if not blob: return ""
    try:
        text = blob.decode("utf-8", errors="ignore")
        if "<USER_REQUEST>" in text:
            return text.split("<USER_REQUEST>")[1].split("</USER_REQUEST>")[0].strip()
    except:
        pass
    
    # Simple regex search for standard string sequences in binary
    strings = re.findall(b"[\x20-\x7e]{4,}", blob)
    for s in strings:
        try:
            decoded = s.decode("utf-8")
            if "<USER_REQUEST>" in decoded:
                parts = decoded.split("<USER_REQUEST>")
                if len(parts) > 1:
                    sub = parts[1].split("</USER_REQUEST>")[0].strip()
                    if sub: return sub
            if any(w in decoded for w in ["bang", "kita", "proyek", "ini", "tolong"]):
                return decoded.strip()
        except:
            pass
    return ""

def load_pb_summaries(pb_path):
    if not os.path.exists(pb_path):
        return {}
    try:
        with open(pb_path, 'rb') as f:
            data = f.read()
    except Exception:
        return {}
    
    summaries = {}
    uuid_regex = re.compile(b'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
    for match in uuid_regex.finditer(data):
        uuid_str = match.group(0).decode('utf-8')
        pos = match.end()
        if pos < len(data) and data[pos] == 0x12:
            pos += 1
            while pos < len(data) and (data[pos] & 0x80):
                pos += 1
            pos += 1
            if pos < len(data) and data[pos] == 0x0a:
                pos += 1
                str_len = 0
                shift = 0
                while pos < len(data):
                    b = data[pos]
                    str_len |= (b & 0x7f) << shift
                    pos += 1
                    if not (b & 0x80):
                        break
                    shift += 7
                if pos + str_len <= len(data):
                    title_bytes = data[pos:pos+str_len]
                    try:
                        title = title_bytes.decode('utf-8')
                        if title and len(title) < 100:
                            summaries[uuid_str] = title
                    except Exception:
                        pass
    return summaries

def main():
    # Attempt to locate history_log.json
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    history_path = os.path.join(project_dir, "history_log.json")
    
    # Fallback paths
    if not os.path.exists(history_path):
        history_path = os.path.join(os.path.expanduser("~"), "Downloads/code/project/boros-token/history_log.json")
        
    db_sessions = {}
    if os.path.exists(history_path):
        try:
            with open(history_path) as f:
                data = json.load(f)
                
                # Parse latestStates
                latest_states = data.get("latestStates", {})
                for key, state in latest_states.items():
                    cid = state.get("conversation_id") or state.get("session_id")
                    if not cid and ":" in key:
                        cid = key.split(":", 1)[1]
                    if cid and len(cid) == 36:
                        cw = state.get("context_window", {})
                        inp = cw.get("total_input_tokens", 0)
                        out = cw.get("total_output_tokens", 0)
                        if inp or out:
                            db_sessions[cid] = (inp, out, "State")
 
                # Parse history list
                for entry in data.get("history", []):
                    cid = entry.get("session_id")
                    if cid and len(cid) == 36:
                        inp = entry.get("total_input", 0)
                        out = entry.get("total_output", 0)
                        if inp or out:
                            current_max = db_sessions.get(cid, (0, 0, ""))
                            if (inp + out) > (current_max[0] + current_max[1]):
                                db_sessions[cid] = (inp, out, "History")
        except Exception as e:
            print(f"Warning: Failed to load history_log.json: {e}")

    # Load agyhub summaries
    pb_path = os.path.expanduser("~/.gemini/antigravity/agyhub_summaries_proto.pb")
    pb_summaries = load_pb_summaries(pb_path)

    # Known/hardcoded conversation names mapping
    KNOWN_NAMES = {
        "9a822d27-840d-4b70-950c-d5679ecd402a": "Token Usage Monitoring Script",
        "3fb97d03-ccef-4327-abef-b9cd36ba048c": "boros token setup",
        "dfcb49a0-09b5-4f2f-944b-2687e78dc53c": "rongsokin",
        "5b515fe2-2315-4c4b-b5a8-b7ee6f046aea": "agy setup",
        "545f4a20-6099-4208-99b1-193cfdf96e71": "ghost setup",
        "a5e90a8e-b59f-4a37-91bb-5bb0e8a97ec7": "TA"
    }

    brain_dir = os.path.expanduser("~/.gemini/antigravity-cli/brain")
    results = []
    
    if os.path.exists(brain_dir):
        for cid in os.listdir(brain_dir):
            dpath = os.path.join(brain_dir, cid)
            if os.path.isdir(dpath) and len(cid) == 36:
                tpath = os.path.join(dpath, ".system_generated/logs/transcript.jsonl")
                name = ""

                # 1. Check known names map first
                if cid in KNOWN_NAMES:
                    name = KNOWN_NAMES[cid]
                # 2. Check agyhub pb summaries
                elif cid in pb_summaries:
                    name = pb_summaries[cid]
                
                # 3. Fallback to transcript log first
                if not name and os.path.exists(tpath):
                    try:
                        with open(tpath) as f:
                            for line in f:
                                obj = json.loads(line)
                                if obj.get("type") == "USER_INPUT":
                                    content = obj.get("content", "")
                                    if "<USER_REQUEST>" in content:
                                        req = content.split("<USER_REQUEST>")[1].split("</USER_REQUEST>")[0].strip()
                                    else:
                                        req = content.strip()
                                    name = req.split("\n")[0][:60]
                                    if len(req) > 60:
                                        name += "..."
                                    break
                    except Exception:
                        pass
                
                # Fallback to sqlite database files
                if not name:
                    db_path = os.path.expanduser(f"~/.gemini/antigravity-cli/conversations/{cid}.db")
                    if os.path.exists(db_path):
                        try:
                            conn = sqlite3.connect(db_path)
                            c = conn.cursor()
                            c.execute("SELECT step_payload FROM steps WHERE idx=0")
                            row = c.fetchone()
                            if row and row[0]:
                                text = get_text_from_blob(row[0])
                                if text:
                                    name = text.split("\n")[0][:60]
                                    if len(text) > 60: name += "..."
                        except:
                            pass
                
                # Skip if empty/aborted session (no name and no transcript file)
                if not name and not os.path.exists(tpath):
                    continue
                
                if not name:
                    name = "Untitled Conversation"

                # Get token info
                if cid in db_sessions:
                    inp, out, _ = db_sessions[cid]
                    token_str = f"{inp + out:,} (In: {inp:,} | Out: {out:,})"
                    sort_val = inp + out
                else:
                    # Estimate from transcript size
                    full_tpath = os.path.join(dpath, ".system_generated/logs/transcript_full.jsonl")
                    if os.path.exists(full_tpath):
                        char_count = 0
                        try:
                            with open(full_tpath) as f:
                                for line in f:
                                    obj = json.loads(line)
                                    if obj.get("type") in ["USER_INPUT", "PLANNER_RESPONSE"]:
                                        char_count += len(obj.get("content", ""))
                        except:
                            pass
                        est_tokens = int(char_count / 3.8)
                        if est_tokens > 0:
                            token_str = f"~{est_tokens:,} (est)"
                            sort_val = est_tokens
                        else:
                            token_str = "0"
                            sort_val = 0
                    else:
                        token_str = "0"
                        sort_val = 0
                        
                results.append((name, token_str, cid, sort_val))

    # Sort by token count desc
    results.sort(key=lambda x: x[3], reverse=True)

    # Print markdown table
    print("| Conversation Name | Token Spend | Conversation ID |")
    print("| --- | --- | --- |")
    for name, tokens, cid, _ in results:
        print(f"| {name} | {tokens} | `{cid}` |")

if __name__ == "__main__":
    main()
