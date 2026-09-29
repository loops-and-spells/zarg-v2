import { describe, expect, test } from "bun:test"
import { defineView, initialViewUi, layoutOf, toggleAct, type ViewState } from "../src"

const view = (toggle: boolean): ViewState => ({
  agent: "backlog:feedback",
  layout: layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "c", label: "c" }], ...(toggle ? { toggle: true } : { selectable: true }) } })),
  data: { list: { rows: [{ id: "a", cells: { c: "A" }, on: true }, { id: "b", cells: { c: "B" }, on: false }] } },
})

describe("toggle tables", () => {
  test("space on a toggle table flips the highlighted row through the plugin", () => {
    expect(toggleAct(view(true), { ...initialViewUi, rows: { list: 1 } })).toEqual({ section: "list", action: "toggle", rows: ["b"] })
  })
  test("a table that is not a toggle table has no toggle", () => {
    expect(toggleAct(view(false), initialViewUi)).toBeUndefined()
  })
})

describe("read-only rows", () => {
  test("a read-only row flips nothing; the others still do", () => {
    const v: ViewState = { ...view(true), data: { list: { rows: [{ id: "a", cells: { c: "A" }, on: true }, { id: "b", cells: { c: "B" }, on: true, readonly: true }] } } }
    expect(toggleAct(v, { ...initialViewUi, rows: { list: 1 } })).toBeUndefined()
    expect(toggleAct(v, { ...initialViewUi, rows: { list: 0 } })).toEqual({ section: "list", action: "toggle", rows: ["a"] })
  })
})
