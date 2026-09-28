import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Attention, defineView, definePlugin, Views } from "../src"
import { manifestOf } from "../src/manifest"

const Tester = defineView("tester", { steps: { kind: "log", role: "log" }, progress: { kind: "stats", role: "summary" } })

describe("plugin views", () => {
  test("a plugin's views travel in its manifest as layouts", () => {
    const p = definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: { agents: true }, views: [Tester], methods: {}, make: Effect.succeed({}) })
    expect(manifestOf(p).views).toEqual([{ name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }, { id: "progress", kind: "stats", role: "summary" }] }])
  })

  test("a plugin's surfaces travel in its manifest; one showing a view it does not declare is refused", () => {
    const status = { kind: "panel" as const, name: "status", view: "tester", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "none" as const }
    const p = definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: { agents: true }, views: [Tester], surfaces: [status], methods: {}, make: Effect.succeed({}) })
    expect(manifestOf(p).surfaces).toEqual([status])
    expect(() => definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: {}, views: [Tester], surfaces: [{ ...status, view: "nope" }], methods: {}, make: Effect.succeed({}) })).toThrow(/which the plugin does not declare/)
  })

  test("a view naming a tone plugins may not name (a surface) is refused at build", () => {
    const Bad = defineView("bad", { rows: { kind: "table", role: "primary", columns: [{ id: "a", label: "a", tone: "ground" as never }] } })
    expect(() => definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: {}, views: [Bad], methods: {}, make: Effect.succeed({}) })).toThrow(/column a names ground; plugins may name/)
  })

  test("two views with one name are refused", () => {
    expect(() => definePlugin({ name: "demo", service: "Demo", archetype: "service", config: Schema.Struct({}), scopes: {}, views: [Tester, Tester], methods: {}, make: Effect.succeed({}) })).toThrow(/view tester/)
  })

  test("Views pushes over the agents power, typed by the view", async () => {
    const calls: Array<[string, unknown]> = []
    const p = definePlugin({
      name: "demo",
      service: "Demo",
      archetype: "service",
      config: Schema.Struct({}),
      scopes: { agents: true },
      views: [Tester],
      methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Null } },
      make: Effect.gen(function* () {
        const views = yield* Views
        return {
          go: () =>
            Effect.gen(function* () {
              yield* views.set("t-1", Tester, "progress", { items: [{ label: "steps", value: "1/2" }] })
              yield* views.append("t-1", Tester, "steps", [{ text: "ok" }])
              return null
            }),
        }
      }),
    })
    const methods = p.serve({ call: async (name: string, args: unknown) => (name === "agents.event" && calls.push([name, args]), null) })
    await methods.go!({})
    expect(calls).toEqual([
      ["agents.event", { event: "set", id: "t-1", view: "tester", section: "progress", data: { items: [{ label: "steps", value: "1/2" }] } }],
      ["agents.event", { event: "append", id: "t-1", view: "tester", section: "steps", lines: [{ text: "ok" }] }],
    ])
    if (false as boolean) {
      const views = null as unknown as Views["Service"]
      // @ts-expect-error: progress is not a log
      views.append("t", Tester, "progress", [])
      // @ts-expect-error: no section named workers
      views.set("t", Tester, "workers", { items: [] })
    }
  })
})

test("Attention asks for the developer on an agent's row, and stops asking", async () => {
  const calls: Array<unknown> = []
  const p = definePlugin({
    name: "demo",
    service: "Demo",
    archetype: "service",
    config: Schema.Struct({}),
    scopes: { agents: true },
    methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Null } },
    make: Effect.gen(function* () {
      const attention = yield* Attention
      return { go: () => Effect.as(Effect.andThen(attention.request("t-1", "4 findings to review"), attention.clear("t-1")), null) }
    }),
  })
  await p.serve({ call: async (name: string, args: unknown) => (name === "agents.event" && calls.push(args), null) }).go!({})
  expect(calls).toEqual([{ event: "attention", id: "t-1", reason: "4 findings to review" }, { event: "attention", id: "t-1" }])
})
