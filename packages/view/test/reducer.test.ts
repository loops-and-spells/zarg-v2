import { describe, expect, test } from "bun:test"
import { defineView, LOG_KEEP, layoutOf, reduceView, VIEW_ACTIVITY, type Views } from "../src"

const layout = layoutOf(defineView("tester", { progress: { kind: "stats", role: "summary" }, steps: { kind: "log", role: "log" }, review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: [{ id: "id", label: "id" }] } } } }))
const snap = (agent: string) => ({ type: "ACTIVITY_SNAPSHOT", activityType: VIEW_ACTIVITY, content: { agent, layout, data: {} } })
const delta = (agent: string, patch: ReadonlyArray<Record<string, unknown>>) => ({ type: "ACTIVITY_DELTA", activityType: VIEW_ACTIVITY, content: { agent }, patch })

describe("reduceView", () => {
  test("a snapshot then set and append deltas build the view", () => {
    let v: Views = {}
    v = reduceView(v, snap("rehearse:tester-1"))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "replace", path: "/data/progress", value: { items: [{ label: "steps", value: "1/2" }] } }]))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "add", path: "/data/steps/lines/-", value: { text: "a" } }, { op: "add", path: "/data/steps/lines/-", value: { text: "b" } }]))
    v = reduceView(v, delta("rehearse:tester-1", [{ op: "replace", path: "/data/review.findings", value: { rows: [{ id: "R-1", cells: { id: "R-1" } }] } }]))
    expect(v["rehearse:tester-1"]!.data).toEqual({
      progress: { items: [{ label: "steps", value: "1/2" }] },
      steps: { lines: [{ text: "a" }, { text: "b" }] },
      "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1" } }] },
    })
  })

  test("a delta for a view with no snapshot is ignored; other activities are not views", () => {
    expect(reduceView({}, delta("x", [{ op: "replace", path: "/data/progress", value: {} }]))).toEqual({})
    expect(reduceView({}, { type: "ACTIVITY_SNAPSHOT", activityType: "zarg.rlm", content: { rlms: {} } })).toEqual({})
  })

  test("a log keeps its last lines only", () => {
    let v = reduceView({}, snap("a"))
    const patch = Array.from({ length: LOG_KEEP + 5 }, (_, i) => ({ op: "add", path: "/data/steps/lines/-", value: { text: String(i) } }))
    v = reduceView(v, delta("a", patch))
    const lines = (v.a!.data.steps as { lines: ReadonlyArray<{ text: string }> }).lines
    expect(lines).toHaveLength(LOG_KEEP)
    expect(lines[0]!.text).toBe("5")
  })

  test("a new snapshot replaces the view (the agent started again)", () => {
    let v = reduceView({}, snap("a"))
    v = reduceView(v, delta("a", [{ op: "add", path: "/data/steps/lines/-", value: { text: "old" } }]))
    v = reduceView(v, snap("a"))
    expect(v.a!.data).toEqual({})
  })
})
