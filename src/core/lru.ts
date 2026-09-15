/** Least-recently-used cache bounded by entry count and by a caller-defined weight (e.g. content chars). */
export class LruCache<K, V> {
  private entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    // Re-insert: Map iteration order doubles as recency order.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    const old = this.entries.get(key);
    if (old) {
      this.totalWeight -= old.weight;
      this.entries.delete(key);
    }
    const weight = this.weigh(value);
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    // Evict oldest first; the entry just set always stays, even if it alone is over budget.
    for (const [k, e] of this.entries) {
      if (this.entries.size <= 1) break;
      if (this.entries.size <= this.maxEntries && this.totalWeight <= this.maxWeight) break;
      this.entries.delete(k);
      this.totalWeight -= e.weight;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }
}
