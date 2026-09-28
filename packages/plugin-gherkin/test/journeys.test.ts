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
  test("add, rename and tag: a card in two journeys shows both on its In line", async () => {
    const text = await run(
      Effect.gen(function* () {
        yield* pricing
        expect((yield* call("add-journey", { name: "Checkout" })).message).toBe("created J-0001")
        yield* call("add-journey", { name: "Onboarding" })
        yield* call("link", { card: "UX-0003", edge: "in", journey: { name: "checkout" } })
        yield* call("link", { card: "UX-0003", edge: "in", journey: { id: "J-0002" } })
        yield* call("edit-journey", { id: "J-0001", name: "Buying" })
        return yield* PluginHost.use((h) => h.render(new Set(["UX-0003"])))
      }),
    )
    expect(text.split("\n")[2]).toBe("  In    Buying, Onboarding  # J-0001, J-0002")
  })

  test("validation: a duplicate name, an unknown journey, a journey on the wrong edge, unlinking a tag the card lacks", async () => {
    await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        expect(said(yield* Effect.flip(call("add-journey", { name: "CHECKOUT" })))).toContain("J-0001")
        yield* call("add-journey", { name: "Browse" })
        expect(said(yield* Effect.flip(call("edit-journey", { id: "J-0002", name: "checkout" })))).toContain("J-0001")
        expect(said(yield* Effect.flip(call("link", { card: "UX-0001", edge: "in", journey: { name: "Nope" } })))).toContain('"Nope" is not a journey')
        expect(said(yield* Effect.flip(call("link", { card: "UX-0001", edge: "in", state: { id: "S-0001" } })))).toContain("in takes a journey")
        expect(said(yield* Effect.flip(call("unlink", { card: "UX-0001", edge: "in", journey: "J-0001" })))).toContain("has no in J-0001")
      }),
    )
  })

  test("a journey its cards name cannot be removed; untagged, it can; cards without journeys stay valid", async () => {
    await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("link", { card: "UX-0001", edge: "in", journey: { id: "J-0001" } })
        expect(said(yield* Effect.flip(call("remove", { id: "J-0001" })))).toContain("UX-0001")
        yield* call("unlink", { card: "UX-0001", edge: "in", journey: "J-0001" })
        yield* call("remove", { id: "J-0001" })
        expect((yield* GraphStore.use((g) => g.snapshot)).nodes.has("J-0001")).toBe(false)
      }),
    )
  })

  test("journeys: each with its cards, for the view", async () => {
    const js = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("link", { card: "UX-0004", edge: "in", journey: { id: "J-0001" } })
        yield* call("link", { card: "UX-0003", edge: "in", journey: { id: "J-0001" } })
        return yield* PluginHost.use((h) => h.invoke("gherkin", "journeys", {}))
      }),
    )
    expect(js).toEqual([{ id: "J-0001", name: "Checkout", cards: ["UX-0003", "UX-0004"] }])
  })
})

// The flow of a journey's cards, from the graph alone.
const state = (id: string, text = id) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
const card = (id: string, arrives: string, then: ReadonlyArray<string>, journeys: ReadonlyArray<string> = ["J-0001"]) => ({
  id,
  type: "gherkin/card",
  props: { title: `${id} title`, when: `${id} happens` },
  edges: [...journeys.map((to) => ({ type: "gherkin/in", to })), { type: "gherkin/arrives", to: arrives }, ...then.map((to) => ({ type: "gherkin/then", to }))],
})
const journey = (id: string, name: string) => ({ id, type: "gherkin/journey", props: { name }, edges: [] })
const flow = (...nodes: ReadonlyArray<unknown>) => journeyFlow(Snapshot.make(nodes as never), "J-0001")
const cardLines = (text: string) => text.split("\n").filter((l) => /^UX-\d+ /.test(l)).map((l) => l.split(" ")[0])

