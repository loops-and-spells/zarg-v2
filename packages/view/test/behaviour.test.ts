import { describe, expect, test } from "bun:test"
import { actionFor, applyMenu, closeMenu, defineView, focusNext, initialViewUi, layoutOf, menuEntries, menuMove, moveColumn, moveRow, nextTab, cursorRow, filterOf, followedText, pickTab, menuAdjust, menuQuery, openMenu, ordered, pickHeader, pickMark, pickRow, shownRows, startUi, toggleSelect, type ViewState, type ViewUi } from "../src"

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

  test("a view opens with its first table that has actions focused, so rows can be picked at once", () => {
    expect(startUi(view).focus).toBe(2)
    const plain: ViewState = { agent: "p", layout: layoutOf(defineView("plain", { steps: { kind: "log", role: "log" } })), data: {} }
    expect(startUi(plain).focus).toBe(0)
  })

  test("picking a row (a click or a tap) focuses its section, moves the cursor there and toggles it", () => {
    // A click on a row only moves the cursor there; a click on its mark ticks it.
    let ui = pickRow(view, initialViewUi, "review", 2)
    expect(ui.focus).toBe(2)
    expect(ui.rows["review.findings"]).toBe(2)
    expect(ui.selected["review.findings"] ?? []).toEqual([])
    ui = pickMark(view, ui, "review", 1)
    expect(ui.rows["review.findings"]).toBe(1)
    expect(ui.selected["review.findings"]).toEqual(["R-2"])
    ui = pickMark(view, ui, "review", 1)
    expect(ui.selected["review.findings"]).toEqual([])
  })
})

test("a view-level action fires from any section; keys.terminal works like key", () => {
  const view = {
    agent: "a",
    layout: {
      name: "v",
      sections: [{ id: "t", kind: "table" as const, role: "primary" as const, columns: [], actions: [{ id: "apply", label: "Apply", keys: { terminal: "a" }, on: "row" as const }] }, { id: "log", kind: "log" as const, role: "log" as const }],
      actions: [{ id: "rerun", label: "Rerun", keys: { terminal: "r" }, on: "none" as const }],
    },
    data: { t: { rows: [{ id: "r1", cells: {} }] } },
  }
  // ordered: the primary table (0), then the log (1).
  expect(actionFor(view, { ...initialViewUi, focus: 1 }, "r")).toEqual({ section: undefined, action: "rerun", rows: [] })
  expect(actionFor(view, { ...initialViewUi, focus: 0 }, "a")).toEqual({ section: "t", action: "apply", rows: ["r1"] })
  expect(actionFor(view, { ...initialViewUi, focus: 0 }, "a", "web")).toBeUndefined()
})

describe("column header menus", () => {
  const cols = [{ id: "id", label: "id" }, { id: "sev", label: "severity", order: ["high", "medium", "low"] }, { id: "kind", label: "kind" }]
  const t: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { findings: { kind: "table", role: "pinned", columns: cols, selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }, { id: "open", label: "Open", key: "o", on: "row" }] } })),
    data: {
      findings: {
        rows: [
          { id: "F1", cells: { id: "F1", sev: "low", kind: "gap" } },
          { id: "F2", cells: { id: "F2", sev: "high", kind: "nit" } },
          { id: "F3", cells: { id: "F3", sev: "medium", kind: "gap" } },
          { id: "F10", cells: { id: "F10", sev: "high", kind: "gap" } },
        ],
      },
    },
  }
  const ids = (ui: ViewUi) => shownRows(t, ui, "findings").map((r) => r.id)
  test("↑ from the first row reaches the header; ←→ move its column; ↓ goes back to the rows", () => {
    let ui = startUi(t)
    ui = moveRow(t, ui, -1)
    expect(ui.header).toEqual({ path: "findings", col: 0 })
    ui = moveColumn(t, ui, 1)
    ui = moveColumn(t, ui, 5)
    expect(ui.header?.col).toBe(2)
    ui = moveRow(t, ui, 1)
    expect(ui.header).toBeUndefined()
    expect(ui.rows.findings ?? 0).toBe(0)
  })
  test("a sort from the menu orders the shown rows: a declared order, else numbers as numbers; again turns it off", () => {
    let ui = openMenu(t, startUi(t), "findings", 1)
    expect(menuEntries(t, ui).map((e) => (e.kind === "sort" ? `sort${e.dir}` : e.kind === "value" ? `${e.value} ${e.selected}/${e.total}` : e.kind))).toEqual(["sort1", "sort-1", "high 0/2", "medium 0/1", "low 0/1"])
    ui = applyMenu(t, ui, 0)
    expect(ids(ui)).toEqual(["F2", "F10", "F3", "F1"])
    ui = applyMenu(t, ui, 1)
    expect(ids(ui)).toEqual(["F1", "F3", "F2", "F10"])
    ui = applyMenu(t, ui, 1)
    expect(ids(ui)).toEqual(["F1", "F2", "F3", "F10"])
    ui = applyMenu(t, openMenu(t, ui, "findings", 0), 1)
    expect(ids(ui)).toEqual(["F10", "F3", "F2", "F1"])
  })
  test("a value in the menu selects every row with it; again (all selected) unselects them; ticks add up", () => {
    let ui = openMenu(t, startUi(t), "findings", 1)
    ui = applyMenu(t, ui, 2)
    expect(ui.selected.findings).toEqual(["F2", "F10"])
    ui = applyMenu(t, openMenu(t, ui, "findings", 2), 2)
    expect([...ui.selected.findings!].sort()).toEqual(["F1", "F10", "F2", "F3"])
    ui = applyMenu(t, openMenu(t, ui, "findings", 1), 2)
    expect([...ui.selected.findings!].sort()).toEqual(["F1", "F3"])
  })
  test("after a sort, the cursor and the actions follow the shown order", () => {
    let ui = applyMenu(t, openMenu(t, startUi(t), "findings", 1), 0)
    // Esc closes the menu with the cursor still on the header; ↓ goes back to the first row.
    ui = moveRow(t, closeMenu(ui), 1)
    expect(ui.header).toBeUndefined()
    expect(actionFor(t, ui, "o")?.rows).toEqual(["F2"])
    ui = moveRow(t, ui, 2)
    expect(actionFor(t, ui, "o")?.rows).toEqual(["F3"])
    ui = toggleSelect(t, ui)
    expect(ui.selected.findings).toEqual(["F3"])
  })
  test("the menu's cursor moves within its entries; a click on a header focuses its table and opens the menu", () => {
    let ui = openMenu(t, startUi(t), "findings", 2)
    ui = menuMove(t, ui, 10)
    expect(ui.menu?.pick).toBe(menuEntries(t, ui).length - 1)
    ui = pickHeader(t, { ...startUi(t), focus: 0 }, "findings", 1)
    expect(ui.menu).toEqual({ path: "findings", col: 1, pick: 0 })
    expect(ui.header).toEqual({ path: "findings", col: 1 })
  })
})

