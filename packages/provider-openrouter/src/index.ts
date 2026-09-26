import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { openRouterWire, plain, type Provider, secret } from "@zarg/model"

/**
 * OpenRouter. Config:
 *   [providers.openrouter]
 *   base_url = "${OPENROUTER_URL}"
 *   api_key  = "${OPENROUTER_API_KEY}"
 */
export const openrouter: Provider = {
  name: "openrouter",
  envKeys: ["OPENROUTER_API_KEY", "OPENROUTER_URL"],
  schemaFile: fileURLToPath(new URL("../.env.schema", import.meta.url)),
  connect: (settings) =>
    Effect.gen(function* () {
      const baseUrl = yield* plain("openrouter", settings, "base_url")
      const apiKey = yield* secret("openrouter", settings, "api_key")
      return openRouterWire({ baseUrl, ...(apiKey ? { apiKey } : {}) })
    }),
}
