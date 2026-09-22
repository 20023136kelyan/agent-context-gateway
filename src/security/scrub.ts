/**
 * Secret scrubbing for everything that leaves the machine.
 *
 * Native history is never modified and the local index keeps it verbatim — an
 * exact-match search for a key you pasted still works through BM25. This runs
 * only on text bound for a third party: Voyage (embeddings, rerank) and Jev
 * (rerank, judge, router), and in future the paid key proxy.
 *
 * Why it is not optional: scrubbing 65K passages of real agent history for the
 * training experiment (experiments/training/build-dapt.py) found 736
 * passwords/tokens, 3445 IPs, 1192 emails and 2 bearer tokens. Agent histories
 * are full of pasted .env files, curl commands and stack traces.
 *
 * Callers must scrub BEFORE truncating or chunking. A private key cut in half
 * has no END marker, and its middle chunk is plain base64 no pattern can
 * recognise — only the whole text shows it is a key.
 *
 * Mode (GATEWAY_SCRUB): `all` (default) = secrets + PII (emails, non-loopback
 * IPv4) · `secrets` = keep emails and IPs · `off` = send verbatim (measuring
 * scrubbing's effect on retrieval; not for real histories).
 */

export type ScrubMode = "all" | "secrets" | "off";

export function scrubMode(): ScrubMode {
  const raw = process.env.GATEWAY_SCRUB;
  return raw === "secrets" || raw === "off" ? raw : "all";
}

interface Rule {
  kind: string;
  pii?: boolean;
  rx: RegExp;
  /** Default replaces the whole match with the placeholder. */
  replace?: (match: string, ...groups: string[]) => string;
}

const tag = (kind: string) => `<REDACTED:${kind}>`;

/** Values that name a secret rather than contain one. */
const REFERENCE = /^(process\.env|os\.environ|env\.|self\.|this\.|\$\{?[A-Z_])/;

/** Order matters: whole blocks and specific vendor formats before the generic rules. */
const RULES: Rule[] = [
  // Private keys: complete block, then an unterminated BEGIN (text cut after
  // it), then an orphaned END (text cut before its BEGIN).
  { kind: "private_key", rx: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "private_key", rx: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g },
  { kind: "private_key", rx: /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "jwt", rx: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Anthropic before OpenAI: sk-ant-… also fits the OpenAI shape.
  { kind: "anthropic_key", rx: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai_key", rx: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", rx: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github_token", rx: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "gitlab_token", rx: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack_token", rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack_webhook", rx: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { kind: "aws_key", rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "huggingface_token", rx: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "npm_token", rx: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Voyage's documented key prefix (the gateway's own embedding vendor).
  { kind: "voyage_key", rx: /\bpa-[A-Za-z0-9_-]{30,}/g },
  // Credentials inside URLs keep scheme, user and host: only the password goes.
  {
    kind: "url_credential",
    rx: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${tag("url_credential")}${at}`,
  },
  // Auth headers keep their scheme word so the passage still reads as a header.
  {
    kind: "bearer",
    rx: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
    replace: (_m, pre) => `${pre}${tag("bearer")}`,
  },
  {
    kind: "basic_auth",
    rx: /\b(basic\s+)[A-Za-z0-9+/]{16,}={0,2}/gi,
    replace: (_m, pre) => `${pre}${tag("basic_auth")}`,
  },
  // Named credentials: `password = "…"`, `"api_key": "…"`, `DB_PASSWORD=…`.
  // Quoted values are redacted from 8 chars. Unquoted ones need 12+ chars with
  // both a letter and a digit, so `token: string` and `password = hash(pw)`
  // survive while `SECRET=a8f3…` does not.
  {
    kind: "credential",
    rx: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'])([^"'\s]{8,})\2/gi,
    replace: (m, pre, q, val) => (REFERENCE.test(val) ? m : `${pre}${q}${tag("credential")}${q}`),
  },
  {
    kind: "credential",
    rx: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*\s*[:=]\s*)([A-Za-z0-9_\-+/=.~]{12,})/gi,
    replace: (m, pre, val) =>
      REFERENCE.test(val) || !/\d/.test(val) || !/[A-Za-z]/.test(val) ? m : `${pre}${tag("credential")}`,
  },
  { kind: "email", pii: true, rx: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Loopback and the wildcard address are not private: every local-server
  // conversation mentions them, and redacting them would only cost retrieval.
  {
    kind: "ipv4",
    pii: true,
    rx: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: (m) => {
      const octets = m.split(".").map(Number);
      if (octets.some((o) => o > 255)) return m; // not an address (e.g. a 4-part version)
      if (octets[0] === 127 || m === "0.0.0.0") return m;
      return tag("ipv4");
    },
  },
];

/**
 * Process-wide redaction counts by kind — the shape of what was found, never
 * the content. Mirrors the vendor meters (reset per sweep cell).
 */
export const scrubMeter = {
  counts: {} as Record<string, number>,
  reset() {
    this.counts = {};
  },
  snapshot(): Record<string, number> {
    return { ...this.counts };
  },
};

/** Redact secrets (and, in `all` mode, PII) from one string. Idempotent. */
export function scrubText(text: string, mode: ScrubMode = scrubMode()): string {
  if (mode === "off" || !text) return text;
  let out = text;
  for (const rule of RULES) {
    if (rule.pii && mode !== "all") continue;
    rule.rx.lastIndex = 0;
    out = out.replace(rule.rx, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const next = rule.replace ? rule.replace(match, ...groups) : tag(rule.kind);
      if (next !== match) scrubMeter.counts[rule.kind] = (scrubMeter.counts[rule.kind] ?? 0) + 1;
      return next;
    });
  }
  return out;
}

/**
 * Scrub every string inside a JSON-shaped value (Jev `state`). Keys are field
 * names chosen by our code, so they pass through; values are copied, never
 * mutated in place.
 */
export function scrubDeep<T>(value: T, mode: ScrubMode = scrubMode()): T {
  if (mode === "off") return value;
  if (typeof value === "string") return scrubText(value, mode) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, mode)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, mode);
    return out as T;
  }
  return value;
}
