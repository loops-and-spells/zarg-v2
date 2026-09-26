import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { ModelError, openRouterWire, plain, type Provider } from "@zarg/model"

const post = (url: string, body: unknown, f: typeof fetch) =>
  Effect.tryPromise({
    try: (signal) => f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }),
    catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
  }).pipe(
    Effect.flatMap((res) =>
      Effect.flatMap(
        Effect.promise(() => res.text().catch(() => "")),
        (text) => {
          if (!res.ok) return Effect.fail(new ModelError({ kind: "status", status: res.status, message: `${res.status} ${text}`.trim() }))
          return Effect.try({
            try: () => (text === "" ? {} : JSON.parse(text)) as unknown,
            catch: () => new ModelError({ kind: "stream", message: `bad JSON from ${url}` }),
          })
        },
      ),
    ),
  )

/**
 * zarg-router: local models behind an OpenRouter-compatible API, no key.
 *   [providers.zarg-router]
 *   base_url = "${ZARG_ROUTER_URL}"
 */
export const makeZargRouter = (f: typeof fetch = fetch): Provider => ({
  name: "zarg-router",
  envKeys: ["ZARG_ROUTER_URL"],
  schemaFile: fileURLToPath(new URL("../.env.schema", import.meta.url)),
  connect: (settings) =>
    Effect.gen(function* () {
      const baseUrl = (yield* plain("zarg-router", settings, "base_url")).replace(/\/+$/, "")
      const origin = baseUrl.replace(/\/api\/v1$/, "")
      const wire = openRouterWire({ baseUrl, fetch: f })
      return {
        ...wire,
        warm: (model) => Effect.asVoid(post(`${origin}/admin/warm`, { model }, f)),
        systemone: (body) => post(`${baseUrl}/systemone`, body, f),
      }
    }),
})

export const zargRouter = makeZargRouter()
