import { formatMoney } from "../lib/money.js";

/** JSON export of invoices for the partner portal. */
export default function exportInvoicesJson(invoices) {
  return JSON.stringify(
    invoices.map((inv) => ({
      invoiceId: inv.id,
      customerName: inv.customer.name,
      issuedAt: inv.issuedAt,
      total: formatMoney(inv.totalCents, inv.currency),
    })),
    null,
    2,
  );
}
