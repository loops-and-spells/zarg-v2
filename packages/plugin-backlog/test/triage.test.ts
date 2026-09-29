import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, run, type Seen } from "./harness"

const setUp = (on = true) =>
  Effect.gen(function* () {
    yield* gherkin("add-persona", { name: "Operator", kind: "human", text: "The person using zarg." })
    yield* gherkin("add-state", { text: "the plugin runs", entry: true })
    yield* gherkin("add-card", { title: "Plugin asks for a scope", when: "the plugin needs a scope", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the operator is asked" }] })
    const h = yield* PluginHost
    const card = yield* h.entities.get("gherkin/card:UX-0001")
    const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "high", note: "No deny path.", from: { agent: "rehearse", run: "r-1" }, triage: { on, why: "fix" } }] })) as { ids: string[] }
    yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
    return { card, ids }
  })
const press = (action: string) => PluginHost.use((h) => h.invoke("backlog", "act", { agent: "feedback", action, rows: [] })) as Effect.Effect<{ notice: string }, unknown, PluginHost>
const work = (seen: Seen) => (seen.get("feedback/work") as { markdown: string } | undefined)?.markdown ?? ""
const stage = (seen: Seen) => (seen.get("feedback/stage") as { markdown: string } | undefined)?.markdown ?? ""

const buttons = (seen: Seen) => (seen.get("feedback/feedback") as { actions?: string[] } | undefined)?.actions
const note = (id: string, text: string) => PluginHost.use((h) => h.invoke("backlog", "act", { agent: "feedback", action: "note", section: "feedback", rows: [id], text })) as Effect.Effect<{ notice: string }, unknown, PluginHost>

