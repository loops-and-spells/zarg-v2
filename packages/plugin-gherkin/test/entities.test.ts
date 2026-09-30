import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { cardLabel, cardVersion } from "../src/entities"

const node = (id: string, type: string, props: Record<string, unknown>, edges: Array<{ type: string; to: string }> = []) => ({ id, type, props, edges })
const graph = (thenText: string, other = "x") =>
  Snapshot.make([
    node("S-0001", "gherkin/state", { text: "the plugin runs" }),
    node("S-0002", "gherkin/state", { text: thenText }),
    node("S-0003", "gherkin/state", { text: other }),
    node("P-0001", "gherkin/persona", { name: "Operator", kind: "human", text: "" }),
    node("UX-0062", "gherkin/card", { title: "Plugin asks for an optional scope", when: "the plugin needs a scope" }, [
      { type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0002" }, { type: "gherkin/by", to: "P-0001" },
    ]),
  ] as never)

describe("gherkin card entities", () => {
  test("rewording a state the card uses changes its version", () => {
    expect(cardVersion(graph("asked once"), "UX-0062")).not.toBe(cardVersion(graph("asked twice"), "UX-0062"))
  })
  test("joining a journey does not (it is not what a tester reads)", () => {
    const s = graph("asked once")
    const joined = Snapshot.make([...s.nodes.values()].map((n) => (n.id === "UX-0062" ? { ...n, edges: [...n.edges, { type: "gherkin/in", to: "J-0001" }] } : n)) as never)
    expect(cardVersion(joined, "UX-0062")).toBe(cardVersion(s, "UX-0062"))
  })
  test("marking it planned does not (it is not what a tester reads)", () => {
    const s = graph("asked once")
    const planned = Snapshot.make([...s.nodes.values()].map((n) => (n.id === "UX-0062" ? { ...n, props: { ...n.props, planned: true } } : n)) as never)
    expect(cardVersion(planned, "UX-0062")).toBe(cardVersion(s, "UX-0062"))
  })
  test("an unrelated node does not", () => {
    expect(cardVersion(graph("asked once", "a"), "UX-0062")).toBe(cardVersion(graph("asked once", "b"), "UX-0062"))
  })
  test("the label is the id and title", () => {
    expect(cardLabel(graph("x"), "UX-0062")).toBe("UX-0062 Plugin asks for an optional scope")
  })
})

describe("through the host", () => {
  test("a card's label is its id and title in the card tone; rewording its state makes the ref stale", async () => {
    const { PluginHost } = await import("@zarg/plugin/server")
    const { Effect } = await import("effect")
    const { call, pricing, run } = await import("./harness")
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const e = yield* h.entities.get("gherkin/card:UX-0001")
        const context = yield* h.entities.context("gherkin/card:UX-0001")
        yield* call("edit-state", { id: "S-0002", text: "the plan picker opens" })
        return { e, context, changed: yield* h.entities.changed(e.ref) }
      }),
    )
    expect(out.e.label).toEqual({ text: "UX-0001 Visitor opens pricing", tone: "card", glyph: "◇" })
    expect(out.context).toContain("Visitor opens pricing")
    expect(out.changed).toBe(true)
  })
})
