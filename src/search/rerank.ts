/**
 * In-process Neural Cross-Encoder Reranker using ONNX runtime (@xenova/transformers).
 * Model: Xenova/bge-reranker-base (quantized int8).
 * Runs full cross-attention over (query, turn_content) pairs on top-K candidate turns.
 * Latency budget: ~150-250ms for 10-15 candidates on Apple Silicon.
 */

export interface RerankCandidate {
  id: string;
  content: string;
  score: number;
}

export interface RerankResult {
  id: string;
  originalScore: number;
  rerankScore: number;
  combinedScore: number;
  /** false when the model couldn't run and scores are the originals passed through. */
  neural: boolean;
}

export class CrossEncoderReranker {
  private model: any = null;
  private tokenizer: any = null;
  private initPromise: Promise<void> | null = null;
  public readonly modelName = "Xenova/bge-reranker-base";

  async init(): Promise<void> {
    if (this.model && this.tokenizer) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import(
          "@xenova/transformers"
        );
        env.allowRemoteModels = true;
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
        this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelName, {
          quantized: true,
        });
      } catch (e) {
        this.initPromise = null;
        throw e;
      }
    })();

    return this.initPromise;
  }

  isReady(): boolean {
    return this.model !== null && this.tokenizer !== null;
  }

  /**
   * Reranks candidate turns.
   * If model is unavailable or fails, returns original candidates unchanged (safe degradation).
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = 15,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const pool = candidates.slice(0, topK);

    try {
      await this.init();
      // One pass per pair, deliberately: a batched pass pads every pair to the
      // longest and measured slower on CPU ONNX (15 pairs: 2.7s batched vs 1.7s).
      const results: RerankResult[] = [];
      for (const cand of pool) {
        const inputs = this.tokenizer(query, {
          text_pair: cand.content.slice(0, 1000),
          padding: true,
          truncation: true,
        });
        const { logits } = await this.model(inputs);
        const rawLogit = Number(logits.data[0]);
        // Sigmoid mapping for smooth [0, 1] probability
        const rerankScore = 1 / (1 + Math.exp(-rawLogit));
        // Combined blend: 0.60 * rerankScore + 0.40 * originalScore
        const combinedScore = 0.6 * rerankScore + 0.4 * cand.score;
        results.push({ id: cand.id, originalScore: cand.score, rerankScore, combinedScore, neural: true });
      }

      results.sort((a, b) => b.combinedScore - a.combinedScore);
      return results;
    } catch {
      // Fallback to original order
      return pool.map((c) => ({
        id: c.id,
        originalScore: c.score,
        rerankScore: c.score,
        combinedScore: c.score,
        neural: false,
      }));
    }
  }
}

let sharedReranker: CrossEncoderReranker | null = null;

export function getSharedReranker(): CrossEncoderReranker {
  if (!sharedReranker) {
    sharedReranker = new CrossEncoderReranker();
  }
  return sharedReranker;
}
