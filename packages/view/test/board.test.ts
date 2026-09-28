import { describe, expect, test } from "bun:test"
import { boardKey, checkSet, defineView, initialViewUi, layoutOf, type ViewState, type ViewUi } from "../src"

const layout = layoutOf(defineView("backlog", { board: { kind: "board", role: "primary", title: "" } }))
const card = (id: string) => ({ id, title: `item ${id}` })
const view = (lanes: ReadonlyArray<{ id: string; cards: ReadonlyArray<string> }>): ViewState => ({
  agent: "backlog:backlog",
  layout,
  data: { board: { lanes: lanes.map((l) => ({ id: l.id, title: l.id, cards: l.cards.map(card) })) } },
})
const v = view([{ id: "backlog", cards: ["B-1", "B-2"] }, { id: "ready", cards: ["B-3"] }, { id: "running", cards: [] }])
const press = (ui: ViewUi, name: string, shift = false) => boardKey(v, ui, { name, ...(shift ? { shift: true } : {}) })!
const at = (lane: number, card: number, folded: ReadonlyArray<string> = []): ViewUi => ({ ...initialViewUi, board: { board: { lane, card, folded } } })

describe("boards", () => {
  test("board data fits its section", () => {
    expect(checkSet(layout, "board", v.data.board).ok).toBe(true)
    expect(checkSet(layout, "board", { lanes: [{ id: "x" }] }).ok).toBe(false)
  })
  test("arrows move between lanes and cards, clamped to what is there", () => {
    expect(press(at(0, 0), "down").ui.board!.board).toEqual({ lane: 0, card: 1, folded: [] })
    expect(press(at(0, 1), "down").ui.board!.board).toEqual({ lane: 0, card: 1, folded: [] })
    expect(press(at(0, 1), "right").ui.board!.board).toEqual({ lane: 1, card: 0, folded: [] })
    expect(press(at(2, 0), "right").ui.board!.board).toEqual({ lane: 2, card: 0, folded: [] })
    expect(press(at(1, 0), "left").ui.board!.board).toEqual({ lane: 0, card: 0, folded: [] })
  })
  test("z folds the lane under the cursor (the cursor stays on its strip); Enter there unfolds it", () => {
    const folded = press(at(1, 0), "z").ui
    expect(folded.board!.board).toEqual({ lane: 1, card: 0, folded: ["ready"] })
    expect(press(folded, "return")).toEqual({ ui: at(1, 0) })
    expect(press(at(1, 0, ["ready"]), "z").ui.board!.board!.folded).toEqual([])
  })
  test("Z folds every other lane; again, unfolds them all", () => {
    const one = press(at(0, 0), "z", true).ui
    expect(one.board!.board!.folded).toEqual(["ready", "running"])
    expect(press(one, "z", true).ui.board!.board!.folded).toEqual([])
  })
  test("Enter on a card opens it; shift+arrows move it through the plugin", () => {
    expect(press(at(0, 1), "return").act).toEqual({ section: "board", action: "item", rows: ["B-2"] })
    expect(press(at(1, 0), "right", true).act).toEqual({ section: "board", action: "move-right", rows: ["B-3"] })
    expect(press(at(1, 0), "left", true).act).toEqual({ section: "board", action: "move-left", rows: ["B-3"] })
    expect(press(at(2, 0), "return").act).toBeUndefined()
  })
  test("a cursor past a lane that emptied comes back to its last card", () => {
    expect(press(at(0, 9), "down").ui.board!.board).toEqual({ lane: 0, card: 1, folded: [] })
  })
  test("keys on a view whose focused section is not a board are not the board's", () => {
    const t: ViewState = { agent: "x", layout: layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [] } })), data: {} }
    expect(boardKey(t, initialViewUi, { name: "z" })).toBeUndefined()
  })
})
