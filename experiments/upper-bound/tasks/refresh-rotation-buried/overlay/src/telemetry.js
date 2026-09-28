/** Client-side counters, flushed in batches. No personal data. */
export class Telemetry {
  constructor({ send, flushEvery = 50 }) {
    this.send = send;
    this.flushEvery = flushEvery;
    this.buffer = [];
  }

  count(name, tags = {}) {
    this.buffer.push({ name, tags, at: Date.now() });
    if (this.buffer.length >= this.flushEvery) return this.flush();
  }

  async flush() {
    const batch = this.buffer.splice(0);
    if (!batch.length) return;
    try {
      await this.send(batch);
    } catch {
      this.buffer.unshift(...batch.slice(-this.flushEvery));
    }
  }
}
