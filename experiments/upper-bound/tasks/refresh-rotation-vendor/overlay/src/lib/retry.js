import { TransportError } from "../transport.js";

/**
 * Retries an async operation on transient failures with exponential backoff
 * and jitter. See docs/adr/0003-retry-policy.md.
 *
 *   await withRetry(() => transport.post("/things", body), { retries: 3 })
 *
 * A failure is transient when no response arrived (TransportError), or the
 * response is a 5xx or 429. Everything else is returned or thrown as is.
 */
export function isTransient(errOrRes) {
  if (errOrRes instanceof TransportError) return true;
  const status = errOrRes?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

export async function withRetry(op, { retries = 3, baseDelayMs = 100, maxDelayMs = 2000, shouldRetry = isTransient, sleep = defaultSleep, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    let outcome;
    try {
      outcome = await op(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      onRetry?.(err, attempt + 1);
      await sleep(backoff(attempt, baseDelayMs, maxDelayMs));
      continue;
    }
    if (attempt < retries && shouldRetry(outcome)) {
      onRetry?.(outcome, attempt + 1);
      await sleep(backoff(attempt, baseDelayMs, maxDelayMs));
      continue;
    }
    return outcome;
  }
}

function backoff(attempt, base, max) {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
