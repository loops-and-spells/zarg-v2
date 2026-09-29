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

const rows = (seen: Seen) => (seen.get("feedback/feedback") as { rows: Array<{ id: string; tone?: string; readonly?: boolean; cells?: Record<string, string> }> } | undefined)?.rows ?? []
const buttons = (seen: Seen) => (seen.get("feedback/feedback") as { actions?: string[] } | undefined)?.actions
const note = (id: string, text: string) => PluginHost.use((h) => h.invoke("backlog", "act", { agent: "feedback", action: "note", section: "feedback", rows: [id], text })) as Effect.Effect<{ notice: string }, unknown, PluginHost>

describe("the triage hub's stages", () => {
  test("Triage offers Refine only; Refine with nothing on is refused", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      yield* setUp(false)
      return { buttons: buttons(seen), notice: (yield* press("refine")).notice }
    }))
    expect(out.buttons).toEqual(["refine", "note"])
    expect(out.notice).toBe("nothing on in Set up: turn feedback on first")
  })
  test("Refine drafts on its own; the drafted plan goes to the Backlog lane (not Ready) and the journey is Planned", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      const refine = (yield* press("refine")).notice
      const refining = { work: work(seen), buttons: buttons(seen) }
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator is asked: once, always, deny" } }], answers: ids, summary: "Name the choices." })
      const planning = { stage: stage(seen), buttons: buttons(seen), stages: (yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; draft: unknown[] }> }
      yield* h.invoke("backlog", "drafted", { journey: "Set up", title: "Grant prompt names its choices", steps: ["Name the choices"] })
      const done = ((yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; item?: string }>)[0]!
      const item = yield* h.entities.get("backlog/item:B-01")
      return { refine, refining, planning, done, item: item.data as { changes: unknown[]; cards: Array<{ ref: string }>; feedback: string[]; status: string }, file: readdirSync(join(root, ".zarg/triage")).some((n) => /^set-up-[0-9a-f]{6}\.json$/.test(n)), status: yield* h.invoke("backlog", "status", { ids }), ids }
    }))
    expect(out.refine).toBe("Set up: queued #1 · 1 card")
    expect(out.refining.work).toContain("Queued for triage")
    expect(out.refining.buttons).toEqual(["note"])
    expect(out.planning.stages).toEqual([expect.objectContaining({ stage: "plan", draft: [expect.anything()] })])
    expect(out.planning.buttons).toEqual(["note"])
    // Its feedback is planned: the journey leaves Feedback until new feedback comes.
    expect([out.done.stage, out.done.item]).toEqual(["planned", "B-01"])
    expect(out.item.status).toBe("backlog")
    expect(out.item.cards.map((c) => c.ref.split("@")[0])).toEqual(["gherkin/card:UX-0001"])
    expect(out.item.feedback).toEqual(out.ids)
    expect(out.file).toBe(true)
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("planned")
  })
  test("every card left out: back to Triage, nothing on the Backlog; a double drafted backlogs once", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      yield* press("refine")
      // Three rounds that fail: then it is left out.
      for (let i = 0; i < 3; i++) yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [], answers: ids, summary: "", problems: ["the Triage Agent could not draft a proposal"] })
      yield* press("open")
      const back = { stage: stage(seen), work: work(seen) }
      yield* press("refine")
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "asked: once, always, deny" } }], answers: ids, summary: "s" })
      yield* Effect.all([h.invoke("backlog", "drafted", { journey: "Set up", title: "T", steps: [] }), h.invoke("backlog", "drafted", { journey: "Set up", title: "T", steps: [] })], { concurrency: "unbounded" })
      const items = yield* h.entities.query({ type: "backlog/item" })
      return { back, items: items.length }
    }))
    expect(out.back.stage).toContain("● Triage")
    expect(out.back.work).toContain("Nothing drafted: every card was left out.")
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
    expect(out.before).toEqual(["plan", 1, "Plugin asks for a scope"])
    expect(out.again).toBe("Set up: drafting UX-0001 again")
    expect(out.after).toEqual(["refine", 0, "waiting"])
  })
  test("queued journeys wait in line; a worker's journey says so; their feedback is read-only until Plan", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { ids, card } = yield* setUp()
      const h = yield* PluginHost
      const { ids: other } = (yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Reconcile"], persona: "Operator", kind: "friction", severity: "low", note: "Another.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix" } }] })) as { ids: string[] }
      yield* press("open")
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "journey", rows: ["Set up"] })
      yield* press("refine")
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "journey", rows: ["Reconcile"] })
      yield* press("refine")
      const queued = (seen.get("feedback/journeys") as { rows: Array<{ id: string; cells: { stage: string } }> }).rows.map((r) => [r.id, r.cells.stage])
      yield* h.invoke("backlog", "assign", { journey: "Set up", worker: "triage-1" })
      yield* press("open")
      const working = (seen.get("feedback/journeys") as { rows: Array<{ id: string; cells: { stage: string } }> }).rows.map((r) => [r.id, r.cells.stage])
      const flip = (yield* h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: ids })) as { notice: string }
      const noted = (yield* h.invoke("backlog", "act", { agent: "feedback", action: "note", rows: other, text: "x" })) as { notice: string }
      const still = ((yield* h.invoke("backlog", "status", { ids })) as Array<{ on: boolean }>)[0]!.on
      // Feedback filed after the round started is not in it: usable, for the next round.
      const { ids: later } = (yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "transition", severity: "low", note: "Filed later.", from: { agent: "rehearse", run: "r-2" }, triage: { on: true, why: "fix" } }] })) as { ids: string[] }
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "journey", rows: ["Set up"] })
      const shown = rows(seen).map((r) => [r.id === later[0] ? "later" : "round", (r as { readonly?: boolean }).readonly === true, (r as { cells?: Record<string, string> }).cells?.status])
      const flipLater = (yield* h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: later })) as { notice: string }
      return { queued, working, flip: flip.notice, noted: noted.notice, still, shown, flipLater: flipLater.notice }
    }))
    expect(out.queued).toEqual([["Reconcile", "queued #2"], ["Set up", "queued #1"]])
    expect(out.working).toEqual([["Reconcile", "queued #1"], ["Set up", "triage-1 · Refine 0/1 cards"]])
    expect(out.flip).toBe("in Set up's triage round: read-only until Plan")
    expect(out.noted).toBe("in Reconcile's triage round: read-only until Plan")
    expect(out.still).toBe(true)
    expect(out.shown.sort()).toEqual([["later", false, ""], ["round", true, "waiting"]])
    expect(out.flipLater).toBe("1 entry flipped")
  })
  test("counts read as words: entries, not entrys", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const { card } = yield* setUp()
      const h = yield* PluginHost
      yield* h.invoke("backlog", "file", { entries: [{ ref: card.ref, journeys: ["Set up"], persona: "Operator", kind: "friction", severity: "low", note: "A second.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix" } }] })
      yield* press("open")
      return stage(seen)
    }))
    expect(out).toContain("2 entries · 2 on")
    expect(out).not.toContain("entrys")
  })
})
