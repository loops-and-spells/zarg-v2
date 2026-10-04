import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Effect, Redacted } from "effect"
import { makeOpenrouter, openrouter } from "../src"

describe("openrouter provider", () => {
  test("declares its env keys and ships its schema fragment", () => {
    expect(openrouter.envKeys).toEqual(["OPENROUTER_API_KEY", "OPENROUTER_URL"])
    expect(existsSync(openrouter.schemaFile)).toBe(true)
  })

  test("needs base_url; refuses an api_key that did not come from a sensitive variable", async () => {
    const missing = await Effect.runPromise(Effect.flip(openrouter.connect({})))
    expect(missing.key).toBe("providers.openrouter.base_url")
    const plainKey = await Effect.runPromise(Effect.flip(openrouter.connect({ base_url: "http://x", api_key: "sk-or-plain" })))
    expect(plainKey.message).toContain("must come from a @sensitive variable")
  })

  test("connects with a redacted key", async () => {
    const client = await Effect.runPromise(openrouter.connect({ base_url: "http://x", api_key: Redacted.make("sk-or-1") }))
    expect(typeof client.stream).toBe("function")
    expect(client.warm).toBeUndefined()
  })
  test("an empty api_key (unset variable with an empty default) means no key, not a config error", async () => {
    const client = await Effect.runPromise(openrouter.connect({ base_url: "http://x", api_key: "" }))
    expect(typeof client.stream).toBe("function")
  })
})

describe("verify checks the key, not only the public model list", () => {
  // OpenRouter answers GET /models without a key; GET /key needs a valid one.
  const fake = (good: string): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith("/models")) return Response.json({ data: [{ id: "m" }] })
      if (u.endsWith("/key")) return new Headers(init?.headers).get("authorization") === `Bearer ${good}` ? Response.json({ data: {} }) : new Response("User not found", { status: 401 })
      return new Response("", { status: 404 })
    }) as never
  test("a wrong key fails verify with 401; the right one passes; with no key, verify is the model list", async () => {
    const p = makeOpenrouter(fake("sk-or-good"))
    const wrong = await Effect.runPromise(p.connect({ base_url: "http://x", api_key: Redacted.make("sk-or-wrong") }))
    expect((await Effect.runPromise(Effect.flip(wrong.verify))).status).toBe(401)
    const right = await Effect.runPromise(p.connect({ base_url: "http://x", api_key: Redacted.make("sk-or-good") }))
    await Effect.runPromise(right.verify)
    const none = await Effect.runPromise(p.connect({ base_url: "http://x", api_key: "" }))
    await Effect.runPromise(none.verify)
  })
})
