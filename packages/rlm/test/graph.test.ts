import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { Kernel, manifest } from "@zarg/kernel"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, gherkinHost } from "./gherkin-host"
import { agenda, AgendaDef, DecisionsDef, decisionsService, graph, GraphDef, inquire, InquireDef, pluginService, type Scope, verify } from "../src"

/** A real graph with the gherkin plugin: S-0001 → UX-0001 → S-0002, plus an unrelated S-0003. */
const withGraph = <A>(scope: Scope, body: (k: Kernel.Kernel) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const host = yield* PluginHost
    const store = yield* GraphStore
    yield* host.call("gherkin/add-state", { text: "the home page is shown", entry: true })
    yield* host.call("gherkin/add-card", { title: "Open pricing", when: "the user opens pricing", arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown", terminal: true }] })
    yield* host.call("gherkin/add-state", { text: "an unrelated screen", entry: true, terminal: true })
    const ctx = { host, snapshot: store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))), scope }
    const services = [graph(ctx), pluginService(gherkin.manifest, ctx)!]
    const k = yield* Kernel.make({ services })
    return yield* body(k)
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(gherkinHost(), graphLayer(mkdtempSync(join(tmpdir(), "zarg-rlm-graph-"))))),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  )

describe("Graph service", () => {
  test("render and agenda are narrowed to the scope's focus", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) => k.run("return yield* Graph.render({})"))
    expect(out.output).toContain("UX-0001 Open pricing")
    expect(out.output).not.toContain("S-0003")
  })

  test("show returns the node with its hash; nodes outside the scope are refused", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) =>
      Effect.all([k.run('return (yield* Graph.show({ id: "S-0002" })).hash'), k.run('return yield* Graph.show({ id: "S-0003" })')]),
    )
    expect(out[0].output).toMatch(/^[0-9a-f]{12}$/)
    expect(out[1].output).toContain("OutOfScope")
  })
})

describe("plugin tools as services", () => {
  test("Gherkin.addCard runs through the write pipeline and lints", async () => {
    const out = await withGraph({}, (k) =>
      Effect.all([
        k.run('return (yield* Gherkin.addState({ text: "a settings page is shown", entry: true, terminal: true })).added'),
        k.run('return yield* Gherkin.addState({ text: "shown if logged in" })'),
      ]),
    )
    expect(out[0].output).toContain("S-0004")
    expect(out[1].output).toContain("LintFailed")
    expect(out[1].output).toContain('contains "if"')
  })

  test("text that merely looks like an id is not treated as one", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) =>
      k.run('return (yield* Gherkin.editCard({ id: "UX-0001", title: "Dates use ISO-8601" })).changed'),
    )
    expect(out.output).toContain("UX-0001")
    expect(out.output).not.toContain("OutOfScope")
  })

  test("writes that name nodes outside the scope are refused", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) => k.run('return yield* Gherkin.editState({ id: "S-0003", text: "changed" })'))
    expect(out.output).toContain("OutOfScope")
  })
})

describe("Inquire, Agenda and Verify", () => {
  const kernel = <A>(services: Parameters<typeof Kernel.make>[0]["services"], f: (k: Kernel.Kernel) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(Kernel.make({ services }), f)))

  test("Inquire.ask returns the developer's answer; bad option counts are refused", async () => {
    const asked: Array<string> = []
    const svc = inquire({ ask: (q) => Effect.sync(() => (asked.push(q.question), { choice: "b" })) })
    const out = await kernel([svc], (k) =>
      Effect.all([
        k.run('return yield* Inquire.ask({ question: "Which?", options: [{ id: "a", label: "A", recommended: true, why: "simpler" }, { id: "b", label: "B" }] })'),
        k.run('return yield* Inquire.ask({ question: "Only one?", options: [{ id: "a", label: "A" }] })'),
      ]),
    )
    expect(out[0].output).toContain('"choice": "b"')
    expect(out[1].output).toContain("InvalidQuestion")
    expect(asked).toEqual(["Which?"])
  })

  test("Agenda.raise hands the item to the inbox", async () => {
    const titles: Array<string> = []
    const out = await kernel([agenda({ raise: (i) => Effect.sync(() => (titles.push(i.title), "A-1")) })], (k) =>
      k.run('return yield* Agenda.raise({ title: "UX-0007 contradicts UX-0003", detail: "d", about: ["UX-0007"] })'),
    )
    expect(out.output).toContain('"id": "A-1"')
    expect(titles).toEqual(["UX-0007 contradicts UX-0003"])
  })

  test("Verify reports the gate's verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-verify-"))
    const ctx = { root, scope: {}, sensitive: [] }
    const out = await kernel([verify(ctx, ["bash", "-c", "echo checks passed"])], (k) => k.run("return yield* Verify.run({})"))
    expect(out.output).toContain('"passed": true')
    const failing = await kernel([verify(ctx, ["bash", "-c", "echo broken; exit 3"])], (k) => k.run("return (yield* Verify.run({})).passed"))
    expect(failing.output).toBe("false")
  })

  test("Decisions.decide answers from cells", async () => {
    const svc = decisionsService({
      decide: (req) => Effect.succeed(Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", answer: true, probability: 0.8, confidence: 0.6 }]))),
    })
    const out = await kernel([svc], (k) => k.run('const a = yield* Decisions.decide({ state: "s", questions: { ok: { type: "noul", instructions: "fine?" } } })\nreturn a.ok.answer'))
    expect(out.output).toBe("true")
  })
})

describe("the manifest explains the fields a model gets wrong", () => {
  const text = manifest([InquireDef, DecisionsDef, GraphDef, AgendaDef, pluginService(gherkin.manifest, { host: undefined as never, snapshot: undefined as never, scope: {} })!.def])
  test("Inquire: `about` belongs to the question, `id` is what the answer returns", () => {
    expect(text).toMatch(/\/\*\* Card or state ids the whole question is about[^\n]*\*\/\n\s+about\?: ReadonlyArray<string>\n\s+\}\): Eff/)
    expect(text).toMatch(/\/\*\* Returned as the answer's `choice`[^\n]*\*\/\n\s+id: string/)
  })
  test("Decisions, Graph and Gherkin fields carry their meaning", () => {
    expect(text).toMatch(/\/\*\* What the questions are about[^\n]*\*\/\n\s+state: string/)
    expect(text).toMatch(/\/\*\* Only these node ids[^\n]*\*\/\n\s+focus\?: ReadonlyArray<string>/)
    expect(text).toMatch(/\/\*\* The state the user is in before the action[^\n]*\*\/\n\s+arrives:/)
  })
})
