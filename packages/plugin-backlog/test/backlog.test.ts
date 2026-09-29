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
  test("a plan lands in Backlog as B-01 (it waits there until you move it to Ready); its feedback is planned; the board shows it", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      const { id } = (yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))) as { id: string }
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      return { id, status: yield* h.invoke("backlog", "status", { ids: feedback }), lanes: lanes(seen) }
    }))
    expect(out.id).toBe("B-01")
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("planned")
    expect(out.lanes.backlog!.map((c) => [c.id, c.top, c.badge, c.lines.map((l) => l.text)])).toEqual([["B-01", "B-01 UX-0001", "◇1", ["Operator"]]])
    expect(out.lanes.ready).toEqual([])
    expect(Object.keys(out.lanes)).toEqual(["backlog", "ready", "running", "review", "done"])
  })
  test("next: the oldest Ready plan it can take; not one after an unfinished plan, not one whose card changed (unless a plan it waits on changed it)", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "plan", planOf(card.ref, [], { after: ["B-01"] }))
      // In Backlog, the Planner takes neither; moved to Ready, the oldest.
      const inBacklog = yield* h.invoke("backlog", "next", {})
      for (const id of ["B-01", "B-02"]) yield* h.invoke("backlog", "moved", { id, to: "ready", by: "operator" })
      const first = (yield* h.invoke("backlog", "next", {})) as { id: string }
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applied" })
      const whileRunning = yield* h.invoke("backlog", "next", {})
      // A plan waiting on none, drafted on the card as it is before B-01 lands.
      yield* h.invoke("backlog", "plan", planOf(card.ref, []))
      yield* h.invoke("backlog", "moved", { id: "B-03", to: "ready", by: "operator" })
      yield* gherkin("edit-state", { id: "S-0002", text: "the operator is asked once" })
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "done", by: "operator" })
      const byDesign = (yield* h.invoke("backlog", "next", {})) as { id: string }
      yield* h.invoke("backlog", "moved", { id: "B-02", to: "done", by: "operator" })
      const changed = yield* h.invoke("backlog", "next", {})
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      return { inBacklog, first: first.id, whileRunning, byDesign: byDesign.id, changed, lanes: lanes(seen), feedback: yield* h.invoke("backlog", "status", { ids: feedback }) }
    }))
    expect(out.inBacklog).toBeNull()
    expect(out.first).toBe("B-01")
    expect(out.whileRunning).toBeNull()
    expect(out.byDesign).toBe("B-02")
    expect(out.changed).toBeNull()
    expect(out.lanes.ready![0]!.lines.map((l) => l.text)).toEqual(["Operator", "⚠ card changed"])
    expect((out.feedback as Array<{ state: string }>)[0]!.state).toBe("closed")
  })
  test("moves by hand record events; the drawer opens on a card and its buttons move it; drop reopens its feedback", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move-right", rows: ["B-01"] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const drawer = seen.get("backlog/item.agent") as { markdown: string }
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move", rows: [], text: "backlog" })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move", rows: [], text: "ready" })
      const byCommand = yield* h.entities.command("backlog/item:B-01", "park", {})
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
      const e = yield* h.entities.get("backlog/item:B-01")
      return { drawer, opened: seen.opened, byCommand, e, lanes: lanes(seen), feedback: yield* h.invoke("backlog", "status", { ids: feedback }) }
    }))
    expect(out.drawer.markdown).toContain("**Grant prompt names its choices**")
    expect(out.drawer.markdown).toContain("gherkin/edit-state")
    expect(out.opened).toEqual([[{ surface: "item", agent: "backlog", focus: true }]])
    expect(out.byCommand).toEqual({ notice: "B-01 → Backlog" })
    expect((out.e.data as { events: Array<{ what: string; by: string }> }).events.map((x) => x.what)).toEqual(["planned", "backlog → ready", "ready → backlog", "backlog → ready", "ready → backlog", "dropped"])
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
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "move", rows: [], text: "ready" })
      const e = yield* h.entities.get("backlog/item:B-01")
      return { blocked, e: e.data as { needs?: string; events: Array<{ what: string }>; cards: Array<{ ref: string }> }, next: yield* h.invoke("backlog", "next", {}) }
    }))
    expect(out.blocked).toBeNull()
    expect(out.e.events.map((x) => x.what)).toContain("applied in abc1234")
    expect((out.e as unknown as { cards: Array<{ ref: string }> }).cards.map((c) => c.ref.split("@")[0])).toEqual(["gherkin/card:UX-0001", "gherkin/card:UX-0009"])
    expect(out.e.needs).toBeUndefined()
    expect((out.next as { id: string }).id).toBe("B-01")
  })
  test("the drawer's Plan tab reads as a plan: what changes on the card, before and after", async () => {
    const plan = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      return (seen.get("backlog/item.plan") as { markdown: string }).markdown
    }))
    expect(plan).toContain("**Grant prompt names its choices**")
    expect(plan).toContain("1 card: 1 changed, 0 new · 1 change · closes 1 feedback (1 high)")
    expect(plan).toContain("**UX-0001** Plugin asks for a scope")
    expect(plan).toContain("- Then  the operator is asked")
    expect(plan).toContain("+ Then  the operator sees: once, always, deny")
    expect(plan).not.toContain("gherkin/edit-state")
  })
  test("the drawer's For agents tab: each card with its version (✓ current), the feedback, the card itself, the changes, events", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      return (seen.get("backlog/item.agent") as { markdown: string }).markdown
    }))
    expect(out).toContain("B-01 · Backlog")
    expect(out).toContain("**Grant prompt names its choices**")
    expect(out).toMatch(/UX-0001 @[0-9a-f]{4} ✓ · Operator · Set up · high/)
    expect(out).toContain("**Feedback 1**")
    expect(out).toContain("◇ gap  No deny path.")
    expect(out).toContain("the plugin needs a scope")
    expect(out).toContain("**Events**")
  })
  test("Resync: a changed card whose plan still fits takes the card's version now; the ⚠ goes", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* gherkin("edit-card", { id: "UX-0001", when: "the plugin needs a scope it may ask for" })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      const before = lanes(seen).backlog![0]!.lines.map((l) => l.text)
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const drawer = (seen.get("backlog/item.agent") as { markdown: string }).markdown
      const offered = (seen.get("backlog/item.plan") as { actions?: string[] }).actions
      const notice = (yield* h.invoke("backlog", "act", { agent: "backlog", action: "resync", rows: [] })) as { notice: string }
      const after = lanes(seen).backlog![0]!.lines.map((l) => l.text)
      return { before, drawer, offered, offeredAfter: (seen.get("backlog/item.plan") as { actions?: string[] }).actions, notice: notice.notice, after }
    }))
    expect(out.before).toContain("⚠ card changed")
    expect(out.drawer).toMatch(/UX-0001 @[0-9a-f]{4} ⚠ changed/)
    // Resync is offered only while a card changed.
    expect(out.offered).toEqual(["move", "drop", "resync"])
    expect(out.offeredAfter).toEqual(["move", "drop"])
    expect(out.notice).toBe("B-01 resynced: its changes still fit the cards as they are now")
    expect(out.after).not.toContain("⚠ card changed")
  })
  test("Resync: a plan that no longer fits goes back to triage: its feedback carried to the card as it is now, the plan dropped, the journey queued", async () => {
    const out = await run(() => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback, { changes: [{ tool: "edit-state", params: { id: "S-0099", text: "no such state" } }] }))
      yield* gherkin("edit-card", { id: "UX-0001", when: "the plugin needs a scope it may ask for" })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const notice = (yield* h.invoke("backlog", "act", { agent: "backlog", action: "resync", rows: [] })) as { notice: string }
      const item = (yield* h.entities.get("backlog/item:B-01")).data as { dropped?: boolean }
      const stages = (yield* h.invoke("backlog", "stages", {})) as Array<{ journey: string; stage: string; queued?: number }>
      const old = (yield* h.invoke("backlog", "status", { ids: feedback })) as Array<{ state: string }>
      const open = (yield* h.invoke("backlog", "feedbackOf", { journey: "Set up" })) as Array<{ id: string; note: string; on: boolean }>
      return { notice: notice.notice, dropped: item.dropped, stages, old, open }
    }))
    expect(out.notice).toMatch(/^B-01 no longer fits \(.*\): back to triage, Set up queued #1$/)
    expect(out.dropped).toBe(true)
    expect(out.stages).toEqual([expect.objectContaining({ journey: "Set up", stage: "refine", queued: 1 })])
    expect(out.old[0]!.state).toBe("closed")
    expect(out.open.map((e) => [e.note, e.on])).toEqual([["No deny path.", true]])
  })
  test("opening a plan shows it loading first (its drawer never shows the plan before), then the plan", async () => {
    const plans = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      return (seen.log ?? []).filter((e) => e.key === "backlog/item.plan").map((e) => e.data as { markdown: string; loading?: string })
    }))
    expect(plans[0]!.loading).toBe("Loading B-01…")
    expect(plans.at(-1)!.loading).toBeUndefined()
    expect(plans.at(-1)!.markdown).toContain("**Grant prompt names its choices**")
  })
  test("Drop closes the drawer: its plan is gone", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "plan", planOf(card.ref, feedback))
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const before = seen.closed ?? []
      const notice = (yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })) as { notice: string }
      return { before: [...before], closed: seen.closed ?? [], notice: notice.notice }
    }))
    expect(out.before).toEqual([])
    expect(out.closed).toEqual(["item"])
    expect(out.notice).toBe("B-01 dropped; its feedback is open again")
  })
  test("dropping a triaged plan leaves its journey as if never planned (nothing says Planned for a plan that is gone)", async () => {
    const out = await run(() => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "refine", rows: [] })
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: planOf(card.ref, feedback).changes, answers: feedback, summary: "s" })
      yield* h.invoke("backlog", "drafted", { journey: "Set up", title: "T", steps: [] })
      const planned = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; item?: string }>)[0]!
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: [planned.item!] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
      const after = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; item?: string }>)[0]!
      return { planned: [planned.stage, planned.item], after: [after.stage, after.item] }
    }))
    expect(out.planned).toEqual(["planned", "B-01"])
    expect(out.after).toEqual(["triage", undefined])
  })
  test("plans: a round's plans in Backlog, after linked by id; the journey planned until the last goes; one after a dropped plan says so", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      const change = planOf(card.ref, feedback).changes
      const r = (yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [
        { title: "First", steps: ["a"], changes: change, cards: ["UX-0001"], feedback, after: [] },
        { title: "Second", steps: ["b"], changes: change, cards: ["UX-0001"], feedback: [], after: [0] },
      ] })) as { ids: string[] }
      const items = yield* Effect.forEach(r.ids, (id) => Effect.map(h.entities.get(`backlog/item:${id}`), (e) => e.data as { status: string; after?: string[]; feedback: string[] }))
      const stage = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; items?: string[] }>)[0]!
      const status = (yield* h.invoke("backlog", "status", { ids: feedback })) as Array<{ state: string }>
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: [r.ids[0]!] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
      const afterOne = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string }>)[0]!.stage
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      const second = lanes(seen).backlog!.find((c) => c.id === r.ids[1])!
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: [r.ids[1]!] })
      const plan = (seen.get("backlog/item.plan") as { markdown: string }).markdown
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "drop", rows: [] })
      const afterBoth = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string }>)[0]!.stage
      return { ids: r.ids, items, stage, status: status[0]!.state, afterOne, afterBoth, second: second.lines.map((l) => l.text), plan }
    }))
    expect(out.ids).toEqual(["B-01", "B-02"])
    expect(out.items.map((i) => [i.status, i.after ?? [], i.feedback.length])).toEqual([["backlog", [], 1], ["backlog", ["B-01"], 0]])
    expect([out.stage.stage, out.stage.items]).toEqual(["planned", ["B-01", "B-02"]])
    expect(out.status).toBe("planned")
    expect(out.afterOne).toBe("planned")
    expect(out.second).toContain("⇠ after B-01 (dropped)")
    expect(out.plan).toContain("Waits on B-01 (dropped)")
    expect(out.afterBoth).toBe("triage")
  })
  test("cards its dependencies touch are not changed for it: no ⚠, and the Planner takes it once they are Done; the first says what waits on it", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card, feedback } = yield* setUp
      const h = yield* PluginHost
      const change = planOf(card.ref, feedback).changes
      yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [
        { title: "First", steps: [], changes: change, cards: ["UX-0001"], feedback, after: [] },
        { title: "Second", steps: [], changes: change, cards: ["UX-0001"], feedback: [], after: [0] },
      ] })
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "item", rows: ["B-01"] })
      const first = (seen.get("backlog/item.plan") as { markdown: string }).markdown
      // The first is applied: the card changes.
      yield* gherkin("edit-state", { id: "S-0002", text: "the operator is asked once" })
      for (const id of ["B-01", "B-02"]) yield* h.invoke("backlog", "moved", { id, to: "ready", by: "operator" })
      yield* h.invoke("backlog", "moved", { id: "B-01", to: "done", by: "operator" })
      const next = (yield* h.invoke("backlog", "next", {})) as { id: string } | null
      yield* h.invoke("backlog", "act", { agent: "backlog", action: "open", rows: [] })
      return { next: next?.id, first, lines: lanes(seen).ready!.find((c) => c.id === "B-02")!.lines.map((l) => l.text) }
    }))
    expect(out.next).toBe("B-02")
    expect(out.lines).not.toContain("⚠ card changed")
    expect(out.first).toContain("B-02 waits on this")
  })
})
