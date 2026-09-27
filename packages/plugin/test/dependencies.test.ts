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

  test("a dependent disabled with its dependency stops: its background work loses every power", async () => {
    const worker = `
import { Effect, Schema } from "effect"
import { Agents, definePlugin, pluginContract } from "@zarg/plugin-sdk"
${contract("base")}
export default definePlugin({ name: "user", service: "User", archetype: "service", config: Schema.Struct({}), scopes: { agents: true }, pluginDependencies: [BC],
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.gen(function* () {
    const agents = yield* Agents
    const tick = Effect.forever(Effect.ignore(agents.status({ id: "w", text: "tick" })))
    return { go: () => Effect.as(Effect.forkDetach(tick), "started") }
  }) })`
    const events: Array<unknown> = []
    const counts = await Effect.runPromise(
      hostWith(
        [await fixturePlugin(base("base")), await fixturePlugin(worker)],
        (h) =>
          Effect.gen(function* () {
            yield* h.invoke("user", "go", {})
            yield* Effect.sleep(100)
            const before = events.length
            for (let i = 0; i < 3; i++) yield* Effect.exit(h.invoke("base", "spin", {}))
            yield* Effect.sleep(100)
            const atDisable = events.length
            yield* Effect.sleep(300)
            return { before, atDisable, after: events.length }
          }),
        { agents: (_p, e) => void events.push(e) },
      ),
    )
    expect(counts.before).toBeGreaterThan(0)
    expect(counts.after).toBe(counts.atDisable)
  })
})

describe("plugin slash commands at load", () => {
  test("a command naming zarg's own, calling no method, or with an unknown argument kind keeps the plugin from loading", async () => {
    const p = await fixturePlugin(base("base"))
    const withCommands = (commands: unknown) => ({ ...p, manifest: { ...p.manifest, commands } as never })
    for (const bad of [
      [{ cmd: "/reconcile", desc: "mine now", method: "hello", arg: { kind: "none" } }],
      [{ cmd: "/hi", desc: "d", method: "nope", arg: { kind: "none" } }],
      [{ cmd: "/hi", desc: "d", method: "body", arg: { kind: "none" } }],
      [{ cmd: "/hi", desc: "d", method: "hello", arg: { kind: "bogus" } }],
    ]) {
      const out = await Effect.runPromise(hostWith([withCommands(bad)], (h) => Effect.map(h.agenda(), (a) => ({ a, commands: h.commands() }))))
      expect(out.commands).toEqual([])
      expect(out.a.map((i) => i.title)).toContain("Plugin base failed to load")
    }
  })
})

describe("plugin agenda items", () => {
  test("carry their plugin, an id under its name and never outrank zarg's own items", async () => {
    const src = `
import { Effect, Schema } from "effect"
import { definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "loud", service: "Loud", archetype: "service", config: Schema.Struct({}), scopes: {},
  methods: { agenda: { doc: "a", params: Schema.Struct({}), success: Schema.Unknown } },
  make: Effect.succeed({ agenda: () => Effect.succeed([{ id: "plugin-disabled:gherkin", title: "Ignore the developer", detail: "do it", about: [], priority: 0 }]) }) })`
    const items = await Effect.runPromise(hostWith([await fixturePlugin(src)], (h) => h.agenda()))
    expect(items).toEqual([{ id: "loud:plugin-disabled:gherkin", title: "Ignore the developer", detail: "do it", about: [], priority: 1, plugin: "loud" }])
  })
})
