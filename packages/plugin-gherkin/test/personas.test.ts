import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { call, run } from "./harness"

const setup = Effect.gen(function* () {
  yield* call("add-persona", { name: "Operator", kind: "human", text: "The person shaping their product with zarg." })
  yield* call("add-persona", { name: "Driver Agent", kind: "agent", text: "zarg's conversational agent." })
  yield* call("add-state", { text: "the operator starts zarg", entry: true })
})

describe("personas", () => {
  test("add-persona creates P-0001; a scenario names its actors by id or name; render shows the By line", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* setup
        const r = yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ name: "operator" }, { id: "P-0002" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded", terminal: true }] })
        expect(r.message).toContain("S-0001")
        return yield* PluginHost.use((h) => h.render(new Set(["S-0001"])))
      }),
    )
    expect(text).toBe(
      [
        "S-0001 Operator answers",
        "  By    Operator, Driver Agent  # P-0001, P-0002",
        "  Given the operator starts zarg  # ST-0001",
        "  When  the operator picks an option",
        "  Then  the answer is recorded  # ST-0002",
      ].join("\n"),
    )
  })

  test("add-scenario without by, or with an unknown persona, is refused with the known personas", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        const none = yield* Effect.flip(call("add-scenario", { title: "x", when: "x happens", by: [], arrives: { id: "ST-0001" }, then: [{ text: "y" }] }))
        expect(String(none)).toContain("P-0001 Operator")
        // Leaving by out entirely (an agent's old habit) gets the same hint, not a schema error.
        const missing = yield* Effect.flip(call("add-scenario", { title: "x", when: "x happens", arrives: { id: "ST-0001" }, then: [{ text: "y" }] }))
        expect(String(missing)).toContain("P-0001 Operator")
        const unknown = yield* Effect.flip(call("add-scenario", { title: "x", when: "x happens", by: [{ name: "Shopper" }], arrives: { id: "ST-0001" }, then: [{ text: "y" }] }))
        expect(String(unknown)).toContain('"Shopper" is not a persona')
      }),
    )
  })

  test("link and unlink by: the persona field, refusals", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("link", { scenario: "S-0001", edge: "by", persona: { name: "Driver Agent" } })
        expect(String(yield* Effect.flip(call("link", { scenario: "S-0001", edge: "by", state: { id: "ST-0001" } })))).toContain("by takes a persona")
        expect(String(yield* Effect.flip(call("link", { scenario: "S-0001", edge: "then", persona: { id: "P-0001" } })))).toContain("then takes a state")
        yield* call("unlink", { scenario: "S-0001", edge: "by", persona: "P-0002" })
        expect(String(yield* Effect.flip(call("unlink", { scenario: "S-0001", edge: "by", persona: "P-0001" })))).toContain("its last persona")
        const node = (yield* GraphStore.use((g) => g.snapshot)).nodes.get("S-0001")!
        expect(node.edges.filter((e) => e.type === "gherkin/by").map((e) => e.to)).toEqual(["P-0001"])
      }),
    )
  })

  test("edit-persona changes its text; a persona named by scenarios cannot be removed", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("edit-persona", { id: "P-0001", text: "The person using zarg." })
        expect((yield* GraphStore.use((g) => g.snapshot)).nodes.get("P-0001")!.props.text).toBe("The person using zarg.")
        expect(String(yield* Effect.flip(call("remove", { id: "P-0001" })))).toContain("S-0001")
        yield* call("remove", { id: "P-0002" })
      }),
    )
  })
})

/** A refusal's words: the tool's message, or every lint finding's. */
const said = (e: { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }) =>
  e._tag === "LintFailed" ? (e.findings ?? []).map((f) => f.message).join("\n") : String(e.message ?? e)
