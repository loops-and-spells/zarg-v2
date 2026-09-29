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
      const row = rows(seen, "feedback")[0]!
      return { row, detail: (seen.get("feedback/detail") as { rows: Record<string, string> }).rows[row.id]!, status: yield* h.invoke("backlog", "status", { ids }) }
    }))
    expect(out.row.on).toBe(false)
    // Why it is off is in the detail beside the list, not a column.
    expect(Object.keys(out.row.cells)).toEqual(["card", "severity", "kind", "note", "status"])
    expect(out.detail).toContain("off (your call: fix · real 0.80)")
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
  test("an entry file of the wrong shape, or whose id is not its name, is skipped (named on the agenda); the view still fills", async () => {
    const out = await run((seen, root) => Effect.gen(function* () {
      const card = yield* setUp
      mkdirSync(join(root, ".zarg/feedback"), { recursive: true })
      writeFileSync(join(root, ".zarg/feedback/F-0000abcd.json"), JSON.stringify({ id: "F-0000abcd", ref: card.ref, note: "n", triage: { on: true }, journeys: ["Set up"] }))
      writeFileSync(join(root, ".zarg/feedback/F-1111abcd.json"), JSON.stringify({ ...report(card.ref, "copied"), id: "F-2222abcd", count: 1, triage: { on: true, why: "w", by: "agent" } }))
      const h = yield* PluginHost
      yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })
      const notice = yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { notice, feedback: rows(seen, "feedback"), detail: seen.get("feedback/detail"), agenda: (yield* h.agenda()).map((i) => i.id) }
    }))
    expect(out.feedback.length).toBe(1)
    expect(out.detail).toBeDefined()
    expect(out.agenda).toEqual(expect.arrayContaining(["backlog:bad-file:F-0000abcd.json", "backlog:bad-file:F-1111abcd.json"]))
  })
  test("reports filed at once all count; a flip while a file lands keeps the operator's call", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      const file = (run: string) => h.invoke("backlog", "file", { entries: [{ ...report(card.ref), from: { agent: "rehearse", run } }] })
      const { ids } = (yield* file("r-0")) as { ids: string[] }
      yield* Effect.all([file("r-1"), h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: ids }), file("r-2")], { concurrency: "unbounded" })
      const e = yield* h.entities.get(`backlog/feedback:${ids[0]}`)
      return e.data as { count: number; triage: { on: boolean; by: string } }
    }))
    expect(out.count).toBe(3)
    expect([out.triage.on, out.triage.by]).toEqual([false, "operator"])
  })
  test("one run filing the same report again (a restart) does not count it twice; a ref without a version is refused, the rest filed", async () => {
    const out = await run(() => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "file", { entries: [report(card.ref)] })
      const again = (yield* h.invoke("backlog", "file", { entries: [report(card.ref), report("gherkin/card:UX-0001", "no version")] })) as { ids: string[] }
      const e = yield* h.entities.get(`backlog/feedback:${again.ids[0]}`)
      return { ids: again.ids, count: (e.data as { count: number }).count }
    }))
    expect(out.count).toBe(1)
    expect(out.ids[1]).toBe("")
  })
  test("a toggle among 200 entries on 60 cards answers quickly (staleness and context once per card, not per entry)", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      yield* setUp
      const h = yield* PluginHost
      for (let i = 2; i <= 60; i++) yield* gherkin("add-card", { title: `Operator does thing ${i}`, when: `the operator does thing ${i}`, by: [{ id: "P-0001" }], arrives: { id: "S-0001" }, then: [{ text: `thing ${i} is done` }] })
      const refs = yield* Effect.forEach(Array.from({ length: 60 }, (_, i) => `gherkin/card:UX-${String(i + 1).padStart(4, "0")}`), (r) => Effect.map(h.entities.get(r), (e) => e.ref))
      yield* h.invoke("backlog", "file", { entries: Array.from({ length: 200 }, (_, i) => report(refs[i % 60]!, `Report number ${i}.`)) })
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      const id = rows(seen, "feedback")[0]!.id
      const start = performance.now()
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: [id] })
      return { ms: performance.now() - start, row: rows(seen, "feedback").find((r) => r.id === id)! }
    }))
    expect(out.row.on).toBe(false)
    expect(out.ms).toBeLessThan(500)
  }, 60000)
  test("a journey shows its own feedback; opening the view again starts on the first journey, where the cursor is", async () => {
    const out = await run((seen) => Effect.gen(function* () {
      const card = yield* setUp
      const h = yield* PluginHost
      yield* h.invoke("backlog", "file", { entries: [{ ...report(card.ref, "In A."), journeys: ["A"] }, { ...report(card.ref, "In B."), journeys: ["B"] }] })
      // The note is in the detail beside the list, not a column.
      const shown = () => rows(seen, "feedback").map((r) => ((seen.get("feedback/detail") as { rows: Record<string, string> }).rows[r.id]!.match(/In [AB]\./) ?? [""])[0])
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      const first = shown()
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "journey", section: "journeys", rows: ["B"] })
      const b = shown()
      yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
      return { first, b, again: shown() }
    }))
    expect(out).toEqual({ first: ["In A."], b: ["In B."], again: ["In A."] })
  })
})
