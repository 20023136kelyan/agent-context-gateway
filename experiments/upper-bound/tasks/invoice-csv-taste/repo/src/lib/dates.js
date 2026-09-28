/** Formats a timestamp for display in the user's locale, e.g. "3/31/2026". */
export function formatDate(iso, locale = "en-US") {
  return new Date(iso).toLocaleDateString(locale);
}

/** Calendar date of a timestamp in UTC, e.g. "2026-03-31". */
export function toISODate(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}
