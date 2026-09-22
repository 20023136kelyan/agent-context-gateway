#!/usr/bin/env python3
"""Build contrastive triples for embedding training (runs on the worker VM).

Positives (query -> passage buys recall twice: language AND code):
  - substantive assistant turns from RESOLVED runs (200-1500 chars, no boilerplate)
  - the gold patch diff itself (code passage; truncated)
Negatives:
  - hard: turns from FAILED runs of the SAME instance (topical but wrong —
    the scarce ingredient, free here via the `resolved` flag)
  - the rest comes from in-batch negatives at train time.

Source: SWE-Gym tasks (problem_statement) + sampled trajectories in
swe-data/swe-gym/*.json. Real user histories are excluded: no issue labels,
and baking private text into shipped weights needs its own decision.

Output: swe-data/contrastive.jsonl [{"query","pos":[...],"neg":[...]}].
Golden sets are NEVER touched: swe-gym golden queries evaluate, these
overlapping-but-distinct pairs train (same instances, different passages).
"""
import argparse
import glob
import json
import os

MIN_POS = 200
MAX_POS = 1500
MAX_NEG = 2000
BOILER = ("you are a helpful assistant", "important>", "<uploaded_files>", "turn_aborted")


def good_pos(text: str) -> bool:
    t = text.strip()
    if not (MIN_POS <= len(t) <= MAX_POS):
        return False
    low = t.lower()
    return not any(b in low for b in BOILER)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=None, help="SWE-Gym tasks parquet (auto-download)")
    ap.add_argument("--trajdir", default="swe-data/swe-gym")
    ap.add_argument("--out", default="swe-data/contrastive.jsonl")
    args = ap.parse_args()

    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    tp = args.tasks or hf_hub_download(
        "SWE-Gym/SWE-Gym", "data/train-00000-of-00001.parquet", repo_type="dataset")
    tasks = {r["instance_id"]: r for r in pq.read_table(tp).to_pylist()}

    # Group steps by instance first: failed runs contribute hard negatives
    # to the same instance query their resolved siblings answer.
    by_iid: dict = {}
    for path in sorted(glob.glob(os.path.join(args.trajdir, "*.json"))):
        try:
            doc = json.load(open(path))
        except Exception:
            continue
        iid = str(doc.get("instance_id", "")).split("--r")[0]
        task = tasks.get(iid)
        if not task or not str(task.get("problem_statement", "")).strip():
            continue
        by_iid.setdefault(iid, {"task": task, "pos": [], "neg": []})
        slot = by_iid[iid]
        is_res = bool(doc.get("resolved"))
        for s in doc.get("steps", []):
            if not isinstance(s, dict):
                continue
            th = str(s.get("thought", "") or "")
            ob = str(s.get("observation", "") or "")
            if is_res:
                if good_pos(th):
                    slot["pos"].append(th[:MAX_POS])
                elif ob.strip() and MIN_POS <= len(ob) <= MAX_NEG:
                    slot["pos"].append(ob[:MAX_NEG])
            elif ob.strip() and len(ob) <= MAX_NEG:
                slot["neg"].append(ob[:MAX_NEG])
    n_q = n_pos = n_neg = 0
    with open(args.out, "w") as out:
        for iid, slot in by_iid.items():
            task = slot["task"]
            if not slot["pos"]:
                continue
            query = str(task["problem_statement"]).strip()[:1500]
            patch = str(task.get("patch", "") or "")[:MAX_POS]
            poss = slot["pos"][:3]
            if len(patch) >= MIN_POS:
                poss = poss[:2] + ["Code change that fixed the issue:\n" + patch]
            negs = slot["neg"][:4]
            out.write(json.dumps({"query": query, "pos": poss, "neg": negs}) + "\n")
            n_q += 1
            n_pos += len(poss)
            n_neg += len(negs)
    print(f"queries={n_q} positives={n_pos} hardneg={n_neg}", flush=True)
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
