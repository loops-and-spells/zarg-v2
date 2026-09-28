import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
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

describe("the triage hub's stages", () => {
  test("Refine with nothing on is refused; other buttons out of their stage say why", async () => {
    const out = await run(() => Effect.gen(function* () {
      yield* setUp(false)
      return [(yield* press("refine")).notice, (yield* press("accept")).notice, (yield* press("backlog")).notice]
    }))
    expect(out).toEqual(["nothing on in Set up: turn feedback on first", "Set up is in Triage: nothing to accept", "Set up has no plan to backlog yet"])
  })
  test("a journey goes through Refine (the agent's proposals, the operator's calls), Re-rehearse and Plan, to a plan on the Backlog", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const { ids } = yield* setUp()
      const h = yield* PluginHost
      const refine = (yield* press("refine")).notice
      const waiting = work(seen)
      const early = (yield* press("accept")).notice
      yield* h.invoke("backlog", "propose", { journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator is asked: once, always, deny" } }], answers: ids, summary: "Name the choices." })
      yield* press("open")
      const proposal = work(seen)
      const accepted = (yield* press("accept")).notice
      const afterAccept = stage(seen)
      const stages = (yield* h.invoke("backlog", "stages", {})) as Array<{ stage: string; draft: unknown[] }>
      yield* h.invoke("backlog", "rehearsed", { journey: "Set up", resolved: ids, fresh: [], next: "plan", cards: ["S-0002", "UX-0001"] })
      yield* h.invoke("backlog", "drafted", { journey: "Set up", title: "Grant prompt names its choices", steps: ["Name the choices"] })
      yield* press("open")
      const plan = work(seen)
      const backlogged = (yield* press("backlog")).notice
      const item = yield* h.entities.get("backlog/item:B-01")
      return { refine, waiting, early, proposal, accepted, afterAccept, stages, plan, backlogged, item: item.data as { changes: unknown[]; cards: Array<{ ref: string }>; feedback: string[]; status: string }, file: existsSync(join(root, ".zarg/triage/set-up.json")), status: yield* h.invoke("backlog", "status", { ids }), ids }
    }))
    expect(out.refine).toBe("Set up: refining 1 card")
    expect(out.waiting).toContain("The Triage Agent is drafting a proposal for UX-0001")
    expect(out.early).toBe("the Triage Agent is still drafting UX-0001's proposal")
    expect(out.proposal).toContain("Name the choices.")
    expect(out.proposal).toContain("gherkin/edit-state")
    expect(out.accepted).toBe("Set up: accepted UX-0001; re-rehearsing next")
    expect(out.afterAccept).toContain("● Re-rehearse")
    expect(out.stages).toEqual([expect.objectContaining({ stage: "rehearse", draft: [expect.anything()] })])
    expect(out.plan).toContain("Grant prompt names its choices")
    expect(out.backlogged).toBe("Set up: backlogged as B-01")
    expect(out.item.status).toBe("ready")
    expect(out.item.cards.map((c) => c.ref.split("@")[0])).toEqual(["gherkin/card:UX-0001"])
    expect(out.item.feedback).toEqual(out.ids)
    expect(out.file).toBe(true)
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("planned")
  })
})
