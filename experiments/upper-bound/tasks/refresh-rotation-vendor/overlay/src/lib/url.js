export const join = (base, path) => base.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
