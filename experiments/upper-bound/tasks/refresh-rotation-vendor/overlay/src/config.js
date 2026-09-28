/** Environment configuration. Values come from the build (import.meta.env) or process.env in tests. */
const DEFAULTS = {
  production: { authBaseUrl: "https://auth.keyline.example/tenants/tokenbox", apiBaseUrl: "https://api.tokenbox.example/v2", flagsUrl: "https://flags.tokenbox.example" },
  staging: { authBaseUrl: "https://auth.sandbox.keyline.example/tenants/tokenbox-stg", apiBaseUrl: "https://api.staging.tokenbox.example/v2", flagsUrl: "https://flags.staging.tokenbox.example" },
  development: { authBaseUrl: "http://localhost:4010", apiBaseUrl: "http://localhost:4000/v2", flagsUrl: "http://localhost:4020" },
};

export function loadConfig(env = globalThis.process?.env ?? {}) {
  const name = env.TOKENBOX_ENV ?? "development";
  const base = DEFAULTS[name];
  if (!base) throw new Error(`unknown TOKENBOX_ENV "${name}"`);
  return {
    env: name,
    authBaseUrl: env.TOKENBOX_AUTH_URL ?? base.authBaseUrl,
    apiBaseUrl: env.TOKENBOX_API_URL ?? base.apiBaseUrl,
    flagsUrl: env.TOKENBOX_FLAGS_URL ?? base.flagsUrl,
    clientId: env.TOKENBOX_CLIENT_ID ?? "tokenbox-web",
    requestTimeoutMs: Number(env.TOKENBOX_TIMEOUT_MS ?? 10000),
  };
}
