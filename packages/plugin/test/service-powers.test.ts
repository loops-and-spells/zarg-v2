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
        const y = yield* m.complete({ role: "rehearse", messages: [{ role: "user", content: "hi" }] })
        const t = yield* c.now
        const u = yield* c.uuid
        yield* a.changed
        return { x, y: y.text, t: t > 0, u: u.length }`))], (h) => h.invoke("svc", "go", {}), {
        decide: () => Effect.succeed({ q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }),
        complete: (req) => Effect.succeed({ text: `from ${req.role}`, promptTokens: 3, completionTokens: 2 }),
        agendaChanged: (p) => void seen.push(p),
      }),
    )
    expect(out).toEqual({ x: { q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }, y: "from rehearse", t: true, u: 36 })
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
})