describe("the triage hub's stages", () => {
  test("Triage offers Refine only; Refine with nothing on is refused; Accept outside Plan says why", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      yield* setUp(false)
      return { buttons: buttons(seen), notices: [(yield* press("refine")).notice, (yield* press("accept")).notice] }
    }))
    expect(out.buttons).toEqual(["refine", "note"])
    expect(out.notices).toEqual(["nothing on in Set up: turn feedback on first", "Set up has no plan to accept yet"])
  })
  test("Refine drafts and re-rehearses on its own; Plan offers Accept (to the Backlog) or Refine again", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      const refine = (yield* press("refine")).notice
      const refining = { work: work(seen), buttons: buttons(seen) }
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator is asked: once, always, deny" } }], answers: ids, summary: "Name the choices." })
      // The view follows the agent's work without a key press.
      const rehearsing = { stage: stage(seen), buttons: buttons(seen) }
      const stages = (yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; draft: unknown[] }>
      yield* h.invoke("backlog", "rehearsed", { journey: "Set up", resolved: ids, fresh: [], next: "plan", cards: ["S-0002", "UX-0001"] })
      yield* press("open")
      const drafting = buttons(seen)
      yield* h.invoke("backlog", "drafted", { journey: "Set up", title: "Grant prompt names its choices", steps: ["Name the choices"] })
      yield* press("open")
      const plan = { work: work(seen), buttons: buttons(seen) }
      const nothingLeft = (yield* press("refine")).notice
      const accepted = (yield* press("accept")).notice
      const item = yield* h.entities.get("backlog/item:B-01")
      return { refine, refining, rehearsing, stages, drafting, plan, nothingLeft, accepted, item: item.data as { changes: unknown[]; cards: Array<{ ref: string }>; feedback: string[]; status: string }, file: readdirSync(join(root, ".zarg/triage")).some((n) => /^set-up-[0-9a-f]{6}\.json$/.test(n)), status: yield* h.invoke("backlog", "status", { ids }), ids }
    }))
    expect(out.refine).toBe("Set up: refining 1 card")
    expect(out.refining.work).toContain("The Triage Agent is drafting UX-0001")
    expect(out.refining.buttons).toEqual(["note"])
    expect(out.rehearsing.stage).toContain("● Re-rehearse")
    expect(out.rehearsing.buttons).toEqual(["refine", "note"])
    expect(out.stages).toEqual([expect.objectContaining({ stage: "rehearse", draft: [expect.anything()] })])
    expect(out.drafting).toEqual(["refine", "note"])
    expect(out.plan.work).toContain("Grant prompt names its choices")
    expect(out.plan.work).toContain("gherkin/edit-state")
    expect(out.plan.buttons).toEqual(["accept", "refine", "note"])
    expect(out.nothingLeft).toBe("nothing left to refine in Set up: a accepts the plan")
    expect(out.accepted).toBe("Set up: backlogged as B-01")
    expect(out.item.status).toBe("ready")
    expect(out.item.cards.map((c) => c.ref.split("@")[0])).toEqual(["gherkin/card:UX-0001"])
    expect(out.item.feedback).toEqual(out.ids)
    expect(out.file).toBe(true)
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("planned")
  })
  test("a proposal with problems is left out and named at Plan; a double a backlogs once", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      yield* press("refine")
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [], answers: ids, summary: "", problems: ["the Triage Agent could not draft a proposal"] })
      yield* press("open")
      const leftOut = { stage: stage(seen), work: work(seen) }
      const refineAgain = (yield* press("refine")).notice
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "asked: once, always, deny" } }], answers: ids, summary: "s" })
      yield* h.invoke("backlog", "rehearsed", { journey: "Set up", resolved: [], fresh: [], next: "plan" })
      yield* h.invoke("backlog", "drafted", { journey: "Set up", title: "T", steps: [] })
      const [a, b] = yield* Effect.all([press("accept"), press("accept")], { concurrency: "unbounded" })
      const items = yield* h.entities.query({ type: "backlog/item" })
      return { leftOut, refineAgain, notices: [a.notice, b.notice].sort(), items: items.length }
    }))
    expect(out.leftOut.stage).toContain("● Plan")
    expect(out.leftOut.work).toContain("Left out: UX-0001 (the Triage Agent could not draft a proposal)")
    expect(out.refineAgain).toBe("Set up: refining 1 card again")
    expect(out.notices).toEqual(["Set up has no plan to accept yet", "Set up: backlogged as B-01"])
    expect(out.items).toBe(1)
  })
  test("the operator's note on an entry: kept through a re-filing, shown with ✎ and in the detail, given to the Triage Agent; empty clears it", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { ids, card } = yield* setUp()
      const h = yield* PluginHost
      const saved = (yield* note(ids[0]!, "  Deny should say why.  ")).notice
      yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "high", note: "No deny path.", from: { agent: "rehearse", run: "r-2" }, triage: { on: true, why: "fix" } }] })
      yield* press("open")
      const row = (seen.get("feedback/feedback") as { rows: Array<{ id: string; text?: string; cells: Record<string, string> }> }).rows[0]!
      const detail = (seen.get("feedback/detail") as { rows: Record<string, string> }).rows[row.id]!
      const given = ((yield* h.invoke("backlog", "feedbackOf", { journey: "Set up" })) as Array<{ operatorNote?: string }>)[0]!.operatorNote
      yield* note(ids[0]!, "")
      const cleared = ((yield* h.invoke("backlog", "feedbackOf", { journey: "Set up" })) as Array<{ operatorNote?: string }>)[0]!.operatorNote
      return { saved, text: row.text, card: row.cells.note, detail, given, cleared }
    }))
    expect(out.saved).toBe("note saved")
    expect(out.text).toBe("Deny should say why.")
    expect(out.card).toBe("✎")
    expect(out.detail).toContain("**Your note:** Deny should say why.")
    expect(out.given).toBe("Deny should say why.")
    expect(out.cleared).toBeUndefined()
  })
  test("draft again: one card waits again for the Triage Agent, over the draft without its changes", async () => {
    const out = await run(() => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      yield* press("refine")
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", title: "Plugin asks for a scope", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "asked: once, always, deny" } }], answers: ids, summary: "s", tries: [{ ms: 900, tokensIn: 100, tokensOut: 50, reasoning: 20, finish: "stop", problems: [] }] })
      const before = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; proposals: Array<{ tries?: unknown[]; title?: string }> }>)[0]!
      const again = (yield* h.invoke("backlog", "redo", { journey: "Set up", card: "UX-0001" })) as { notice: string }
      const after = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; draft: unknown[]; proposals: Array<{ status: string }> }>)[0]!
      return { before: [before.stage, before.proposals[0]!.tries?.length, before.proposals[0]!.title], again: again.notice, after: [after.stage, after.draft.length, after.proposals[0]!.status] }
    }))
    expect(out.before).toEqual(["rehearse", 1, "Plugin asks for a scope"])
    expect(out.again).toBe("Set up: drafting UX-0001 again")
    expect(out.after).toEqual(["refine", 0, "waiting"])
  })
})
