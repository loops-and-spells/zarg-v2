import { describe, expect, test } from "bun:test"
import { defineView, highlightActs, initialViewUi, layoutOf, type ViewState } from "../src"

const view = (highlight: boolean): ViewState => ({
  agent: "backlog:feedback",
  layout: layoutOf(defineView("t", {
    list: { kind: "table", role: "primary", columns: [{ id: "c", label: "c" }], actions: [{ id: "show", label: "Show", on: "row", default: true, ...(highlight ? { highlight: true } : {}) }] },
    other: { kind: "table", role: "pinned", columns: [{ id: "c", label: "c" }] },
  })),
  data: { list: { rows: [{ id: "a", cells: { c: "A" } }, { id: "b", cells: { c: "B" } }] }, other: { rows: [{ id: "x", cells: { c: "X" } }] } },
})

describe("actions that follow the cursor", () => {
  test("a highlight action names the table's highlighted row", () => {
    expect(highlightActs(view(true), { ...initialViewUi, rows: { list: 1 } })).toEqual([{ section: "list", action: "show", rows: ["b"] }])
  })
  test("tables without one ask for nothing", () => {
    expect(highlightActs(view(false), { ...initialViewUi, rows: { list: 1 } })).toEqual([])
  })
})
