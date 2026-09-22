#!/usr/bin/env python3
"""Assemble the DAPT corpus (runs on the worker VM).

Inputs (all local, never uploaded):
  swe-data/dapt-raw.jsonl   real turns (node dump; may contain secrets)
  swe-data/swe-gym/*.json   public SWE-Gym traces (steps)

Pipeline: length filter -> secret scrub -> dedupe -> train JSONL.
The scrub is the load-bearing step: real histories contain tokens, keys and
credentials, and training would bake them into the weights. Patterns are
conservative (replace with <REDACTED:kind>); the counts printed at the end
tell you what was found. Review them — a zero count on user data is a reason
to distrust the patterns, not to celebrate.

Output: swe-data/dapt-train.jsonl [{"text": ...}], plus stats on stdout.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys

SCRUBS = [
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("openai_key", re.compile(r"\bsk-(proj-)?[A-Za-z0-9\-_]{20,}\b")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9\-_]{10,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-_]{10,}\b")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-_\.~\+/=]{20,}")),
    ("password_assign", re.compile(r"(?i)(password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*['\"]?[^'\"\s]{8,}['\"]?")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]

MIN_CHARS = 60
MAX_CHARS = 6000


def scrub(text: str, counts: dict) -> str:
    for kind, rx in SCRUBS:
        text, n = rx.subn(f"<REDACTED:{kind}>", text)
        if n:
            counts[kind] = counts.get(kind, 0) + n
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="swe-data/dapt-raw.jsonl")
    ap.add_argument("--swe", default="swe-data/swe-gym")
    ap.add_argument("--out", default="swe-data/dapt-train.jsonl")
    args = ap.parse_args()

    seen = set()
    counts: dict = {}
    kept = dropped_len = dropped_dup = 0
    with open(args.out, "w") as out:
        def emit(text: str):
            nonlocal kept, dropped_len, dropped_dup
            text = text.strip()
            if not (MIN_CHARS <= len(text) <= MAX_CHARS):
                dropped_len += 1
                return
            text = scrub(text, counts)
            h = hashlib.sha256(text.encode()).hexdigest()
            if h in seen:
                dropped_dup += 1
                return
            seen.add(h)
            out.write(json.dumps({"text": text}) + "\n")
            kept += 1

        if os.path.exists(args.raw):
            with open(args.raw) as f:
                for line in f:
                    try:
                        emit(json.loads(line).get("text", ""))
                    except Exception:
                        continue
        for path in sorted(glob.glob(os.path.join(args.swe, "*.json"))):
            try:
                with open(path) as f:
                    doc = json.load(f)
            except Exception:
                continue
            for s in doc.get("steps", []):
                if not isinstance(s, dict):
                    continue
                for key in ("thought", "action", "observation"):
                    v = s.get(key)
                    if isinstance(v, str) and v.strip():
                        emit(v)

    print(f"kept={kept} dropped_len={dropped_len} dropped_dup={dropped_dup}")
    print("scrub hits:", json.dumps(counts, indent=0) if counts else "(none — distrust this on user data, see header)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
