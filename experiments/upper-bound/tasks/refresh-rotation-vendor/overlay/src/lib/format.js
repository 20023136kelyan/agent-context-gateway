export const formatMoney = (cents, currency = "EUR", locale = "en") =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);

export const formatDate = (iso, locale = "en") => new Date(iso).toLocaleDateString(locale);
