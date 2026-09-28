import { describe, expect, test } from "bun:test"
import { initial, type RlmNode, type SessionState } from "@zarg/client"
import { onKey } from "../src/layers"
import { reviewActs, reviewGroups } from "../src/review"
import { initialUi, syncUi, type Ui } from "../src/view"

const node = (id: string, status: "running" | "done" = "done"): RlmNode => ({ id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status, decisions: [] })
const findings = (rows: ReadonlyArray<string>, review = true) => ({
  layout: { name: "tester", sections: [{ id: "findings", kind: "table" as const, role: "primary" as const, columns: [{ id: "note", label: "note" }], selectable: true, review, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" as const }, { id: "dismiss", label: "Dismiss", key: "d", on: "selection" as const }] }] },
  data: { findings: { rows: rows.map((id) => ({ id, cells: { note: `note ${id}` } })) } },
})
const st = (extra: Partial<SessionState["thread"]> = {}): SessionState => ({
  thread: {
    ...initial("main"),
    rlms: { "p:a": node("p:a"), "p:b": node("p:b"), "p:c": node("p:c") },
    views: {
      "p:a": { agent: "p:a", ...findings(["R-1", "R-3"]) },
      "p:b": { agent: "p:b", ...findings(["R-2"]) },
      "p:c": { agent: "p:c", ...findings(["R-9"], false) },
    } as never,
    ...extra,
  },
  core: "up",
})

describe("the review queue", () => {
  test("every agent's review tables, grouped by agent; unmarked tables and archived agents stay out", () => {
    expect(reviewGroups(st()).map((g) => [g.agent, g.rows.map((r) => r.row.id)])).toEqual([["p:a", ["R-1", "R-3"]], ["p:b", ["R-2"]]])
    expect(reviewGroups(st({ archived: { "p:b": { reason: "x", at: 0 } } })).map((g) => g.agent)).toEqual(["p:a"])
  })
  test("an action with nothing selected acts on the cursor row", () => {
    expect(reviewActs(reviewGroups(st()), 2, [], "a")).toEqual([{ agent: "p:b", section: "findings", action: "apply", rows: ["R-2"] }])
  })
  test("selected rows of two agents make one act per agent", () => {
    const acts = reviewActs(reviewGroups(st()), 0, ["p:a|findings|R-1", "p:b|findings|R-2", "p:a|findings|R-3"], "a")
    expect(acts).toEqual([
      { agent: "p:a", section: "findings", action: "apply", rows: ["R-1", "R-3"] },
      { agent: "p:b", section: "findings", action: "apply", rows: ["R-2"] },
    ])
    expect(reviewActs(reviewGroups(st()), 0, [], "z")).toEqual([])
  })
  test("keys: space selects, a acts on the selection and clears it, ⏎ opens the agent", () => {
    const s = st()
    const ui: Ui = { ...syncUi(initialUi, s), main: "review", sheet: false, focus: "tile" }
    const sel = onKey(ui, s, { name: "space" }, 0)
    expect(sel.by).toBe("review")
    expect(sel.ui.review.selected).toEqual(["p:a|findings|R-1"])
    const down = onKey(sel.ui, s, { name: "down" }, 0).ui
    const acted = onKey(onKey(down, s, { name: "space" }, 0).ui, s, { name: "a" }, 0)
    expect(acted.action).toEqual({ type: "review-acts", acts: [{ agent: "p:a", section: "findings", action: "apply", rows: ["R-1", "R-3"] }] })
    expect(acted.ui.review.selected).toEqual([])
    expect(onKey(ui, s, { name: "return" }, 0).ui).toMatchObject({ main: "agent", viewing: "p:a" })
  })
})
