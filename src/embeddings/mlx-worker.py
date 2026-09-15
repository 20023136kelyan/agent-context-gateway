#!/usr/bin/env python3
"""
MLX Embedding Worker — stdio JSON-RPC protocol.
Runs in-process inside ~/.context-gateway/mlx-venv on Apple Silicon GPU via Metal.
No external network server needed.
"""
import sys
import json

def main():
    try:
        from mlx_embedding_models.embedding import EmbeddingModel
    except Exception as e:
        sys.stderr.write(f"Failed to import mlx_embedding_models: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    # Initialize BGE-small on Apple Silicon GPU
    try:
        model = EmbeddingModel.from_registry("bge-small")
        # Warmup forward pass
        _ = model.encode(["warmup"])
        sys.stderr.write("MLX worker ready\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"Failed to load embedding model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            texts = req.get("texts", [])
            if not texts:
                resp = {"id": req_id, "embeddings": []}
            else:
                embs = model.encode(texts)
                # Convert numpy array to list of floats
                resp = {"id": req_id, "embeddings": embs.tolist()}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        except Exception as e:
            err_resp = {"id": req.get("id") if 'req' in locals() else None, "error": str(e)}
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
