/** In-memory invoice store. Production swaps this for the Postgres adapter. */
export function createStore(invoices = []) {
  return { invoices: invoices.map((inv) => ({ ...inv })) };
}
