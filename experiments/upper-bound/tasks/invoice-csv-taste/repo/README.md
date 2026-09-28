# Ledgerline

Invoicing backend. Invoices live in a store (`src/store.js`), are listed by
`src/invoices.js` and served by the router in `src/http/routes.js`.

- `src/exports/` machine-readable exports (JSON today)
- `src/reports/` human-readable reports (monthly summary)
- `src/lib/` money and date helpers

Run the tests with `npm test`.