describe("column filters", () => {
  const cols = [
    { id: "id", label: "id", filter: "none" as const },
    { id: "kind", label: "kind" },
    { id: "score", label: "suggested", filter: { range: [0, 1] as const, step: 0.25 } },
    { id: "note", label: "note", filter: "search" as const },
    { id: "many", label: "many" },
  ]
  const rows = [
    { id: "F1", cells: { id: "F1", kind: "gap", score: "fix 0.9", note: "the card was declined at checkout", many: "a" } },
    { id: "F2", cells: { id: "F2", kind: "nit", score: "decide 0.3", note: "login copy unclear", many: "b" } },
    { id: "F3", cells: { id: "F3", kind: "gap", score: "fix 0.6", note: "no receipt after checkout", many: "c" } },
  ]
  const t: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { findings: { kind: "table", role: "pinned", columns: cols, selectable: true } })),
    data: { findings: { rows: [...rows, ...Array.from({ length: 9 }, (_, i) => ({ id: `X${i}`, cells: { id: `X${i}`, kind: "gap", score: "", note: "", many: `m${i}` } }))] } },
  }
  const kinds = (ui: ViewUi) => menuEntries(t, ui).map((e) => e.kind)
  const open = (col: number) => openMenu(t, startUi(t), "findings", col)
  test("each column's menu: sorts only, values, a range, a search; undeclared with over 10 values sorts only", () => {
    expect(filterOf(t, "findings", 0)).toBe("none")
    expect(kinds(open(0))).toEqual(["sort", "sort"])
    expect(filterOf(t, "findings", 1)).toBe("values")
    expect(kinds(open(1))).toEqual(["sort", "sort", "value", "value"])
    expect(kinds(open(2))).toEqual(["sort", "sort", "from", "to", "tick-range"])
    expect(kinds(open(3))).toEqual(["query", "sort", "sort", "match", "tick-matches"])
    expect(filterOf(t, "findings", 4)).toBe("none")
  })
  test("a range: ←→ move its bounds by the step within the column's range (from never past to); tick ticks the rows whose last number is inside", () => {
    let ui = menuMove(t, open(2), 2)
    ui = menuAdjust(t, ui, 1)
    ui = menuAdjust(t, ui, 1)
    expect(menuEntries(t, ui)[2]).toEqual({ kind: "from", value: 0.5 })
    ui = menuAdjust(t, menuMove(t, ui, 1), -1)
    expect(menuEntries(t, ui)[3]).toEqual({ kind: "to", value: 0.75 })
    expect(menuEntries(t, ui)[4]).toEqual({ kind: "tick-range", count: 1, selected: 0 })
    ui = applyMenu(t, ui, 4)
    expect(ui.selected.findings).toEqual(["F3"])
    ui = applyMenu(t, ui, 4)
    expect(ui.selected.findings).toEqual([])
    ui = menuMove(t, ui, -2)
    for (let i = 0; i < 10; i++) ui = menuAdjust(t, ui, -1)
    expect(menuEntries(t, ui)[2]).toEqual({ kind: "from", value: 0 })
  })
  test("a search: the query sorts the rows by match as it is typed; tick ticks the matches; a blank query ends the match sort", () => {
    let ui = menuQuery(t, open(3), "checkouts")
    expect(menuEntries(t, ui)[0]).toEqual({ kind: "query", text: "checkouts" })
    expect(shownRows(t, ui, "findings").slice(0, 2).map((r) => r.id).sort()).toEqual(["F1", "F3"])
    expect(ui.sort?.findings?.query).toBe("checkouts")
    expect(menuEntries(t, ui)[4]).toEqual({ kind: "tick-matches", count: 2, selected: 0 })
    ui = applyMenu(t, ui, 4)
    expect([...ui.selected.findings!].sort()).toEqual(["F1", "F3"])
    ui = menuQuery(t, ui, "  ")
    expect(ui.sort?.findings).toBeUndefined()
    expect(shownRows(t, ui, "findings")[0]!.id).toBe("F1")
  })
  test("the row under the cursor, for a platform's row card: none on the header or off a table", () => {
    const ui = startUi(t)
    expect(cursorRow(t, ui)?.row.id).toBe("F1")
    expect(cursorRow(t, moveRow(t, ui, -1))).toBeUndefined()
  })
})

