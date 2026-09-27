import { describe, expect, test } from "bun:test"
import { actionFor, defineView, focusNext, initialViewUi, layoutOf, moveRow, nextTab, ordered, toggleSelect, type ViewState } from "../src"

const layout = layoutOf(
  defineView("tester", {
    review: {
      kind: "tabs",
      role: "pinned",
      tabs: {
        findings: { kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }, { id: "open", label: "Open", key: "o", on: "row" }] },
        likes: { kind: "table", columns: [{ id: "id", label: "id" }] },
      },
    },
    steps: { kind: "log", role: "log" },
    progress: { kind: "stats", role: "summary" },
  }),
)
const view: ViewState = {
  agent: "t",
  layout,
  data: { "review.findings": { rows: [{ id: "R-1", cells: {} }, { id: "R-2", cells: {} }, { id: "R-3", cells: {} }] }, "review.likes": { rows: [{ id: "L-1", cells: {} }] } },
}

describe("view behaviour", () => {
  test("sections are ordered by role: summary, primary, log, aside, pinned", () => {
    expect(ordered(layout).map((s) => s.id)).toEqual(["progress", "steps", "review"])
  })

  test("focus cycles through sections both ways", () => {
    const f1 = focusNext(view, initialViewUi, 1)
    expect(f1.focus).toBe(1)
    expect(focusNext(view, f1, 1).focus).toBe(2)
    expect(focusNext(view, { ...initialViewUi, focus: 2 }, 1).focus).toBe(0)
    expect(focusNext(view, initialViewUi, -1).focus).toBe(2)
  })

  test("in a focused table: rows move, space selects, an action takes the selection or the highlighted row", () => {
    let ui = { ...initialViewUi, focus: 2 }
    ui = moveRow(view, ui, 1)
    expect(actionFor(view, ui, "a")).toEqual({ section: "review.findings", action: "apply", rows: ["R-2"] })
    ui = toggleSelect(view, ui)
    ui = moveRow(view, ui, 1)
    ui = toggleSelect(view, ui)
    expect(actionFor(view, ui, "a")).toEqual({ section: "review.findings", action: "apply", rows: ["R-2", "R-3"] })
    // A row action takes the highlighted row even with a selection.
    expect(actionFor(view, ui, "o")).toEqual({ section: "review.findings", action: "open", rows: ["R-3"] })
    expect(moveRow(view, ui, 10).rows["review.findings"]).toBe(2)
    expect(actionFor(view, ui, "z")).toBeUndefined()
  })

  test("tabs switch within the focused tabs section; the likes table has no actions", () => {
    const ui = nextTab(view, { ...initialViewUi, focus: 2 }, 1)
    expect(ui.tabs.review).toBe(1)
    expect(actionFor(view, ui, "a")).toBeUndefined()
    expect(nextTab(view, ui, 1).tabs.review).toBe(0)
  })

  test("an action sends only selected rows the table still has", () => {
    const ui = { ...initialViewUi, focus: 2, selected: { "review.findings": ["R-2", "R-9"] } }
    expect(actionFor(view, ui, "a")).toEqual({ section: "review.findings", action: "apply", rows: ["R-2"] })
  })
})
