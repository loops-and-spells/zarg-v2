import { describe, expect, test } from "bun:test"
import { entryId, stateOf, upsert } from "../src/feedback"

const filed = (over: Record<string, unknown> = {}) => ({
  ref: "gherkin/card:UX-0062@3f9a1c20b7e4",
  journeys: ["Set up"],
  persona: "Operator",
  kind: "gap",
  severity: "medium" as const,
  note: "No path when  the operator denies.",
  from: { agent: "rehearse", run: "r-1" },
  triage: { on: true, why: "fix · real 0.80" },
  ...over,
})

describe("feedback entries", () => {
  test("the id is stable for one report on one card version, and differs across versions", () => {
    expect(entryId(filed())).toBe(entryId(filed({ note: "no path when the operator denies." })))
    expect(entryId(filed())).not.toBe(entryId(filed({ ref: "gherkin/card:UX-0062@000000000000" })))
    expect(entryId(filed())).toMatch(/^F-[0-9a-f]{8}$/)
  })
  test("the same report twice is one entry, count 2; the operator's toggle is kept", () => {
    const first = upsert(undefined, filed())
    const flipped = { ...first, triage: { on: false, why: first.triage.why, by: "operator" as const } }
    const again = upsert(flipped, filed({ triage: { on: true, why: "fix · real 0.90" }, journeys: ["Reconcile"], from: { agent: "rehearse", run: "r-2" } }))
    expect([again.count, again.triage.on, again.triage.by]).toEqual([2, false, "operator"])
    expect(again.journeys).toEqual(["Set up", "Reconcile"])
  })
  test("the agent's call is replaced when the operator never flipped it", () => {
    const again = upsert(upsert(undefined, filed()), filed({ triage: { on: false, why: "drop · real 0.10" } }))
    expect(again.triage).toEqual({ on: false, why: "drop · real 0.10", by: "agent" })
  })
  test("states: open, stale when its entity changed, planned and closed as recorded", () => {
    const e = upsert(undefined, filed())
    expect([stateOf(e, false), stateOf(e, true), stateOf({ ...e, state: "planned" }, true), stateOf({ ...e, state: "closed" }, false)]).toEqual(["open", "stale", "planned", "closed"])
  })
})

test("a note is one line of words: a model's newlines and runs of spaces are collapsed when it is filed", () => {
  const f = { ref: "gherkin/card:UX-0016@abc", journeys: ["Talk"], persona: "Operator", kind: "feature", severity: "medium" as const, note: "I\n would\n want   a\tconflict\n resolution.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "ask" } }
  expect(upsert(undefined, f).note).toBe("I would want a conflict resolution.")
})
