import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fixturePlugin, hostWith } from "./fixtures"

const plugin = (scopes: string, body: string) => `
import { Effect, Schema } from "effect"
import { Agenda, Clock, Decisions, definePlugin, Models } from "@zarg/plugin-sdk"
export default definePlugin({ name: "svc", service: "Svc", archetype: "service", config: Schema.Struct({}), scopes: ${scopes},
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Unknown, agents: true }, agenda: { doc: "a", params: Schema.Struct({}), success: Schema.Unknown } },
  make: Effect.gen(function* () { const d = yield* Decisions; const m = yield* Models; const c = yield* Clock; const a = yield* Agenda
    return { go: () => Effect.gen(function* () { ${body} }), agenda: () => Effect.succeed([{ id: "svc:1", title: "t", detail: "d", about: [], priority: 3 }]) } }) })`

describe("service powers", () => {
  test("decisions, models (declared roles only), clock and agenda.changed reach the host", async () => {
    const seen: Array<string> = []
    const out = await Effect.runPromise(
      hostWith([await fixturePlugin(plugin(`{ decisions: true, models: ["rehearse"] }`, `
        const x = yield* d.decide({ state: "s", questions: { q: { type: "noul", instructions: "i" } } })
        const y = yield* m.complete({ role: "rehearse", messages: [{ role: "user", content: "hi" }], reasoning: { enabled: false } })
        const t = yield* c.now
        const u = yield* c.uuid
        yield* a.changed
        return { x, y: y.text, t: t > 0, u: u.length }`))], (h) => h.invoke("svc", "go", {}), {
        decide: () => Effect.succeed({ q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }),
        complete: (req) => Effect.succeed({ text: `from ${req.role}${req.reasoning?.enabled === false ? ", no reasoning" : ""}`, promptTokens: 3, completionTokens: 2 }),
        agendaChanged: (p) => void seen.push(p),
      }),
    )
    expect(out).toEqual({ x: { q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }, y: "from rehearse, no reasoning", t: true, u: 36 })
    expect(seen).toEqual(["svc"])
  })

  test("undeclared scopes and undeclared roles are refused; a spent budget is BudgetExceeded", async () => {
    const noScope = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{}`, `return yield* d.decide({ state: "s", questions: {} })`))], (h) => h.invoke("svc", "go", {}), { decide: () => Effect.succeed({}) })))
    expect(JSON.stringify(noScope)).toContain("decisions")
    const role = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{ models: ["rehearse"] }`, `return yield* m.complete({ role: "driver", messages: [] })`))], (h) => h.invoke("svc", "go", {}), { complete: () => Effect.succeed({ text: "", promptTokens: 0, completionTokens: 0 }) })))
    expect(JSON.stringify(role)).toContain("driver")
    const budget = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{ decisions: true }`, `yield* d.decide({ state: "s", questions: {} }); return yield* d.decide({ state: "s", questions: {} })`))], (h) => h.invoke("svc", "go", {}), { decide: () => Effect.succeed({}), budget: () => ({ decisionsPerHour: 1, tokensPerHour: 1 }) })))
    expect(JSON.stringify(budget)).toContain("BudgetExceeded")
  })

  test("a service plugin's agenda reaches the host agenda", async () => {
    const items = await Effect.runPromise(hostWith([await fixturePlugin(plugin(`{}`, `return 1`))], (h) => h.agenda()))
    expect(items.map((i) => i.id)).toContain("svc:1")
  })

  test("agents events reach the host with the plugin's name, only with the agents scope", async () => {
    const src = (scopes: string) => `
import { Effect, Schema } from "effect"
import { Agents, definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "svc", service: "Svc", archetype: "service", config: Schema.Struct({}), scopes: ${scopes},
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Unknown, agents: true } },
  make: Effect.gen(function* () { const a = yield* Agents
    return { go: () => Effect.gen(function* () {
      yield* a.start({ id: "t1", title: "tester", task: "walk" })
      yield* a.status({ id: "t1", progress: { done: 1, total: 2 }, text: "1/2" })
      yield* a.step({ id: "t1", text: "UX-1: ok" })
      yield* a.end({ id: "t1", ok: true })
      return "ok" }) } }) })`
    const seen: Array<unknown> = []
    await Effect.runPromise(hostWith([await fixturePlugin(src(`{ agents: true }`))], (h) => h.invoke("svc", "go", {}), { agents: (p, e) => void seen.push([p, (e as { event: string }).event]) }))
    expect(seen).toEqual([["svc", "start"], ["svc", "status"], ["svc", "step"], ["svc", "end"]])
    const refused = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(src(`{}`))], (h) => h.invoke("svc", "go", {}), { agents: () => {} })))
    expect(JSON.stringify(refused)).toContain("agents scope")
  })

  test("a plugin's slash commands are in its manifest and listed by the host", async () => {
    const src = `
import { Effect, Schema } from "effect"
import { definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({ name: "svc", service: "Svc", archetype: "service", config: Schema.Struct({}), scopes: {},
  commands: [{ cmd: "/svc-go", desc: "go now", method: "command", arg: { kind: "none" } }],
  methods: { command: { doc: "c", params: Schema.Struct({ args: Schema.Array(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) } },
  make: Effect.succeed({ command: ({ args }) => Effect.succeed({ notice: "went " + args.join(",") }) }) })`
    const out = await Effect.runPromise(hostWith([await fixturePlugin(src)], (h) => Effect.gen(function* () {
      return { list: h.commands(), run: yield* h.invoke("svc", "command", { args: ["x"] }) }
    })))
    expect(out.list).toEqual([{ plugin: "svc", cmd: "/svc-go", desc: "go now", method: "command", arg: { kind: "none" } }])
    expect(out.run).toEqual({ notice: "went x" })
  })
})
