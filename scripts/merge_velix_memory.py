#!/usr/bin/env python3
"""Merge a new Velix security finding into flagged-vulnerabilities JSON."""
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

INPUT = Path("/workspace/.security-review/velix_mem_input.json")
OUTPUT = Path("/tmp/velix_mem_merged.json")

commit_hash = "7640c1aea8a7cb3a406e384e37d9af70ec64ed0a"
now = datetime.now(ZoneInfo("America/Los_Angeles"))
detected_at_pst = now.strftime("%Y-%m-%dT%H:%M:%S") + now.strftime("%z")
if len(detected_at_pst) > 5 and detected_at_pst[-5] in "+-" and detected_at_pst[-3] != ":":
    detected_at_pst = detected_at_pst[:-2] + ":" + detected_at_pst[-2:]

new_finding = {
    "title": "Terminal AI tab autocomplete reuses poisoned AIService session history from prior project-context chats, enabling trojan shell command execution after Tab+Enter.",
    "status": "active",
    "commit_hash": commit_hash,
    "detected_at_pst": detected_at_pst,
    "reported_link": "",
    "severity": "high",
    "location": "src/components/TerminalBlock.tsx",
}


def main() -> int:
    if not INPUT.exists():
        print(f"missing {INPUT}", file=sys.stderr)
        return 1
    with INPUT.open() as f:
        data = json.load(f)
    titles = {f.get("title") for f in data.get("findings", [])}
    if new_finding["title"] not in titles:
        data.setdefault("findings", []).append(new_finding)
    with OUTPUT.open("w") as f:
        json.dump(data, f, indent=4)
        f.write("\n")
    print(len(data["findings"]))
    print(detected_at_pst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
