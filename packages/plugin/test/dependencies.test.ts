import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fixturePlugin, hostWith } from "./fixtures"

const contract = (name: string, method = "hello") =>
  `const ${name[0]!.toUpperCase()}C = pluginContract("${name}", { ${method}: { params: Schema.Struct({}), success: Schema.String } })`
const base = (name: string, opts: { deps?: string; spin?: boolean } = {}) => `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
${contract(name)}
${opts.deps !== undefined ? contract(opts.deps) : ""}
export default definePlugin({ name: "${name}", service: "S${name}", archetype: "service", config: Schema.Struct({}), scopes: {}, implements: ${name[0]!.toUpperCase()}C,
  ${opts.deps !== undefined ? `pluginDependencies: [${opts.deps[0]!.toUpperCase()}C],` : ""}
  methods: {
    hello: { doc: "hi", params: Schema.Struct({}), success: Schema.String },
    spin: { doc: "spin", params: Schema.Struct({}), success: Schema.String, deadlineMs: 50 },
  },
  make: Effect.succeed({ hello: () => Effect.succeed("hi from ${name}"), spin: () => Effect.sync(() => { for (;;) {} }) }) })`
const user = (on: string, method = "hello") => `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
${contract(on, method)}
export default definePlugin({ name: "user", service: "User", archetype: "service", config: Schema.Struct({}), scopes: {}, pluginDependencies: [${on[0]!.toUpperCase()}C],
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String, agents: true } },
  make: Effect.gen(function* () { const b = yield* ${on[0]!.toUpperCase()}C; return { go: () => b.${method}({}) } }) })`

describe("plugin dependencies", () => {
  test("a dependent calls its dependency through the contract", async () => {
    const out = await Effect.runPromise(hostWith([await fixturePlugin(user("base")), await fixturePlugin(base("base"))], (h) => h.invoke("user", "go", {})))
    expect(out).toBe("hi from base")
  })

  test("a missing dependency, a dependency built against another contract, and a cycle keep a plugin from loading, with a reason", async () => {
    const missing = await Effect.runPromise(hostWith([await fixturePlugin(user("nobody"))], (h) => h.agenda()))
    expect(missing.map((i) => i.title)).toContain("Plugin user needs nobody, which is not loaded")
    const mismatch = await Effect.runPromise(hostWith([await fixturePlugin(base("base")), await fixturePlugin(user("base", "goodbye"))], (h) => h.agenda()))
    expect(mismatch.map((i) => i.detail).join("\n")).toContain("built against a different base")
    const cycle = await Effect.runPromise(hostWith([await fixturePlugin(base("aa", { deps: "bb" })), await fixturePlugin(base("bb", { deps: "aa" }))], (h) => h.agenda()))
    expect(cycle.map((i) => i.detail).join("\n")).toContain("cycle")
  })

  test("a dependency disabled at runtime disables its dependents", async () => {
    const items = await Effect.runPromise(
      hostWith([await fixturePlugin(base("base")), await fixturePlugin(user("base"))], (h) =>
        Effect.gen(function* () {
          for (let i = 0; i < 3; i++) yield* Effect.exit(h.invoke("base", "spin", {}))
          const after = yield* Effect.exit(h.invoke("user", "go", {}))
          return { agenda: yield* h.agenda(), after }
        }),
      ),
    )
    expect(items.agenda.map((i) => i.title)).toContain("Plugin user was disabled: base, which it needs, was disabled")
    expect(items.after._tag).toBe("Failure")
  })
})
