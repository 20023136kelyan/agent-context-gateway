#!/usr/bin/env python3
"""Build a real-history eval corpus from SWE-Gym data (runs on the worker VM).

Downloads (HF, public, ungated):
  SWE-Gym/SWE-Gym                        tasks: instance_id -> problem_statement, repo
  SWE-Gym/OpenHands-Sampled-Trajectories runs: instance_id, resolved, messages[]

Sampling: prefer instances with >=1 resolved run; pair each resolved run with
a failed run of the same instance where available (failed runs stay in the
corpus UNLISTED, so they act as real-world distractor pressure). Cap
--max-instances, diversify across repos (--repo-cap per repo).

Output (gitignored swe-data/, regenerable):
  swe-data/swe-gym/<instance>--r<k>.json   {instance_id, repo, resolved, steps}
  steps: [{thought|action|observation}] mapped from OpenHands messages;
         system boilerplate dropped (identical across runs = pure noise).

Golden (committed): tests/eval/golden-swe-gym.json — one query per instance,
query = verbatim problem_statement (tests recall over real agent language),
relevant = resolved runs only. No decisionQuery flags: trajectories are
single-task debugging traces, not decision records.

Usage: python3 scripts/build-swe-gym.py --max-instances 50 --out swe-data/swe-gym
       python3 scripts/build-swe-gym.py --max-instances 150 --repo-cap 24 --append
         (--append keeps existing swe-1..N golden ids exactly and only adds new
          instances, deduping bases already present in --out; --repo-cap counts
          existing per-repo usage so diversity is preserved across runs.)
Requires: pyarrow (pip install pyarrow).
"""
import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.expanduser("~/.local/lib/python3.10/site-packages"))

OBS_MAX = 4000
STEPS_MAX = 150


def text(v) -> str:
    if v is None:
        return ""
    return str(v)


