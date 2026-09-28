import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, run, type Seen } from "./harness"

const setUp = Effect.gen(function* () {
  yield* gherkin("add-persona", { name: "Operator", kind: "human", text: "The person using zarg." })
  yield* gherkin("add-state", { text: "the plugin runs", entry: true })
  yield* gherkin("add-card", { title: "Plugin asks for a scope", when: "the plugin needs a scope", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the operator is asked" }] })
  const h = yield* PluginHost
  const card = yield* h.entities.get("gherkin/card:UX-0001")
  const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "high", note: "No deny path.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix" } }] })) as { ids: string[] }
  return { card, feedback: ids }
})
const planOf = (ref: string, feedback: ReadonlyArray<string>, over: Record<string, unknown> = {}) => ({
  title: "Grant prompt names its choices", journey: "Set up", cards: [{ ref }], changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator sees: once, always, deny" } }],
  feedback, steps: ["Name the choices"], persona: "Operator", severity: "high", ...over,
})
type Lanes = { lanes: Array<{ id: string; cards: Array<{ id: string; top: string; badge: string; lines: Array<{ text: string }> }> }> }
const lanes = (seen: Seen) => Object.fromEntries(((seen.get("backlog/board") as Lanes | undefined)?.lanes ?? []).map((l) => [l.id, l.cards]))

describe("the backlog's plans", () => {
  test("a plan lands in Ready as B-01; its feedback is planned; the board shows it", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      const { id } = (yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))) as { id: string }
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      return { id, status: yield* h.invoke("backlog", "status", { ids: feedback }), lanes: lanes(seen) }
    }))
    expect(out.id).toBe("B-01")
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("planned")
    expect(out.lanes.ready!.map((c) => [c.id, c.top, c.badge, c.lines.map((l) => l.text)])).toEqual([["B-01", "B-01 UX-0001", "◇1", ["Operator"]]])
    expect(Object.keys(out.lanes)).toEqual(["backlog", "ready", "running", "review", "done"])
  })
  test("next: the oldest Ready plan it can take; not one after an unfinished plan, not one whose card changed", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "plan", planOf(card.ref, [], { after: ["B-01"] }))
      const first = (yield* h.invoke("backlog", "next", {})) as { id: string }
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applied" })
      const whileRunning = yield* h.invoke("backlog", "next", {})
      yield* gherkin("edit-state", { id: "S-0002", text: "the operator is asked once" })
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "done", by: "operator" })
      const changed = yield* h.invoke("backlog", "next", {})
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      return { first: first.id, whileRunning, changed, lanes: lanes(seen), feedback: yield* h.invoke("backlog", "status", { ids: feedback }) }
    }))
    expect(out.first).toBe("B-01")
    expect(out.whileRunning).toBeNull()
    expect(out.changed).toBeNull()
    expect(out.lanes.ready![0]!.lines.map((l) => l.text)).toEqual(["Operator", "⚠ card changed"])
    expect((out.feedback as Array<{ state: string }>)[0]!.state).toBe("closed")
  })
  test("moves by hand record events; the drawer opens on a card and its buttons move it; drop reopens its feedback", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move-left", rows: ["B-01"] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const drawer = seen.get("backlog/item") as { markdown: string }
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "ready", rows: [] })
      const byCommand = yield* h.entities.command("backlog/item:B-01", "park", {})
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
      const e = yield* h.entities.get("backlog/item:B-01")
      return { drawer, opened: seen.opened, byCommand, e, lanes: lanes(seen), feedback: yield* h.invoke("backlog", "status", { ids: feedback }) }
    }))
    expect(out.drawer.markdown).toContain("**Grant prompt names its choices**")
    expect(out.drawer.markdown).toContain("gherkin/edit-state")
    expect(out.opened).toEqual([[{ surface: "item", agent: "backlog", focus: true }]])
    expect(out.byCommand).toEqual({ notice: "B-01 → Backlog" })
    expect((out.e.data as { events: Array<{ what: string; by: string }> }).events.map((x) => x.what)).toEqual(["planned", "ready → backlog", "backlog → ready", "ready → backlog", "dropped"])
    expect(Object.values(out.lanes).flat()).toEqual([])
    expect((out.feedback as Array<{ state: string }>)[0]!.state).toBe("open")
  })
  test("an agent's note on a plan already in its lane is kept; → Ready clears a failed apply's need of the operator", async () => {
    const out = await run(() => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applying 1 change" })
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applied in abc1234", cards: ["UX-0001", "UX-0009"] })
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "Planner", what: "apply failed", needs: "gherkin/edit-state: bad" })
      const blocked = yield* h.invoke("backlog", "next", {})
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "ready", rows: [] })
      const e = yield* h.entities.get("backlog/item:B-01")
      return { blocked, e: e.data as { needs?: string; events: Array<{ what: string }>; cards: Array<{ ref: string }> }, next: yield* h.invoke("backlog", "next", {}) }
    }))
    expect(out.blocked).toBeNull()
    expect(out.e.events.map((x) => x.what)).toContain("applied in abc1234")
    expect((out.e as unknown as { cards: Array<{ ref: string }> }).cards.map((c) => c.ref.split("@")[0])).toEqual(["gherkin/card:UX-0001", "gherkin/card:UX-0009"])
    expect(out.e.needs).toBeUndefined()
    expect((out.next as { id: string }).id).toBe("B-01")
  })
})
