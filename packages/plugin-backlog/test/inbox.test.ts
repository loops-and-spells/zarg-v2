import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, run, type Seen } from "./harness"

const setUp = (why = "fix · real 0.90") =>
  Effect.gen(function* () {
    yield* gherkin("add-persona", { name: "Operator", kind: "human", text: "The person using zarg." })
    yield* gherkin("add-state", { text: "the plugin runs", entry: true })
    yield* gherkin("add-card", { title: "Plugin asks for a scope", when: "the plugin needs a scope", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the operator is asked" }] })
    const h = yield* PluginHost
    const card = yield* h.entities.get("gherkin/card:UX-0001")
    const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "high", note: "No deny path.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why } }] })) as { ids: string[] }
    return { card, ids, h }
  })
const topic = (seen: Seen, key: string) => (seen.inbox ?? []).find((t) => t.key === key)

describe("the backlog's topics in the inbox", () => {
  test("a plan that needs the operator is a plan topic; Back to Ready moves it and clears the need; the topic settles", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { card, ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plan", { title: "T", journey: "Set up", cards: [{ ref: card.ref }], changes: [], feedback: ids, steps: [] })
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "Planner", needs: "commit your uncommitted changes to S-0002 first" })
        const t = { ...topic(seen, "needs:B-01")! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: "needs:B-01", answer: "ready" })
        const item = (yield* h.entities.get("backlog/item:B-01")).data as { status: string; needs?: string }
        return { t, item, after: topic(seen, "needs:B-01") }
      }),
    )
    expect(out.t).toMatchObject({ kind: "plan", title: "B-01 T can't apply: commit your uncommitted changes to S-0002 first", answers: [{ id: "ready" }, { id: "drop" }] })
    expect([out.item.status, out.item.needs]).toEqual(["ready", undefined])
    expect(out.after).toMatchObject({ state: "moot" })
  })
  test("feedback rehearse routed to ask is a question topic; Turn it off flips it off as the operator; the topic settles", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { ids, h } = yield* setUp("ask · real 0.62")
        const t = { ...topic(seen, `ask:${ids[0]}`)! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: `ask:${ids[0]}`, answer: "off" })
        const status = (yield* h.invoke("backlog", "status", { ids })) as Array<{ on: boolean }>
        return { t, on: status[0]!.on, after: topic(seen, `ask:${ids[0]}`) }
      }),
    )
    expect(out.t).toMatchObject({ kind: "question", answers: [{ id: "on" }, { id: "off" }] })
    expect(out.t.title).toContain("No deny path.")
    expect(out.on).toBe(false)
    expect(out.after).toMatchObject({ state: "moot" })
  })
  test("a card left out of a round is a plan topic; Draft again sends it back to triage; the round's plans are a report", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { ids, h } = yield* setUp()
        // A second card whose change goes in: the round moves on to Plan with UX-0001 left out.
        yield* gherkin("add-card", { title: "Plugin loads", when: "the plugin starts", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the plugin is loaded" }] })
        const two = yield* h.entities.get("gherkin/card:UX-0002")
        yield* h.invoke("backlog", "file", { entries: [{ ref: two.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "low", note: "Say when.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix · real 0.90" } }] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "refine", rows: [] })
        // A card is left out once its rounds of tries are spent.
        for (let i = 0; i < 3; i++) yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [], answers: [], summary: "", problems: ["a clause has if"] })
        yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0002", changes: [{ tool: "edit-card", params: { id: "UX-0002", when: "the plugin starts up" } }], answers: [], summary: "s" })
        const t = { ...topic(seen, "left:Set up:UX-0001")! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: "left:Set up:UX-0001", answer: "draft" })
        const stage = ((yield* h.invoke("backlog", "stages", {})) as Array<{ proposals: Array<{ card: string; status: string }> }>)[0]!
        void ids
        return { t, status: stage.proposals.find((p) => p.card === "UX-0001")?.status }
      }),
    )
    expect(out.t).toMatchObject({ kind: "plan", title: "UX-0001 left out of Set up's round", answers: [{ id: "draft" }, { id: "leave" }] })
    expect(out.status).toBe("waiting")
  })
  test("a folded round's plans and a finished rehearse run are reports", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { card, ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [{ title: "First", steps: [], changes: [], cards: ["UX-0001"], feedback: ids, after: [] }] })
        yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "friction", severity: "low", note: "Wordy.", from: { agent: "rehearse", run: "r-2" }, triage: { on: false, why: "drop · real 0.10" } }], walked: ["UX-0001"], run: "r-2" })
        return (seen.inbox ?? []).filter((t) => t.kind === "report").map((t) => t.title)
      }),
    )
    expect(out).toEqual(["Set up folded into 1 plan: B-01", "Rehearse run r-2: 1 entry on Set up"])
  })
})
