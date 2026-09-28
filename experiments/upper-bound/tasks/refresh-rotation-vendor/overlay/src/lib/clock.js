export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
