import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore, Snapshot } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { journeyFlow, journeysView } from "../src/journeys"
import { call, pricing, run } from "./harness"

/** A refusal's words: the tool's message, or every lint finding's. */
const said = (e: { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }) =>
  e._tag === "LintFailed" ? (e.findings ?? []).map((f) => f.message).join("\n") : String(e.message ?? e)

describe("journeys", () => {
  test("add, rename and tag: a scenario in two journeys shows both on its In line", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        expect((yield* call("add-journey", { name: "Checkout" })).message).toBe("created J-0001")
        yield* call("add-journey", { name: "Onboarding" })
        yield* call("link", { scenario: "S-0003", edge: "in", journey: { name: "checkout" } })
        yield* call("link", { scenario: "S-0003", edge: "in", journey: { id: "J-0002" } })
        yield* call("edit-journey", { id: "J-0001", name: "Buying" })
        return yield* PluginHost.use((h) => h.render(new Set(["S-0003"])))
      }),
    )
    expect(text.split("\n")[2]).toBe("  In    Buying, Onboarding  # J-0001, J-0002")
  })

  test("validation: a duplicate name, an unknown journey, a journey on the wrong edge, unlinking a tag the scenario lacks", async () => {
    await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        expect(said(yield* Effect.flip(call("add-journey", { name: "CHECKOUT" })))).toContain("J-0001")
        yield* call("add-journey", { name: "Browse" })
        expect(said(yield* Effect.flip(call("edit-journey", { id: "J-0002", name: "checkout" })))).toContain("J-0001")
        expect(said(yield* Effect.flip(call("link", { scenario: "S-0001", edge: "in", journey: { name: "Nope" } })))).toContain('"Nope" is not a journey')
        expect(said(yield* Effect.flip(call("link", { scenario: "S-0001", edge: "in", state: { id: "ST-0001" } })))).toContain("in takes a journey")
        expect(said(yield* Effect.flip(call("unlink", { scenario: "S-0001", edge: "in", journey: "J-0001" })))).toContain("has no in J-0001")
      }),
    )
  })

  test("a journey its scenarios name cannot be removed; untagged, it can; scenarios without journeys stay valid", async () => {
    await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("link", { scenario: "S-0001", edge: "in", journey: { id: "J-0001" } })
        expect(said(yield* Effect.flip(call("remove", { id: "J-0001" })))).toContain("S-0001")
        yield* call("unlink", { scenario: "S-0001", edge: "in", journey: "J-0001" })
        yield* call("remove", { id: "J-0001" })
        expect((yield* GraphStore.use((g) => g.snapshot)).nodes.has("J-0001")).toBe(false)
      }),
    )
  })

  test("journeys: each with its scenarios, for the view", async () => {
    const js = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("link", { scenario: "S-0004", edge: "in", journey: { id: "J-0001" } })
        yield* call("link", { scenario: "S-0003", edge: "in", journey: { id: "J-0001" } })
        return yield* PluginHost.use((h) => h.invoke("gherkin", "journeys", {}))
      }),
    )
    expect(js).toEqual([{ id: "J-0001", name: "Checkout", scenarios: ["S-0003", "S-0004"] }])
  })
})

// The flow of a journey's scenarios, from the graph alone.
const state = (id: string, text = id) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
const scenario = (id: string, arrives: string, then: ReadonlyArray<string>, journeys: ReadonlyArray<string> = ["J-0001"]) => ({
  id,
  type: "gherkin/scenario",
  props: { title: `${id} title`, when: `${id} happens` },
  edges: [...journeys.map((to) => ({ type: "gherkin/in", to })), { type: "gherkin/arrives", to: arrives }, ...then.map((to) => ({ type: "gherkin/then", to }))],
})
const journey = (id: string, name: string) => ({ id, type: "gherkin/journey", props: { name }, edges: [] })
const flow = (...nodes: ReadonlyArray<unknown>) => journeyFlow(Snapshot.make(nodes as never), "J-0001")
const scenarioLines = (text: string) => text.split("\n").filter((l) => /^S-\d+ /.test(l)).map((l) => l.split(" ")[0])