describe("tabs", () => {
  const cols = [{ id: "id", label: "id" }, { id: "n", label: "note" }]
  const t: ViewState = {
    agent: "t",
    layout: layoutOf(
      defineView("t", {
        steps: { kind: "log", role: "log" },
        review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: cols, selectable: true }, likes: { kind: "table", columns: cols, selectable: true } } },
      }),
    ),
    data: { "review.findings": { rows: [{ id: "F1", cells: {} }] }, "review.likes": { rows: [{ id: "L1", cells: {} }, { id: "L2", cells: {} }] } },
  }
  test("a click on a tab: its section takes focus and shows that tab", () => {
    const ui = pickTab(t, initialViewUi, "review", 1)
    expect(ordered(t.layout)[ui.focus]!.id).toBe("review")
    expect(ui.tabs.review).toBe(1)
    expect(cursorRow(t, ui)?.row.id).toBe("L1")
  })
  test("on the header, ← past the first column and → past the last move between tabs, onto the new tab's header", () => {
    let ui = moveRow(t, pickTab(t, initialViewUi, "review", 0), -1)
    expect(ui.header).toEqual({ path: "review.findings", col: 0 })
    ui = moveColumn(t, ui, 1)
    ui = moveColumn(t, ui, 1)
    expect(ui.tabs.review ?? 0).toBe(1)
    expect(ui.header).toEqual({ path: "review.likes", col: 0 })
    ui = moveColumn(t, ui, -1)
    expect(ui.tabs.review).toBe(0)
    expect(ui.header).toEqual({ path: "review.findings", col: 1 })
    // At the ends of the tabs it stops.
    expect(moveColumn(t, { ...ui, header: { path: "review.findings", col: 0 } }, -1).tabs.review).toBe(0)
  })
})

test("Enter runs a table's default action on the highlighted row", () => {
  const t: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "name" }], actions: [{ id: "show", label: "Show", key: "s", on: "row", default: true }] } })),
    data: { list: { rows: [{ id: "J-1", cells: { name: "a" } }, { id: "J-2", cells: { name: "b" } }] } },
  }
  const ui = moveRow(t, startUi(t), 1)
  expect(actionFor(t, ui, "return")).toEqual({ section: "list", action: "show", rows: ["J-2"] })
  expect(actionFor(t, ui, "s")).toEqual({ section: "list", action: "show", rows: ["J-2"] })
})

test("a text that follows a table shows the text for the table's highlighted row (else its own)", () => {
  const t: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "name" }], actions: [{ id: "r", label: "Refresh", key: "r", on: "none" }] }, flow: { kind: "text", role: "pinned", follows: "list" } })),
    data: { list: { rows: [{ id: "J-1", cells: { name: "a" } }, { id: "J-2", cells: { name: "b" } }] }, flow: { markdown: "none picked", rows: { "J-1": "flow one", "J-2": "flow two" } } },
  }
  const ui = startUi(t)
  expect(followedText(t, ui, "flow")).toBe("flow one")
  expect(followedText(t, moveRow(t, ui, 1), "flow")).toBe("flow two")
  expect(followedText({ ...t, data: { ...t.data, flow: { markdown: "none picked" } } }, ui, "flow")).toBe("none picked")
})
