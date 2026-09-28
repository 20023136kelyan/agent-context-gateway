/**
 * HTTP transport.
 *
 * post(path, body, options) resolves to { status, body } for any HTTP response,
 * and rejects with a TransportError when no response arrives (timeout,
 * connection reset, DNS failure).
 *
 * options:
 *   headers         extra request headers
 *   idempotencyKey  sent as the Idempotency-Key header
 *   timeoutMs       request timeout (default 10000)
 */
export class TransportError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "TransportError";
    this.code = code; // "ETIMEDOUT" | "ECONNRESET" | "ENOTFOUND" | ...
  }
}

export class HttpTransport {
  constructor(baseUrl, fetchImpl = globalThis.fetch) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  async post(path, body, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } catch (err) {
      if (err?.name === "AbortError") throw new TransportError("ETIMEDOUT", `POST ${path} timed out`);
      throw new TransportError(err?.cause?.code ?? "ECONNRESET", `POST ${path} failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
