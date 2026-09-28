const catalogs = { en: {}, fr: {}, de: {} };
export const t = (locale, key) => catalogs[locale]?.[key] ?? key;
