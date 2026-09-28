/** Delay for attempt n (0-based): exponential with full jitter. Used by retry.js. */
export const fullJitter = (n, base = 100, max = 2000) => Math.random() * Math.min(max, base * 2 ** n);
