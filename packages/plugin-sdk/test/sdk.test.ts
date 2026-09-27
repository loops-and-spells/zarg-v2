import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { buildPlugin, manifestOf, testPlugin } from "../src/tools"
import { definePlugin } from "../src"
import good from "./fixtures/good"

const fixture = (n: string) => join(import.meta.dir, "fixtures", n, "index.ts")

describe("manifest", () => {
  test("carries name, service, archetype, scopes and each method's JSON Schema with descriptions", () => {
    const m = manifestOf(good)
    expect(m).toMatchObject({ name: "zt-good", service: "ZtGood", archetype: "provider", scopes: { net: ["example.test"], secrets: ["API_KEY"] }, optional: {} })
    expect(m.methods.hello).toMatchObject({ doc: "Say hello.", agents: true, stream: false })
    expect(JSON.stringify(m.methods.hello!.params)).toContain("Whom to greet.")
    expect(m.methods.keyLength!.agents).toBe(false)
  })
})

describe("build", () => {
  test("a plugin bundles into one script that has no Node built-ins", async () => {
    const r = await buildPlugin(fixture("good"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundle).not.toMatch(/require\(["'](node:)?(fs|child_process|net)["']\)/)
    expect(r.manifest.name).toBe("zt-good")
  })
  test("importing node:fs is refused with the scope to ask for", async () => {
    const r = await buildPlugin(fixture("node-import"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("plugins cannot import node:fs; request an fs scope instead")
  })
  test("using Bun is refused", async () => {
    const r = await buildPlugin(fixture("bun-global"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("plugins cannot use Bun")
  })
})

describe("running a plugin", () => {
  test("methods run in the locked runtime with only the powers given", async () => {
    const r = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const p = yield* testPlugin(fixture("good"), {
        "secrets.get": async (a) => ((a as { name: string }).name === "API_KEY" ? "zt-12345" : Promise.reject(Object.assign(new Error("no"), { tag: "NotGranted" }))),
        fetch: async (a) => ({ status: (a as { url: string }).url === "https://example.test/ping" ? 204 : 0, headers: {}, text: "" }),
        "config.get": async () => ({}),
      })
      return [yield* p.call("hello", { who: "you" }), yield* p.call("keyLength", {}), yield* p.call("ping", {})]
    })))
    expect(r).toEqual(["hello you", 8, 204])
  })
  test("bad params are refused by the plugin's own Schema", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const p = yield* testPlugin(fixture("good"), { "config.get": async () => ({}) })
      return yield* Effect.flip(p.call("hello", { who: 1 }))
    })))
    expect(e.message).toContain("who")
  })
})

describe("names", () => {
  test("a plugin name that could collide with another's secret namespace is refused", () => {
    const def = { service: "ZtX", archetype: "provider" as const, config: Schema.Struct({}), scopes: {}, methods: {}, make: Effect.succeed({}) }
    for (const name of ["zt--x", "zt-", "Zt"]) expect(() => definePlugin({ ...def, name })).toThrow()
    expect(definePlugin({ ...def, name: "zt-x" }).name).toBe("zt-x")
  })
})