def to_steps(messages) -> list:
    # Robust: malformed trajectories (non-list, non-dict rows) are skipped.
    if not isinstance(messages, list):
        return []
    steps = []
    for m in messages:
        try:
            if not isinstance(m, dict):
                continue
            role = m.get("role") or ""
            if role == "system":
                continue  # identical boilerplate in every trace
            content = text(m.get("content")).strip()
            step: dict = {}
            if role == "tool":
                if content:
                    step["observation"] = content[:OBS_MAX]
                name = text(m.get("name")).strip()
                if name:
                    step["tool"] = name
            else:
                if content:
                    step["thought"] = content
                fc = m.get("function_call") or {}
                calls = m.get("tool_calls") or []
                acts = []
                if isinstance(fc, dict) and (fc.get("name") or fc.get("arguments")):
                    acts.append(f"{fc.get('name', '?')}({str(fc.get('arguments', ''))[:300]})")
                if isinstance(calls, list):
                    for c in calls:
                        try:
                            fn = (c.get("function") or {}) if isinstance(c, dict) else {}
                            if isinstance(fn, dict) and fn.get("name"):
                                acts.append(f"{fn.get('name')}({str(fn.get('arguments', ''))[:300]})")
                            elif isinstance(c, dict) and text(c.get("name")).strip():
                                acts.append(text(c["name"]).strip())
                        except Exception:
                            continue
                if acts:
                    step["action"] = "; ".join(acts)
            if step:
                steps.append(step)
        except Exception:
            # One bad message must not kill the whole trajectory.
            continue
    if len(steps) > STEPS_MAX:
        steps = steps[:100] + steps[-50:]
    return steps


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-instances", type=int, default=50)
    ap.add_argument("--out", default="swe-data/swe-gym")
    ap.add_argument("--golden", default="tests/eval/golden-swe-gym.json")
    # Backward-compatible extensions for scaling runs:
    ap.add_argument("--repo-cap", type=int, default=8,
                    help="max instances per repo (default 8; scale 3x -> 24 for ~150 total)")
    ap.add_argument("--append", action="store_true",
                    help="keep existing golden ids + existing files; only add new instances "
                         "up to --max-instances total (dedupes bases in --out)")
    args = ap.parse_args()

    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    os.makedirs(args.out, exist_ok=True)

    # --- Load existing state for --append (stable ids) ---
    existing_golden: list = []
    existing_bases: set = set()
    existing_by_repo: dict = defaultdict(int)
    existing_max_n = 0
    n_dup_files = 0
    if args.append:
        import glob as _glob
        if os.path.exists(args.golden):
            try:
                with open(args.golden) as f:
                    existing_golden = json.load(f)
                for g in existing_golden:
                    try:
                        gid = str(g.get("id", ""))
                        if gid.startswith("swe-"):
                            existing_max_n = max(existing_max_n, int(gid.split("-", 1)[1]))
                    except Exception:
                        continue
            except Exception as e:
                print(f"warning: failed to parse existing golden {args.golden}: {e}", flush=True)
                existing_golden = []
        # Read existing output files: dedupe bases + per-repo usage.
        # Handles: unparseable files (skipped), empty steps (noted), duplicates.
        for fp in _glob.glob(os.path.join(args.out, "*.json")):
            try:
                with open(fp) as f:
                    rec = json.load(f)
                sid = str(rec.get("instance_id") or os.path.basename(fp)[:-5])
                base = sid.rsplit("--r", 1)[0] if "--r" in sid else sid
                if base in existing_bases:
                    pass  # additional run file for same base; not a new base
                else:
                    existing_bases.add(base)
                    repo = rec.get("repo") or "unknown"
                    # Count bases per repo (re-derive from one file per base below
                    # to avoid multi-run overcount; fix up after loop).
                    existing_by_repo[(repo, base)] = 1
                steps = rec.get("steps")
                if not steps:
                    print(f"warning: existing file with empty steps: {fp}", flush=True)
            except Exception as e:
                print(f"warning: failed to parse existing file {fp}: {e}", flush=True)
                n_dup_files += 1
                continue
        # Collapse (repo, base) -> repo counts.
        collapsed: dict = defaultdict(int)
        for (repo, _base), _v in existing_by_repo.items():
            collapsed[repo] += 1
        existing_by_repo = collapsed
        print(f"existing: {len(existing_bases)} instances, {len(existing_golden)} golden "
              f"(max {existing_max_n}), repos {dict(existing_by_repo)}", flush=True)

    print("downloading SWE-Gym tasks...", flush=True)
    tp = hf_hub_download("SWE-Gym/SWE-Gym", "data/train-00000-of-00001.parquet", repo_type="dataset")
    tasks = {r["instance_id"]: r for r in pq.read_table(tp).to_pylist()}
    print(f"tasks: {len(tasks)}", flush=True)

    runs = defaultdict(list)  # instance_id -> [(resolved, messages)]
    n_parse_fail = 0
    for i in range(3):
        print(f"downloading trajectories file {i}...", flush=True)
        fp = hf_hub_download(
            "SWE-Gym/OpenHands-Sampled-Trajectories",
            f"data/train.raw-0000{i}-of-00003.parquet",
            repo_type="dataset",
        )
        try:
            rows = pq.read_table(fp).to_pylist()
        except Exception as e:
            print(f"warning: failed to parse parquet file {i}: {e}", flush=True)
            n_parse_fail += 1
            continue
        for r in rows:
            try:
                if not isinstance(r, dict):
                    n_parse_fail += 1
                    continue
                iid = r.get("instance_id")
                if iid not in tasks:
                    continue
                msgs = r.get("messages") or []
                if not isinstance(msgs, list):
                    # Trajectory payload unparseable as message list -> treat as empty.
                    n_parse_fail += 1
                    msgs = []
                runs[iid].append((bool(r.get("resolved")), msgs))
            except Exception:
                n_parse_fail += 1
                continue
    print(f"instances with runs: {len(runs)} (parse failures: {n_parse_fail})", flush=True)

    # Prefer: resolved + failed pair, then resolved-only; diversify repos.
    scored = []
    for iid, rr in runs.items():
        n_res = sum(1 for x, _ in rr if x)
        n_fail = len(rr) - n_res
        if n_res == 0:
            continue
        repo = tasks[iid].get("repo") or "unknown"
        scored.append((0 if n_fail > 0 else 1, repo, iid))
    scored.sort()
    if args.append:
        # Exclude already-sampled bases; seed repo counts from existing files.
        by_repo: dict = defaultdict(int, {k: int(v) for k, v in existing_by_repo.items()})
        picked_existing = len(existing_bases)
        picked = []
        for _, repo, iid in scored:
            if iid in existing_bases:
                continue
            if picked_existing + len(picked) >= args.max_instances:
                break
            if by_repo[repo] >= args.repo_cap:
                continue
            by_repo[repo] += 1
            picked.append(iid)
        print(f"picked {len(picked)} new instances ({picked_existing} existing) "
              f"across {len(by_repo)} repos (cap {args.repo_cap})", flush=True)
    else:
        by_repo: dict = defaultdict(int)
        picked = []
        for _, repo, iid in scored:
            if len(picked) >= args.max_instances:
                break
            if by_repo[repo] >= args.repo_cap:
                continue
            by_repo[repo] += 1
            picked.append(iid)
        print(f"picked {len(picked)} instances across {len(by_repo)} repos (cap {args.repo_cap})", flush=True)

    if args.append:
        golden = list(existing_golden)  # stable: keep swe-1..N exactly
        next_n = existing_max_n + 1
        n_files = n_res_runs = 0
        n_empty = n_skipped_dup = 0
        for iid in picked:
            repo = tasks[iid].get("repo") or "unknown"
            prob = text(tasks[iid].get("problem_statement")).strip()[:1500]
            rr = runs[iid]
            res_ids, k = [], 0
            for is_res, msgs in rr:
                steps = to_steps(msgs)
                if not steps:
                    n_empty += 1
                    continue
                sid = f"{iid}--r{k}"
                k += 1
                dest = os.path.join(args.out, f"{sid}.json")
                if os.path.exists(dest):
                    # Duplicate file (e.g. re-run): reuse without clobbering.
                    n_skipped_dup += 1
                    try:
                        with open(dest) as f:
                            prev = json.load(f)
                        if prev.get("resolved"):
                            res_ids.append(sid)
                            n_res_runs += 1
                        elif is_res:
                            # Existing file disagrees; keep file but count per current run.
                            res_ids.append(sid)
                            n_res_runs += 1
                    except Exception:
                        # Unreadable duplicate -> rewrite.
                        with open(dest, "w") as f:
                            json.dump({"instance_id": sid, "repo": repo, "resolved": is_res, "steps": steps}, f)
                        n_files += 1
                        if is_res:
                            res_ids.append(sid)
                            n_res_runs += 1
                    continue
                with open(dest, "w") as f:
                    json.dump({"instance_id": sid, "repo": repo, "resolved": is_res, "steps": steps}, f)
                n_files += 1
                if is_res:
                    res_ids.append(sid)
                    n_res_runs += 1
            if res_ids and prob:
                golden.append({
                    "id": f"swe-{next_n}",
                    "domain": "code",
                    "query": prob,
                    "description": f"real issue {iid} ({repo}); relevant = resolved runs; failed runs present but unlisted",
                    "relevantSessionIds": res_ids,
                })
                next_n += 1
            else:
                print(f"warning: new instance {iid} yielded no golden "
                      f"(res={len(res_ids)}, prob={bool(prob)}); files kept as distractors", flush=True)
        with open(args.golden, "w") as f:
            json.dump(golden, f, indent=2)
        print(f"appended {len(picked)} instances -> {n_files} new trajectories "
              f"({n_res_runs} resolved, {n_empty} empty-skipped, {n_skipped_dup} dup-skipped), "
              f"{len(golden)} total golden queries", flush=True)
        return 0

    golden = []
    n_files = n_res_runs = 0
    n_empty = 0
    for n, iid in enumerate(picked):
        repo = tasks[iid].get("repo") or "unknown"
        prob = text(tasks[iid].get("problem_statement")).strip()[:1500]
        rr = runs[iid]
        res_ids, k = [], 0
        for is_res, msgs in rr:
            steps = to_steps(msgs)
            if not steps:
                n_empty += 1
                continue
            sid = f"{iid}--r{k}"
            k += 1
            dest = os.path.join(args.out, f"{sid}.json")
            if os.path.exists(dest):
                # Duplicate file from an earlier run: reuse id, don't double-write.
                with open(dest) as f:
                    try:
                        prev = json.load(f)
                        if prev.get("resolved"):
                            res_ids.append(sid)
                            n_res_runs += 1
                    except Exception:
                        pass
                continue
            with open(dest, "w") as f:
                json.dump({"instance_id": sid, "repo": repo, "resolved": is_res, "steps": steps}, f)
            n_files += 1
            if is_res:
                res_ids.append(sid)
                n_res_runs += 1
        if res_ids and prob:
            golden.append({
                "id": f"swe-{n + 1}",
                "domain": "code",
                "query": prob,
                "description": f"real issue {iid} ({repo}); relevant = resolved runs; failed runs present but unlisted",
                "relevantSessionIds": res_ids,
            })
    with open(args.golden, "w") as f:
        json.dump(golden, f, indent=2)
    print(f"wrote {n_files} trajectories ({n_res_runs} resolved, {n_empty} empty-skipped), "
          f"{len(golden)} golden queries", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
