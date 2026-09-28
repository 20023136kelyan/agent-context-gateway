/** Minimal leveled logger. The browser build routes it to the console; tests silence it. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(scope, { level = "info", sink = console } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields) => {
    if (LEVELS[lvl] < min) return;
    sink[lvl === "debug" ? "log" : lvl]?.(`[${scope}] ${msg}`, fields ?? "");
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
