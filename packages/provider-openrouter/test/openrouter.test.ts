import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Effect, Redacted } from "effect"
import { openrouter } from "../src"

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
})