describe("journey flow", () => {
  test("connected: cards in the order their states lead, each as Given / When / Then", () => {
    const text = flow(journey("J-0001", "Checkout"), state("S-1", "the cart is shown"), state("S-2", "the payment form is shown"), state("S-3", "the receipt is shown"), card("UX-0002", "S-2", ["S-3"]), card("UX-0001", "S-1", ["S-2"]))
    expect(cardLines(text)).toEqual(["UX-0001", "UX-0002"])
    expect(text).toContain("  Given the cart is shown  # S-1\n  When  UX-0001 happens\n  Then  the payment form is shown  # S-2")
    expect(text).toContain("→ UX-0002")
  })

  test("branched: a state two cards leave shows both as branches, each once", () => {
    const text = flow(journey("J-0001", "Checkout"), state("S-1"), state("S-2"), state("S-3"), state("S-4"), card("UX-0001", "S-1", ["S-2"]), card("UX-0002", "S-2", ["S-3"]), card("UX-0003", "S-2", ["S-4"]))
    expect(cardLines(text)).toEqual(["UX-0001", "UX-0002", "UX-0003"])
    expect(text).toContain("→ UX-0002 or UX-0003 (branches)")
  })

  test("cyclic: a card that leads back is marked, never repeated; a pure loop still shows every card", () => {
    const loop = flow(journey("J-0001", "Retry"), state("S-1"), state("S-2"), card("UX-0001", "S-1", ["S-2"]), card("UX-0002", "S-2", ["S-1"]))
    expect(cardLines(loop)).toEqual(["UX-0001", "UX-0002"])
    expect(loop).toContain("↺ back to UX-0001")
  })

  test("disconnected: cards linked to no other card of the journey are listed apart, none left out, nothing invented", () => {
    const text = flow(journey("J-0001", "Mixed"), state("S-1"), state("S-2"), state("S-8"), state("S-9"), card("UX-0001", "S-1", ["S-2"]), card("UX-0005", "S-8", ["S-9"]), card("UX-0002", "S-2", ["S-1"], []))
    // UX-0002 leads on from UX-0001 but is not in the journey: not shown, and UX-0001 has no → line.
    expect(cardLines(text)).toEqual(["UX-0001", "UX-0005"])
    expect(text).toContain("Not connected")
    expect(text).not.toContain("→")
  })

  test("a card shared by two journeys shows in both; an empty journey says so", () => {
    const nodes = [journey("J-0001", "A"), journey("J-0002", "B"), state("S-1"), state("S-2"), card("UX-0001", "S-1", ["S-2"], ["J-0001", "J-0002"])]
    const snap = Snapshot.make(nodes as never)
    expect(cardLines(journeyFlow(snap, "J-0001"))).toEqual(["UX-0001"])
    expect(cardLines(journeyFlow(snap, "J-0002"))).toEqual(["UX-0001"])
    expect(journeyFlow(Snapshot.make([journey("J-0001", "A")] as never), "J-0001")).toContain("No cards in this journey yet")
  })
})

describe("the Journeys view", () => {
  const nodes = [journey("J-0001", "Checkout"), journey("J-0002", "Browse"), state("S-1"), state("S-2"), card("UX-0001", "S-1", ["S-2"], ["J-0001", "J-0002"])]
  test("lists journeys by name with their card counts; shows the chosen one's flow (else the first), as a code block", () => {
    const v = journeysView(Snapshot.make(nodes as never), "J-0002")
    expect(v.rows).toEqual([
      { id: "J-0002", cells: { name: "Browse", cards: "1" } },
      { id: "J-0001", cells: { name: "Checkout", cards: "1" } },
    ])
    expect(v.selected).toBe("J-0002")
    expect(v.markdown.startsWith("```text\nBrowse  # J-0002")).toBe(true)
    // A journey that is gone falls back to the first by name.
    expect(journeysView(Snapshot.make(nodes as never), "J-0009").selected).toBe("J-0002")
  })
  test("no journeys: says how to make one", () => {
    const v = journeysView(Snapshot.make([] as never), undefined)
    expect(v.rows).toEqual([])
    expect(v.markdown).toContain("No journeys yet")
  })
})

describe("the Journeys nav item's view, through the host", () => {
  test("open fills the view (first journey by name); show picks another; a rename shows on the next open", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* pricing
        yield* call("add-journey", { name: "Checkout" })
        yield* call("add-journey", { name: "Browse" })
        yield* call("link", { card: "UX-0004", edge: "in", journey: { id: "J-0001" } })
        const act = (action: string, rows: ReadonlyArray<string> = []) => PluginHost.use((h) => h.invoke("gherkin", "act", { agent: "journeys", action, rows }))
        const opened = yield* act("open")
        const shown = yield* act("show", ["J-0001"])
        yield* call("edit-journey", { id: "J-0001", name: "Buying" })
        const again = yield* act("open")
        return { opened, shown, again }
      }),
    )
    expect(got).toEqual({ opened: { notice: "showing Browse" }, shown: { notice: "showing Checkout" }, again: { notice: "showing Buying" } })
  })
})
