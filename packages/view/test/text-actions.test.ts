import { describe, expect, test } from "bun:test"
import { actionFor, defineView, enabledActions, initialViewUi, inputKey, layoutOf, pressAction, type ViewState } from "../src"

const view = (enabled?: ReadonlyArray<string>): ViewState => ({
  agent: "backlog:feedback",
  layout: layoutOf(defineView("t", {
    list: {
      kind: "table", role: "primary", columns: [{ id: "c", label: "c" }],
      actions: [{ id: "refine", label: "Refine", key: "r", on: "none" }, { id: "accept", label: "Accept", key: "a", on: "none" }, { id: "note", label: "Note", key: "n", on: "row", input: "your note" }],
    },
  })),
  data: { list: { rows: [{ id: "a", cells: { c: "A" }, text: "was here" }, { id: "b", cells: { c: "B" } }], ...(enabled !== undefined ? { actions: enabled } : {}) } },
})

describe("the actions a table offers now", () => {
  test("every action when the data names none; only those named when it does", () => {
    expect(enabledActions(view(), "list").map((a) => a.id)).toEqual(["refine", "accept", "note"])
    expect(enabledActions(view(["refine", "note"]), "list").map((a) => a.id)).toEqual(["refine", "note"])
  })
  test("a key for an action the table does not offer now does nothing", () => {
    expect(actionFor(view(["refine"]), initialViewUi, "a")).toBeUndefined()
    expect(actionFor(view(["refine"]), initialViewUi, "r")).toEqual({ section: "list", action: "refine", rows: [] })
  })
})

describe("actions that ask for a line of text", () => {
  test("pressing one opens its input on the row's text; typing edits it; Enter sends it with the text", () => {
    const opened = pressAction(view(), initialViewUi, "list", "note", ["a"])
    expect(opened.act).toBeUndefined()
    expect(opened.ui.input).toEqual({ section: "list", action: "note", rows: ["a"], text: "was here", placeholder: "your note" })
    let ui = opened.ui
    for (const k of ["backspace", "backspace", "backspace", "backspace", "o", "k"]) ui = inputKey(ui, { name: k })!.ui
    expect(ui.input?.text).toBe("was ok")
    const sent = inputKey(ui, { name: "return" })!
    expect(sent.ui.input).toBeUndefined()
    expect(sent.act).toEqual({ section: "list", action: "note", rows: ["a"], text: "was ok" })
  })
  test("a capital typed with Shift stays a capital", () => {
    let ui = pressAction(view(), initialViewUi, "list", "note", ["a"]).ui
    for (let i = 0; i < 8; i++) ui = inputKey(ui, { name: "backspace" })!.ui
    for (const k of [{ name: "o", shift: true }, { name: "k" }, { name: "?", shift: true }]) ui = inputKey(ui, k)!.ui
    expect(ui.input?.text).toBe("Ok?")
  })
  test("Esc closes the input and sends nothing", () => {
    const r = inputKey(pressAction(view(), initialViewUi, "list", "note", ["b"]).ui, { name: "escape" })!
    expect(r.ui.input).toBeUndefined()
    expect(r.act).toBeUndefined()
  })
  test("an action without input acts at once", () => {
    expect(pressAction(view(), initialViewUi, "list", "refine", [])).toEqual({ ui: initialViewUi, act: { section: "list", action: "refine", rows: [] } })
  })
})
