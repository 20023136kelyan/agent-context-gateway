import { toISODate } from "../lib/dates.js";

const DELIMITER = ";";
const quote = (cell) => {
  const s = String(cell);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of invoices for finance. */
export function exportInvoicesCsv(invoices) {
  const rows = [
    ["invoice_id", "customer", "issued_on", "total_cents"],
    ...invoices.map((inv) => [inv.id, inv.customer.name, toISODate(inv.issuedAt), String(inv.totalCents)]),
  ];
  return rows.map((r) => r.map(quote).join(DELIMITER)).join("\n") + "\n";
}
