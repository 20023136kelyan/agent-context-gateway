#!/usr/bin/env python3
"""Contrastive training: issue -> fix-turns, failed-run hard negatives.

Base: BAAI/bge-small-en-v1.5. Loss: TripletLoss(margin) over
(query, positive, same-instance-failed-turn); queries with no failed turns
draw negatives from other instances' positives (standard easy negatives).
Data: swe-data/contrastive.jsonl (see build-contrastive.py).
Output: swe-models/trip-bge-small-<ts>/ (gitignored).

Launch backgrounded: nohup python3 scripts/train-contrastive.py > swe-models/trip.log 2>&1 &
Eval: same scripts/eval-dapt.py protocol (pure-vector NDCG, held-out sets).
The production voyage/Jev arch is untouched by this experiment either way.
"""
import argparse
import datetime
import json
import os
import random
import sys

LOCAL_PKGS = os.path.expanduser("~/.local/lib/python3.10/site-packages")
sys.path.insert(0, LOCAL_PKGS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="swe-data/contrastive.jsonl")
    ap.add_argument("--outbase", default="swe-models/trip-bge-small")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--margin", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)

    from sentence_transformers import InputExample, SentenceTransformer, losses
    from torch.utils.data import DataLoader

    rows = [json.loads(l) for l in open(args.data) if l.strip()]
    others = [p for r in rows for p in r["pos"]]
    examples = []
    for r in rows:
        negs = r["neg"] or random.sample(others, min(2, len(others)))
        for p in r["pos"]:
            for ng in negs[:2]:
                examples.append(InputExample(texts=[r["query"], p, ng]))
    print(f"triplets={len(examples)} from {len(rows)} queries", flush=True)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    outdir = f"{args.outbase}-{stamp}"
    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    model.max_seq_length = 512
    loader = DataLoader(examples, batch_size=args.batch, shuffle=True)
    loss = losses.TripletLoss(model=model, distance_metric=losses.SiameseDistanceMetric.COSINE_DISTANCE,
                              triplet_margin=args.margin)
    model.fit([(loader, loss)], epochs=args.epochs, warmup_steps=min(100, len(loader) // 10),
              output_path=outdir, show_progress_bar=False)
    print(f"saved {outdir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
