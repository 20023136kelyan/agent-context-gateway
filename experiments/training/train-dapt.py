#!/usr/bin/env python3
"""DAPT: masked-LM continue-pretraining of bge-small on agent transcripts.

Base: BAAI/bge-small-en-v1.5 (384-dim, same lineage as the MLX engine).
Data: swe-data/dapt-train.jsonl (scrubbed; see build-dapt.py header).
Output: swe-models/dapt-bge-small-<ts>/ (gitignored weights).

Launch backgrounded: nohup python3 scripts/train-dapt.py > swe-models/train.log 2>&1 &
Eval is separate (scripts/eval-dapt.py, next step): frozen voyage-4 arm vs
DAPT vectors on held-out fixture + real golden sets. No provider changes
until a win is measured.
"""
import argparse
import datetime
import os

LOCAL_PKGS = os.path.expanduser("~/.local/lib/python3.10/site-packages")
import sys

sys.path.insert(0, LOCAL_PKGS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="swe-data/dapt-train.jsonl")
    ap.add_argument("--outbase", default="swe-models/dapt-bge-small")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-5)
    args = ap.parse_args()

    from datasets import load_dataset
    from transformers import (
        AutoModelForMaskedLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    outdir = f"{args.outbase}-{stamp}"
    model_id = "BAAI/bge-small-en-v1.5"

    tok = AutoTokenizer.from_pretrained(model_id)
    ds = load_dataset("json", data_files=args.data, split="train")

    def tok_fn(batch):
        return tok(batch["text"], truncation=True, max_length=512)

    ds = ds.map(tok_fn, batched=True, remove_columns=["text"])
    model = AutoModelForMaskedLM.from_pretrained(model_id)
    collator = DataCollatorForLanguageModeling(tok, mlm=True, mlm_probability=0.15)
    targs = TrainingArguments(
        output_dir=outdir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        learning_rate=args.lr,
        fp16=True,
        logging_steps=100,
        save_steps=1000,
        save_total_limit=2,
        report_to="none",
    )
    Trainer(model=model, args=targs, train_dataset=ds, data_collator=collator).train()
    model.save_pretrained(outdir)
    tok.save_pretrained(outdir)
    print(f"saved {outdir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
