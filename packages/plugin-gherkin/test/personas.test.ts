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
  test("add-persona creates P-0001; a card names its actors by id or name; render shows the By line", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* setup
        const r = yield* call("add-card", { title: "Operator answers", when: "the operator picks an option", by: [{ name: "operator" }, { id: "P-0002" }], arrives: { id: "S-0001" }, then: [{ text: "the answer is recorded", terminal: true }] })
        expect(r.message).toContain("UX-0001")
        return yield* PluginHost.use((h) => h.render(new Set(["UX-0001"])))
      }),
    )
    expect(text).toBe(
      [
        "UX-0001 Operator answers",
        "  By    Operator, Driver Agent  # P-0001, P-0002",
        "  Given the operator starts zarg  # S-0001",
        "  When  the operator picks an option",
        "  Then  the answer is recorded  # S-0002",
      ].join("\n"),
    )
  })

  test("add-card without by, or with an unknown persona, is refused with the known personas", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        const none = yield* Effect.flip(call("add-card", { title: "x", when: "x happens", by: [], arrives: { id: "S-0001" }, then: [{ text: "y" }] }))
        expect(String(none)).toContain("P-0001 Operator")
        const unknown = yield* Effect.flip(call("add-card", { title: "x", when: "x happens", by: [{ name: "Shopper" }], arrives: { id: "S-0001" }, then: [{ text: "y" }] }))
        expect(String(unknown)).toContain('"Shopper" is not a persona')
      }),
    )
  })

  test("link and unlink by: the persona field, refusals", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-card", { title: "Operator answers", when: "the operator picks an option", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("link", { card: "UX-0001", edge: "by", persona: { name: "Driver Agent" } })
        expect(String(yield* Effect.flip(call("link", { card: "UX-0001", edge: "by", state: { id: "S-0001" } })))).toContain("by takes a persona")
        expect(String(yield* Effect.flip(call("link", { card: "UX-0001", edge: "then", persona: { id: "P-0001" } })))).toContain("then takes a state")
        yield* call("unlink", { card: "UX-0001", edge: "by", persona: "P-0002" })
        expect(String(yield* Effect.flip(call("unlink", { card: "UX-0001", edge: "by", persona: "P-0001" })))).toContain("its last persona")
        const node = (yield* GraphStore.use((g) => g.snapshot)).nodes.get("UX-0001")!
        expect(node.edges.filter((e) => e.type === "gherkin/by").map((e) => e.to)).toEqual(["P-0001"])
      }),
    )
  })

  test("edit-persona changes its text; a persona named by cards cannot be removed", async () => {
    await run(
      Effect.gen(function* () {
        yield* setup
        yield* call("add-card", { title: "Operator answers", when: "the operator picks an option", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the answer is recorded" }] })
        yield* call("edit-persona", { id: "P-0001", text: "The person using zarg." })
        expect((yield* GraphStore.use((g) => g.snapshot)).nodes.get("P-0001")!.props.text).toBe("The person using zarg.")
        expect(String(yield* Effect.flip(call("remove", { id: "P-0001" })))).toContain("UX-0001")
        yield* call("remove", { id: "P-0002" })
      }),
    )
  })
})
