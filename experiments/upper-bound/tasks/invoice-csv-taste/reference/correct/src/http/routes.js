import exportInvoicesJson from "../exports/invoicesJson.js";
import { exportInvoicesCsv } from "../exports/invoicesCsv.js";
import { listInvoices } from "../invoices.js";

/** Minimal router: handle({ method, path }) -> { status, headers, body }. */
export function createRouter(store) {
  const routes = {
    "GET /exports/invoices.json": () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: exportInvoicesJson(listInvoices(store)),
    }),
    "GET /exports/invoices.csv": () => ({
      status: 200,
      headers: { "content-type": "text/csv; charset=utf-8" },
      body: exportInvoicesCsv(listInvoices(store)),
    }),
  };
  return {
    handle({ method, path }) {
      const route = routes[`${method} ${path}`];
      return route ? route() : { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
    },
  };
}
