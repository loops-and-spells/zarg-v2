import { describe, expect, test } from "bun:test"
import { readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, run } from "./harness"

const setUp = Effect.gen(function* () {
  yield* gherkin("add-persona", { name: "Operator", kind: "human", text: "The person using zarg." })
  yield* gherkin("add-state", { text: "the plugin runs", entry: true })
  yield* gherkin("add-card", { title: "Plugin asks for a scope", when: "the plugin needs a scope", by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: "the operator is asked" }] })
  const h = yield* PluginHost
  return yield* h.entities.get("gherkin/card:UX-0001")
})
const report = (ref: string, note = "No path when the operator denies.") => ({
  ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "medium", note, from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix · real 0.80" },
})
const rows = (seen: Map<string, unknown>, section: string) => ((seen.get(`feedback/${section}`) as { rows: Array<{ id: string; on?: boolean; cells: Record<string, string> }> } | undefined)?.rows ?? [])

describe("the backlog's feedback", () => {
  test("the same report twice is one file; the Feedback view lists its journey and the entry, on", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      const a = (yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })) as { ids: string[] }
      const b = (yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })) as { ids: string[] }
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { a, b, files: readdirSync(join(root, ".zarg/feedback")), journeys: rows(seen, "journeys"), feedback: rows(seen, "feedback") }
    }))
    expect(out.a.ids).toEqual(out.b.ids)
    expect(out.files).toEqual([`${out.a.ids[0]}.json`])
    expect(out.journeys.map((r) => [r.id, r.cells.open, r.cells.stage])).toEqual([["Set up", "1", "Triage"]])
    expect(out.feedback.map((r) => [r.id, r.on, r.cells.card])).toEqual([[out.a.ids[0], true, "gherkin/card:UX-0001"]])
  })
  test("flipping an entry is the operator's call, kept", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      const { ids } = (yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })) as { ids: string[] }
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: ids })
      yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { row: rows(seen, "feedback")[0]!, status: yield* h.invoke("backlog", "status", { ids }) }
    }))
    expect(out.row.on).toBe(false)
    expect(out.row.cells.why).toMatch(/^you:/)
    expect(out.status).toEqual([{ id: out.row.id, state: "open", on: false }])
  })
  test("a changed card makes its feedback stale: it leaves the Feedback view", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      const { ids } = (yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })) as { ids: string[] }
      yield* gherkin("edit-state", { id: "S-0002", text: "the operator is asked once" })
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { feedback: rows(seen, "feedback"), status: yield* h.invoke("backlog", "status", { ids }) }
    }))
    expect(out.feedback).toEqual([])
    expect((out.status as Array<{ state: string }>)[0]!.state).toBe("stale")
  })
  test("a broken entry file is skipped; feedback is an entity with a label", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const card = yield* setUp
      mkdirSync(join(root, ".zarg/feedback"), { recursive: true })
      writeFileSync(join(root, ".zarg/feedback/F-broken.json"), "{}")
      const h = yield* PluginHost
      const { ids } = (yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })) as { ids: string[] }
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { feedback: rows(seen, "feedback"), e: yield* h.entities.get(`backlog/feedback:${ids[0]}`) }
    }))
    expect(out.feedback.length).toBe(1)
    expect(out.e.label).toEqual({ text: "gap on UX-0001: No path when the operator denies.", tone: "attention", glyph: "◇" })
  })
})
