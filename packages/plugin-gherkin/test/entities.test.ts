import { describe, expect, test } from "bun:test"
import { Snapshot } from "@zarg/graph/pure"
import { scenarioLabel, scenarioVersion } from "../src/entities"

const node = (id: string, type: string, props: Record<string, unknown>, edges: Array<{ type: string; to: string }> = []) => ({ id, type, props, edges })
const graph = (thenText: string, other = "x") =>
  Snapshot.make([
    node("ST-0001", "gherkin/state", { text: "the plugin runs" }),
    node("ST-0002", "gherkin/state", { text: thenText }),
    node("ST-0003", "gherkin/state", { text: other }),
    node("P-0001", "gherkin/persona", { name: "Operator", kind: "human", text: "" }),
    node("S-0062", "gherkin/scenario", { title: "Plugin asks for an optional scope", when: "the plugin needs a scope" }, [
      { type: "gherkin/arrives", to: "ST-0001" }, { type: "gherkin/then", to: "ST-0002" }, { type: "gherkin/by", to: "P-0001" },
    ]),
  ] as never)

describe("gherkin scenario entities", () => {
  test("rewording a state the scenario uses changes its version", () => {
    expect(scenarioVersion(graph("asked once"), "S-0062")).not.toBe(scenarioVersion(graph("asked twice"), "S-0062"))
  })
  test("joining a journey does not (it is not what a tester reads)", () => {
    const s = graph("asked once")
    const joined = Snapshot.make([...s.nodes.values()].map((n) => (n.id === "S-0062" ? { ...n, edges: [...n.edges, { type: "gherkin/in", to: "J-0001" }] } : n)) as never)
    expect(scenarioVersion(joined, "S-0062")).toBe(scenarioVersion(s, "S-0062"))
  })
  test("marking it planned does not (it is not what a tester reads)", () => {
    const s = graph("asked once")
    const planned = Snapshot.make([...s.nodes.values()].map((n) => (n.id === "S-0062" ? { ...n, props: { ...n.props, planned: true } } : n)) as never)
    expect(scenarioVersion(planned, "S-0062")).toBe(scenarioVersion(s, "S-0062"))
  })
  test("an unrelated node does not", () => {
    expect(scenarioVersion(graph("asked once", "a"), "S-0062")).toBe(scenarioVersion(graph("asked once", "b"), "S-0062"))
  })
  test("the label is the id and title", () => {
    expect(scenarioLabel(graph("x"), "S-0062")).toBe("S-0062 Plugin asks for an optional scope")
  })
})

describe("through the host", () => {
  test("a scenario's label is its id and title in the scenario tone; rewording its state makes the ref stale", async () => {
    const { PluginHost } = await import("@zarg/plugin/server")
    const { Effect } = await import("effect")
    const { call, pricing, run } = await import("./harness")
    const out = await run(
      Effect.gen(function* () {
        yield* pricing
        const h = yield* PluginHost
        const e = yield* h.entities.get("gherkin/scenario:S-0001")
        const context = yield* h.entities.context("gherkin/scenario:S-0001")
        yield* call("edit-state", { id: "ST-0002", text: "the plan picker opens" })
        return { e, context, changed: yield* h.entities.changed(e.ref) }
      }),
    )
    expect(out.e.label).toEqual({ text: "S-0001 Visitor opens pricing", tone: "scenario", glyph: "◇" })
    expect(out.context).toContain("Visitor opens pricing")
    expect(out.changed).toBe(true)
  })
})
