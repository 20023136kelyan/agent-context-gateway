/**
 * Grader for the invoice-csv-taste task. Copied into <workspace>/.grader/ after
 * the agent finishes, then run from the workspace root. Prints one JSON line.
 *
 *   visible     the repo's own tests pass
 *   goal        exportInvoicesCsv works (one row per invoice, the four columns,
 *               cells quoted correctly) and GET /exports/invoices.csv serves it
 *   delimiter   the team's style: ';' as the delimiter
 *   headers     snake_case headers
 *   dates       dates as YYYY-MM-DD in UTC
 *   amounts     amounts as integer cents
 *   namedExport the new module has no default export
 *
 * None of the style rules can be worked out from the repo, whose older code
 * does the opposite; they come from past review corrections.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Tokyo is ahead of UTC, so a locale date of a late-evening UTC timestamp is the next day.
process.env.TZ = "Asia/Tokyo";
const root = process.cwd();

const invoices = [
  { id: "INV-0101", customer: { name: "Atelier Morel" }, issuedAt: "2026-03-31T22:30:00Z", totalCents: 123450, currency: "EUR" },
  { id: "INV-0102", customer: { name: "Dupont, Martin & Fils" }, issuedAt: "2026-04-02T08:05:00Z", totalCents: 9900, currency: "EUR" },
  { id: "INV-0103", customer: { name: 'Café "Le Zinc"' }, issuedAt: "2026-04-10T12:00:00Z", totalCents: 250000, currency: "EUR" },
];

function parseCsv(text, delim) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".js") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

async function main() {
  const out = { visible: false, goal: false, delimiter: false, headers: false, dates: false, amounts: false, namedExport: false, details: {} };
  const tests = spawnSync(process.execPath, ["--test", "test/**/*.test.js"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  out.visible = tests.status === 0;
  if (!out.visible) out.details.visible = (tests.stdout + tests.stderr).split("\n").filter((l) => /not ok|Error|fail/i.test(l)).slice(0, 8).join("\n");

  let mod;
  try { mod = await import(pathToFileURL(resolve(root, "src/index.js")).href); } catch (err) {
    out.details.load = `could not import src/index.js: ${err?.message ?? err}`;
    return out;
  }
  if (typeof mod.exportInvoicesCsv !== "function") {
    out.details.goal = "src/index.js does not export exportInvoicesCsv";
    return out;
  }
  let csv;
  try { csv = String(mod.exportInvoicesCsv(invoices)); } catch (err) {
    out.details.goal = `exportInvoicesCsv threw: ${err?.message ?? err}`;
    return out;
  }
  const headerLine = csv.split(/\r?\n/)[0];
  const delim = [";", ",", "\t"].find((d) => headerLine.includes(d)) ?? ",";
  const rows = parseCsv(csv, delim);
  const [header, ...data] = rows;

  const problems = [];
  if (header.length !== 4) problems.push(`header has ${header.length} cells, expected 4 (id, customer, date, total)`);
  if (data.length !== invoices.length) problems.push(`${data.length} data rows for ${invoices.length} invoices`);
  invoices.forEach((inv, i) => {
    const r = data[i] ?? [];
    if (r.length !== 4) problems.push(`row ${i + 1} has ${r.length} cells`);
    else {
      if (r[0] !== inv.id) problems.push(`row ${i + 1} id is ${JSON.stringify(r[0])}`);
      if (r[1] !== inv.customer.name) problems.push(`row ${i + 1} customer is ${JSON.stringify(r[1])}, expected ${JSON.stringify(inv.customer.name)}`);
    }
  });
  try {
    const store = mod.createStore(invoices);
    const res = mod.createRouter(store).handle({ method: "GET", path: "/exports/invoices.csv" });
    if (res?.status !== 200) problems.push(`GET /exports/invoices.csv returned ${res?.status}`);
    else if (res.body !== mod.exportInvoicesCsv(mod.listInvoices(store))) problems.push("GET /exports/invoices.csv does not serve the export");
    else if (!/csv/i.test(JSON.stringify(res.headers ?? {}))) problems.push("GET /exports/invoices.csv has no CSV content type");
  } catch (err) {
    problems.push(`GET /exports/invoices.csv threw: ${err?.message ?? err}`);
  }
  out.goal = problems.length === 0;
  if (!out.goal) out.details.goal = problems.join("; ");

  out.delimiter = delim === ";";
  if (!out.delimiter) out.details.delimiter = `delimiter is ${JSON.stringify(delim)}; finance opens these in Excel with a French locale, the team uses ';'`;
  out.headers = header.length > 0 && header.every((h) => /^[a-z][a-z0-9_]*$/.test(h));
  if (!out.headers) out.details.headers = `headers are ${JSON.stringify(header)}; the team uses snake_case`;
  const dateCells = data.map((r) => r[2]);
  const wantDates = invoices.map((inv) => inv.issuedAt.slice(0, 10));
  out.dates = JSON.stringify(dateCells) === JSON.stringify(wantDates);
  if (!out.dates) out.details.dates = `dates are ${JSON.stringify(dateCells)}; the team uses YYYY-MM-DD in UTC (${wantDates.join(", ")})`;
  const amountCells = data.map((r) => r[3]);
  const wantAmounts = invoices.map((inv) => String(inv.totalCents));
  out.amounts = JSON.stringify(amountCells) === JSON.stringify(wantAmounts);
  if (!out.amounts) out.details.amounts = `amounts are ${JSON.stringify(amountCells)}; the team exports integer cents (${wantAmounts.join(", ")})`;

  const defining = sourceFiles(join(root, "src")).filter((p) => /(function|const|let)\s+exportInvoicesCsv\b/.test(readFileSync(p, "utf8")));
  const withDefault = defining.filter((p) => /export\s+default\b/.test(readFileSync(p, "utf8")));
  out.namedExport = defining.length > 0 && withDefault.length === 0;
  if (!out.namedExport) out.details.namedExport = defining.length ? `${withDefault.map((p) => p.slice(root.length + 1)).join(", ")} uses a default export; new modules use named exports only` : "could not find where exportInvoicesCsv is defined";
  return out;
}

const STYLE = ["delimiter", "headers", "dates", "amounts", "namedExport"];
main().then((out) => {
  out.styleFollowed = STYLE.filter((k) => out[k]).length;
  out.pass = out.visible && out.goal && STYLE.every((k) => out[k]);
  // Working code the reviewer would still send back: the case the notes exist for.
  out.trapHit = out.goal && !out.pass;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
});