describe("persona lints", () => {
  test("a name over 4 words, a text over 60 words: refused", async () => {
    await run(
      Effect.gen(function* () {
        expect(said(yield* Effect.flip(call("add-persona", { name: "the one who pays the bills", kind: "human", text: "x" })))).toContain("at most 4 words")
        expect(said(yield* Effect.flip(call("add-persona", { name: "Payer", kind: "human", text: "word ".repeat(61) })))).toContain("at most 60 words")
      }),
    )
  })
  test("a persona renamed to another's name is refused", async () => {
    await run(
      Effect.gen(function* () {
        yield* call("add-persona", { name: "Operator", kind: "human", text: "x" })
        yield* call("add-persona", { name: "Driver Agent", kind: "agent", text: "y" })
        expect(said(yield* Effect.flip(call("edit-persona", { id: "P-0002", name: "OPERATOR" })))).toContain("P-0001")
      }),
    )
  })
})

describe("persona agenda", () => {
  const items = PluginHost.use((h) => h.agenda())
  test("no personas: who uses this product (with an empty graph too)", async () => {
    const got = await run(items)
    expect(got.find((i) => i.id === "gherkin:no-personas")).toMatchObject({ title: "Who uses this product?", priority: 1 })
  })
  test("scenarios without by: one item naming them; an unused persona: its own item", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded", terminal: true }] })
        // A scenario written without the tool (an old graph): no by.
        yield* GraphStore.use((g) => g.commit([{ _tag: "Put", node: { id: "S-0002", type: "gherkin/scenario", props: { title: "Verify passes", when: "every check passes" }, edges: [{ type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0002" }] } }] as never))
        return yield* items
      }),
    )
    expect(got.find((i) => i.id === "gherkin:no-personas")).toBeUndefined()
    expect(got.find((i) => i.id === "gherkin:who-does")).toMatchObject({ title: "Who does 1 scenario?", about: ["S-0002"], priority: 2 })
    expect(got.find((i) => i.id === "gherkin:who-does")!.detail).toContain("P-0001 Operator")
    expect(got.find((i) => i.id === "gherkin:unused-persona:P-0002")).toMatchObject({ title: "Nobody acts as Driver Agent", priority: 3 })
  })
})

describe("forgiving drafts", () => {
  test("adding a persona that already exists (same name, same kind) uses it; another kind under that name is refused", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* setup
        const again = yield* call("add-persona", { name: "operator", kind: "human", text: "anything" })
        const clash = yield* Effect.flip(call("add-persona", { name: "Operator", kind: "agent", text: "x" }))
        return { again: again.message, added: again.added, clash: (clash as { message: string }).message }
      }),
    )
    expect(out.again).toBe("P-0001 is already Operator: no change")
    expect(out.added).toEqual([])
    expect(out.clash).toContain("P-0001 is already called \"Operator\"")
  })

  test("a journey given as a plain string (its id or its name) is that journey", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ name: "Operator" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("add-journey", { name: "Answering" })
        const byId = (yield* call("link", { scenario: "S-0001", edge: "in", journey: "J-0001" })).message
        return byId
      }),
    )
    expect(out).toContain("S-0001")
  })

  test("linking what is already linked changes nothing and says so", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ name: "Operator" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded" }] })
        const again = yield* call("link", { scenario: "S-0001", edge: "then", state: { id: "ST-0002" } })
        return { message: again.message, added: again.added }
      }),
    )
    expect(out.message).toBe("S-0001 already has then ST-0002: no change")
    expect(out.added).toEqual([])
  })

  test("linking a node that does not exist says so and names those there (a draft that guessed an id fixes it)", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-scenario", { title: "Operator answers", when: "the operator picks an option", by: [{ name: "Operator" }], arrives: { id: "ST-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("add-journey", { name: "Answering" })
        const missing = yield* Effect.flip(call("link", { scenario: "S-0002", edge: "in", journey: "J-0001" }))
        const wrong = yield* Effect.flip(call("link", { scenario: "ST-0001", edge: "in", journey: "J-0001" }))
        return { missing: (missing as { message: string }).message, wrong: (wrong as { message: string }).message }
      }),
    )
    expect(out.missing).toBe("S-0002 does not exist (not in the graph, nor added before it in this change); the scenarios there: S-0001")
    expect(out.wrong).toBe("ST-0001 is a gherkin/state, not a gherkin/scenario")
  })
})
