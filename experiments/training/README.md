# Parked: custom-embedder track (2026-09-21)

Verdict: stay on voyage/Jev. Both training bets failed against frozen
baselines; this folder preserves the rails in case data scales 10-20x.

## What was tried

1. **DAPT** (`build-dapt.py` -> `train-dapt.py`): MLM continue-pretraining of
   `BAAI/bge-small-en-v1.5` on 65K scrubbed agent-transcript passages
   (71K real turns + SWE traces; scrub found 1192 emails, 3445 IPs,
   736 passwords/tokens, 2 bearers). 2 epochs, L4, ~21 min.
   Result: regressed EVERYWHERE (fixture 0.798->0.712, real 0.659->0.536,
   swe-gym 0.682->0.544). MLM optimizes token prediction, not similarity;
   2 epochs with a fresh head damaged a well-formed encoder.
2. **Contrastive triplets** (`build-contrastive.py` -> `train-contrastive.py`):
   InfoNCE/TripletLoss on 50 queries / 150 positives / 189 same-instance
   hard negatives. 40 seconds, loss 0.045 (trivial solution). Regressed
   everywhere including its own training distribution (swe-gym 0.682->0.639).

## What survives

- `eval-dapt.py`: pure-vector head-to-head harness (base vs any local model
  on fixture/trajectories/real/swe-gym). Reuse as-is.
- `dump-eval-turns.ts`: turn dumps the harness reads.
- `build-dapt.py`: corpus assembly + the secret scrubber (load-bearing for
  ANY future training on user histories).
- `swe-models/` weights (VM only, gitignored): dapt + triplet checkpoints
  as negative controls.

## To reopen

Scale triples 10-20x (two more SWE-Gym parquet files undownloaded), shorter
cleaner positives (patch diffs over rambles), then rerun `eval-dapt.py`.
Do not train against golden sets; do not ship without beating voyage-4 on
held-out real + swe-gym.
