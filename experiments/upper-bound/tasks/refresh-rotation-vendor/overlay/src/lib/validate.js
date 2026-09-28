export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
export const isSlug = (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
