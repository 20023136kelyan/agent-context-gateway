/** Formats integer cents for display, e.g. 123450 EUR -> "€1,234.50". */
export function formatMoney(cents, currency = "EUR") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Parses a user-entered amount such as "1234.5" into integer cents. */
export function toCents(text) {
  const n = Number(String(text).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`not an amount: ${text}`);
  return Math.round(n * 100);
}
