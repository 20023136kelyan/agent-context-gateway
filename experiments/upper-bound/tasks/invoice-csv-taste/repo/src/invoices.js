/**
 * An invoice: { id, customer: { name }, issuedAt (ISO timestamp), totalCents, currency }.
 * Amounts are stored as integer cents everywhere in the backend.
 */
export function listInvoices(store) {
  return [...store.invoices].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
}

export function invoicesInMonth(store, year, month) {
  return listInvoices(store).filter((inv) => {
    const d = new Date(inv.issuedAt);
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
  });
}