describe("journey flow", () => {
  test("connected: scenarios in the order their states lead, each as Given / When / Then", () => {
    const text = flow(journey("J-0001", "Checkout"), state("ST-1", "the cart is shown"), state("ST-2", "the payment form is shown"), state("ST-3", "the receipt is shown"), scenario("S-0002", "ST-2", ["ST-3"]), scenario("S-0001", "ST-1", ["ST-2"]))
    expect(scenarioLines(text)).toEqual(["S-0001", "S-0002"])
    expect(text).toContain("  Given the cart is shown  # ST-1\n  When  S-0001 happens\n  Then  the payment form is shown  # ST-2")
    expect(text).toContain("→ S-0002")
  })

  test("branched: a state two scenarios leave shows both as branches, each once", () => {
    const text = flow(journey("J-0001", "Checkout"), state("ST-1"), state("ST-2"), state("ST-3"), state("ST-4"), scenario("S-0001", "ST-1", ["ST-2"]), scenario("S-0002", "ST-2", ["ST-3"]), scenario("S-0003", "ST-2", ["ST-4"]))
    expect(scenarioLines(text)).toEqual(["S-0001", "S-0002", "S-0003"])
    expect(text).toContain("→ S-0002 or S-0003 (branches)")
  })

  test("cyclic: a scenario that leads back is marked, never repeated; a pure loop still shows every scenario", () => {
    const loop = flow(journey("J-0001", "Retry"), state("ST-1"), state("ST-2"), scenario("S-0001", "ST-1", ["ST-2"]), scenario("S-0002", "ST-2", ["ST-1"]))
    expect(scenarioLines(loop)).toEqual(["S-0001", "S-0002"])
    expect(loop).toContain("↺ back to S-0001")
  })

  test("disconnected: scenarios linked to no other scenario of the journey are listed apart, none left out, nothing invented", () => {
    const text = flow(journey("J-0001", "Mixed"), state("ST-1"), state("ST-2"), state("ST-8"), state("ST-9"), scenario("S-0001", "ST-1", ["ST-2"]), scenario("S-0005", "ST-8", ["ST-9"]), scenario("S-0002", "ST-2", ["ST-1"], []))
    // S-0002 leads on from S-0001 but is not in the journey: not shown, and S-0001 has no → line.
    expect(scenarioLines(text)).toEqual(["S-0001", "S-0005"])
    expect(text).toContain("Not connected")
    expect(text).not.toContain("→")
  })

  test("a scenario shared by two journeys shows in both; an empty journey says so", () => {
    const nodes = [journey("J-0001", "A"), journey("J-0002", "B"), state("ST-1"), state("ST-2"), scenario("S-0001", "ST-1", ["ST-2"], ["J-0001", "J-0002"])]
    const snap = Snapshot.make(nodes as never)
    expect(scenarioLines(journeyFlow(snap, "J-0001"))).toEqual(["S-0001"])
    expect(scenarioLines(journeyFlow(snap, "J-0002"))).toEqual(["S-0001"])
    expect(journeyFlow(Snapshot.make([journey("J-0001", "A")] as never), "J-0001")).toContain("No scenarios in this journey yet")
  })
})

describe("the Journeys view", () => {
  const nodes = [journey("J-0001", "Checkout"), journey("J-0002", "Browse"), state("ST-1"), state("ST-2"), scenario("S-0001", "ST-1", ["ST-2"], ["J-0001", "J-0002"])]
  test("lists journeys by name with their scenario counts; every journey's flow, by row, as a code block", () => {
    const v = journeysView(Snapshot.make(nodes as never))
    expect(v.rows).toEqual([
      { id: "J-0002", cells: { name: "Browse", scenarios: "1" } },
      { id: "J-0001", cells: { name: "Checkout", scenarios: "1" } },
    ])
    expect(v.flows["J-0002"]!.startsWith("```gherkin\nBrowse  # J-0002")).toBe(true)
    expect(v.flows["J-0001"]!.startsWith("```gherkin\nCheckout  # J-0001")).toBe(true)
    // The summary line: how many journeys, and how many scenarios they hold (a scenario in two counts once).
    expect(v.summary).toEqual({ items: [{ label: "journeys", value: "2" }, { label: "scenario", value: "1" }] })
  })
  test("no journeys: no rows, no flows (the view says how to make one)", () => {
    const v = journeysView(Snapshot.make([] as never))
    expect(v.rows).toEqual([])
    expect(v.flows).toEqual({})
  })
})

describe("the Journeys nav item's view, through the host", () => {
  test("open fills the view; a rename shows on the next open", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("add-journey", { name: "Browse" })
        yield* call("link", { scenario: "S-0004", edge: "in", journey: { id: "J-0001" } })
        const act = (action: string, rows: ReadonlyArray<string> = []) => PluginHost.use((h) => h.invoke("gherkin", "act", { agent: "journeys", action, rows }))
        const opened = yield* act("open")
        yield* call("edit-journey", { id: "J-0001", name: "Buying" })
        const again = yield* act("open")
        return { opened, again }
      }),
    )
    expect(got).toEqual({ opened: { notice: "2 journeys: Browse, Checkout" }, again: { notice: "2 journeys: Browse, Buying" } })
  })
})
