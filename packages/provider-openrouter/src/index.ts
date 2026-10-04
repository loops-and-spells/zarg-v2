import { fileURLToPath } from "node:url"
import { Effect, Redacted } from "effect"
import { ModelError, openRouterWire, plain, type Provider, secret } from "@zarg/model"

/**
 * OpenRouter. Config:
 *   [providers.openrouter]
 *   base_url = "${OPENROUTER_URL}"
 *   api_key  = "${OPENROUTER_API_KEY}"
 */
export const makeOpenrouter = (f: typeof fetch = fetch): Provider => ({
  name: "openrouter",
  envKeys: ["OPENROUTER_API_KEY", "OPENROUTER_URL"],
  schemaFile: fileURLToPath(new URL("../.env.schema", import.meta.url)),
  // The key may be unset (\`:-\`): a missing value must never stop the config from loading.
  settings: { base_url: "${OPENROUTER_URL}", api_key: "${OPENROUTER_API_KEY:-}" },
  connect: (settings) =>
    Effect.gen(function* () {
      const baseUrl = (yield* plain("openrouter", settings, "base_url")).replace(/\/+$/, "")
      const apiKey = yield* secret("openrouter", settings, "api_key")
      const wire = openRouterWire({ baseUrl, fetch: f, ...(apiKey ? { apiKey } : {}) })
      // GET /models answers without a key: a key is checked against GET /key, which refuses a wrong one.
      const verify = apiKey === undefined
        ? wire.verify
        : Effect.tryPromise({
            try: () => f(`${baseUrl}/key`, { headers: { authorization: `Bearer ${Redacted.value(apiKey)}` } }),
            catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
          }).pipe(Effect.flatMap((res) => (res.ok ? Effect.void : Effect.fail(new ModelError({ kind: "status", status: res.status, message: `${res.status} the key was refused` })))))
      return { ...wire, verify }
    }),
})

export const openrouter: Provider = makeOpenrouter()
