import { newPaymentKey } from "../lib/ids.js";

/**
 * Plans, invoices and payments. Payments go through Paylane via our API;
 * every charge carries an Idempotency-Key so a retried request can never
 * charge twice (docs/vendor/paylane/api.md, "Idempotent requests").
 */
export class BillingApi {
  constructor(api) {
    this.api = api;
  }

  plans() {
    return this.api.get("/billing/plans");
  }

  invoices() {
    return this.api.get("/billing/invoices");
  }

  /** Upgrades the plan and charges the difference. One key per upgrade, reused on retry. */
  upgrade(planId, { key = newPaymentKey("upg") } = {}) {
    return this.api.post("/billing/upgrade", { planId }, { idempotent: true, headers: { "Idempotency-Key": key } });
  }

  cancel(reason) {
    return this.api.post("/billing/cancel", { reason });
  }
}
