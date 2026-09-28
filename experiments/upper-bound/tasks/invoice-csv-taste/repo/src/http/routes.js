import exportInvoicesJson from "../exports/invoicesJson.js";
import { listInvoices } from "../invoices.js";

/** Minimal router: handle({ method, path }) -> { status, headers, body }. */
export function createRouter(store) {
  const routes = {
    "GET /exports/invoices.json": () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: exportInvoicesJson(listInvoices(store)),
    }),
  };
  return {
    handle({ method, path }) {
      const route = routes[`${method} ${path}`];
      return route ? route() : { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
    },
  };
}
