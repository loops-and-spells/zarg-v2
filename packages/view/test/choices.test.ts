import { describe, expect, test } from "bun:test"
import { chooseKey, defineView, initialViewUi, layoutOf, pressAction, viewActions, type ViewState } from "../src"

const LANES = [{ id: "backlog", label: "Backlog" }, { id: "ready", label: "Ready" }, { id: "done", label: "Done" }]
const view = (offered?: ReadonlyArray<string>): ViewState => ({
  agent: "backlog:backlog@item",
  layout: layoutOf(defineView("item", { item: { kind: "text", role: "primary", title: "" } }, { actions: [{ id: "move", label: "Move", key: "m", on: "none", choices: LANES }, { id: "drop", label: "Drop", key: "X", on: "none" }, { id: "resync", label: "Resync", key: "s", on: "none" }] })),
  data: { item: { markdown: "B-01", ...(offered !== undefined ? { actions: offered } : {}) } },
})

describe("actions with choices", () => {
  test("pressing one drops its choices down; ↑↓ pick, Enter acts with the choice, Esc closes", () => {
    const opened = pressAction(view(), initialViewUi, undefined, "move", [])
    expect(opened.act).toBeUndefined()
    expect(opened.ui.choose).toEqual({ action: "move", rows: [], choices: LANES, pick: 0 })
    const down = chooseKey(opened.ui, { name: "down" })!.ui
    expect(chooseKey(down, { name: "return" })).toEqual({ ui: initialViewUi, act: { section: undefined, action: "move", rows: [], text: "ready" } })
    expect(chooseKey(down, { name: "escape" })).toEqual({ ui: initialViewUi })
  })
  test("a view's own actions: all of them, or those its text names now", () => {
    expect(viewActions(view()).map((a) => a.id)).toEqual(["move", "drop", "resync"])
    expect(viewActions(view(["move", "drop"])).map((a) => a.id)).toEqual(["move", "drop"])
  })
  test("a text inside tabs can name them too", () => {
    const tabbed: ViewState = {
      agent: "backlog:backlog@item",
      layout: layoutOf(defineView("item", { item: { kind: "tabs", role: "primary", tabs: { plan: { kind: "text", title: "Plan" }, agent: { kind: "text", title: "For agents" } } } }, { actions: [{ id: "move", label: "Move", on: "none" }, { id: "resync", label: "Resync", on: "none" }] })),
      data: { "item.plan": { markdown: "p", actions: ["move"] }, "item.agent": { markdown: "a" } },
    }
    expect(viewActions(tabbed).map((a) => a.id)).toEqual(["move"])
  })
})
