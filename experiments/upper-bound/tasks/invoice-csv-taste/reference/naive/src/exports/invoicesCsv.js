import { formatMoney } from "../lib/money.js";
import { formatDate } from "../lib/dates.js";

const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** CSV export of invoices for finance. */
export default function exportInvoicesCsv(invoices) {
  return [["Invoice ID", "Customer", "Date", "Total"], ...invoices.map((inv) => [inv.id, inv.customer.name, formatDate(inv.issuedAt), formatMoney(inv.totalCents, inv.currency)])]
    .map((r) => r.map(quote).join(","))
    .join("\n");
}
