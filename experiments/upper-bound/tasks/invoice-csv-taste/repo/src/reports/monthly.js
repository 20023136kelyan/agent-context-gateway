import { formatMoney } from "../lib/money.js";
import { formatDate } from "../lib/dates.js";
import { invoicesInMonth } from "../invoices.js";

const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** Monthly invoice summary as CSV, attached to the month-end email. */
export default function monthlyReport(store, year, month) {
  const rows = invoicesInMonth(store, year, month).map((inv) => [inv.id, inv.customer.name, formatDate(inv.issuedAt), formatMoney(inv.totalCents, inv.currency)]);
  const total = rows.length ? invoicesInMonth(store, year, month).reduce((s, inv) => s + inv.totalCents, 0) : 0;
  return [["Invoice ID", "Customer", "Date", "Total"], ...rows, ["", "", "Total", formatMoney(total)]]
    .map((r) => r.map(quote).join(","))
    .join("\n");
}
