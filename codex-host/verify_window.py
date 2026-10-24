#!/usr/bin/env python3
"""Print the 5h-window rate_limits recorded in a Codex session file.

Usage: verify_window.py <session-id-substring>
Finds ~/.codex/sessions/*/*/*/*<id>*.jsonl, takes the LAST rate_limits
record in it, and prints one JSON line:
{"used_percent":..., "window_minutes":..., "resets_at_cst":"..."}
Exits 2 with an error JSON when not found.
"""
import json, glob, sys, datetime, os

CST = datetime.timezone(datetime.timedelta(hours=8))

def find_rate_limits(obj):
    stack = [obj]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            rl = o.get("rate_limits")
            if isinstance(rl, dict) and "primary" in rl:
                return rl
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
    return None

def main():
    sid = sys.argv[1]
    home = os.path.expanduser("~")
    files = sorted(glob.glob(f"{home}/.codex/sessions/*/*/*/*{sid}*.jsonl"))
    if not files:
        print(json.dumps({"error": "session_file_not_found", "sid": sid}))
        return 2
    last = None
    for line in open(files[-1]):
        if "rate_limits" not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        rl = find_rate_limits(d)
        if rl:
            last = rl
    if not last or not last.get("primary"):
        print(json.dumps({"error": "no_rate_limits_in_session", "file": files[-1]}))
        return 2
    p = last["primary"]
    out = {
        "used_percent": p.get("used_percent"),
        "window_minutes": p.get("window_minutes"),
        "resets_at_cst": datetime.datetime.fromtimestamp(p["resets_at"], CST).isoformat(),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
