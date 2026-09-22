#!/usr/bin/env python3
"""Head-to-head pure-vector eval: base bge-small vs DAPT model (runs on VM).

Isolates the embedding space: no BM25, no rerank, no judge. For each golden
file, encodes every corpus turn once per model, ranks sessions per query by
best-turn cosine, and reports session-level NDCG@5/MRR/P@1 overall + by domain.

Corpora (built by scripts/dump-eval-turns.mjs, run first):
  swe-data/eval-turns-<name>.jsonl  {"session": ..., "text": ...}
Golden files pair by name: fixture, trajectories, real, entities, swe-gym.
Held-out discipline: the fixture golden tuned the gate/pool/weights — read
its numbers as tuning-set; trajectories + real + swe-gym were never tuned
against and carry the verdict.

Usage: python3 scripts/eval-dapt.py --models BAAI/bge-small-en-v1.5,swe-models/dapt-bge-small-<ts> [--sets fixture,trajectories,real]
"""
import argparse
import json
import math
import os
import sys

LOCAL_PKGS = os.path.expanduser("~/.local/lib/python3.10/site-packages")
sys.path.insert(0, LOCAL_PKGS)

SETS = {
    "fixture": ("swe-data/eval-turns-fixture.jsonl", "tests/eval/golden-fixture.json"),
    "trajectories": ("swe-data/eval-turns-trajfixtures.jsonl", "tests/eval/golden-trajectories.json"),
    "real": ("swe-data/eval-turns-real.jsonl", "swe-data/golden-real.json"),
    "entities": ("swe-data/eval-turns-fixture.jsonl", "tests/eval/golden-entities.json"),
    "swe-gym": ("swe-data/eval-turns-swe.jsonl", "tests/eval/golden-swe-gym.json"),
}


def dcg(rel, k=5):
    return sum(r / math.log2(i + 2) for i, r in enumerate(rel[:k]))


def ndcg(ranked, relevant, k=5):
    rel = [1 if s in relevant else 0 for s in ranked]
    ideal = sorted(rel, reverse=True)
    denom = dcg(ideal, k)
    return dcg(rel, k) / denom if denom else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--sets", default="fixture,trajectories,real")
    ap.add_argument("--batch", type=int, default=128)
    args = ap.parse_args()

    from sentence_transformers import SentenceTransformer

    models = [(m.split("/")[-1][:28], SentenceTransformer(m)) for m in args.models.split(",")]
    for _, st in models:
        st.max_seq_length = 512

    for sname in args.sets.split(","):
        turns_path, golden_path = SETS[sname.strip()]
        turns, sessions = [], []
        with open(turns_path) as f:
            for line in f:
                o = json.loads(line)
                if o.get("text", "").strip():
                    turns.append(o["text"][:2000])
                    sessions.append(o["session"])
        golden = json.load(open(golden_path))
        print(f"===== {sname}: {len(turns)} turns, {len(golden)} queries", flush=True)
        for mname, st in models:
            import torch

            with torch.no_grad():
                import numpy as np

                T = st.encode(turns, batch_size=args.batch, show_progress_bar=False,
                              convert_to_numpy=True, normalize_embeddings=True)
            agg = {"n": 0, "ndcg": 0.0, "mrr": 0.0, "p1": 0.0}
            doms: dict = {}
            for q in golden:
                qv = st.encode([q["query"]], convert_to_numpy=True, normalize_embeddings=True)[0]
                sims = T @ qv
                best: dict = {}
                for sid, s in zip(sessions, sims):
                    if sid not in best or s > best[sid]:
                        best[sid] = s
                ranked = sorted(best, key=best.get, reverse=True)
                rel = set(q["relevantSessionIds"])
                n = ndcg(ranked, rel)
                rr = next((1.0 / (i + 1) for i, s in enumerate(ranked[:5]) if s in rel), 0.0)
                p1 = 1.0 if ranked and ranked[0] in rel else 0.0
                agg["n"] += 1
                agg["ndcg"] += n
                agg["mrr"] += rr
                agg["p1"] += p1
                d = doms.setdefault(q.get("domain", "?"), [0, 0.0])
                d[0] += 1
                d[1] += n
            n = agg["n"]
            dd = " ".join(f"{k}={v[1]/v[0]:.3f}" for k, v in doms.items())
            print(f"  {mname}: ndcg={agg['ndcg']/n:.4f} mrr={agg['mrr']/n:.4f} p1={agg['p1']/n:.3f} [{dd}]", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
