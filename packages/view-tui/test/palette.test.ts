import { describe, expect, test } from "bun:test"
import { initial, type RlmNode, type SessionState } from "@zarg/client"
import { onKey } from "../src/layers"
import { paletteEntries } from "../src/palette"
import { initialUi, syncUi, type Ui } from "../src/view"

const node = (id: string, preset = "tester"): RlmNode => ({ id, parent: null, preset, depth: 0, turns: 0, budget: 1, status: "running", decisions: [] })
const s: SessionState = { thread: { ...initial("main"), rlms: { "p:tester-1": node("p:tester-1"), "p:tester-2": node("p:tester-2"), zarg: node("zarg", "zarg") } }, core: "up" }
const commands = [{ cmd: "/rehearse", desc: "testers walk the journeys" }, { cmd: "/yolo", desc: "YOLO on or off" }]

describe("the palette", () => {
  test("agents, then the inbox, the agents grid, review and zarg, then commands; the query filters them", () => {
    expect(paletteEntries(s, "", commands).map((e) => e.label)).toEqual(["tester-1", "tester-2", "inbox", "agents", "review", "zarg", "/rehearse", "/yolo"])
    expect(paletteEntries(s, "TES", commands).map((e) => e.label)).toEqual(["tester-1", "tester-2"])
    expect(paletteEntries(s, "nothing like it", commands)).toEqual([])
  })
  test("ctrl+k opens it from any focus; the palette owns printable keys", () => {
    const ui: Ui = { ...syncUi(initialUi, s), focus: "agents" }
    let r = onKey(ui, s, { name: "k", ctrl: true }, 0)
    expect(r.ui.palette).toEqual({ query: "", pick: 0 })
    for (const name of ["g", "/", "x", "a"]) {
      r = onKey(r.ui, s, { name }, 0)
      expect([name, r.action, r.by]).toEqual([name, undefined, "palette"])
    }
    expect(r.ui.palette?.query).toBe("g/xa")
    r = onKey(r.ui, s, { name: "backspace" }, 0)
    expect(r.ui.palette?.query).toBe("g/x")
    expect(onKey(r.ui, s, { name: "escape" }, 0).ui.palette).toBeUndefined()
  })
  test("a plugin's view (a nav item) is found by its name and opens as its rail row does", () => {
    const withNav: SessionState = { ...s, thread: { ...s.thread, nav: [{ id: "backlog", label: "Feedback", view: "feedback" }] as never } }
    expect(paletteEntries(withNav, "feed", commands).map((e) => e.label)).toEqual(["Feedback"])
    const r = onKey({ ...syncUi(initialUi, withNav), palette: { query: "feed", pick: 0 } }, withNav, { name: "return" }, 0)
    expect(r.ui).toMatchObject({ main: "agent", viewing: "feedback" })
    expect(r.ui.palette).toBeUndefined()
    expect(r.action).toMatchObject({ type: "act", agent: "backlog", action: "open", view: "feedback" })
  })
  test("⏎ goes: an agent opens, a command runs", () => {
    let ui: Ui = { ...syncUi(initialUi, s), palette: { query: "tester-2", pick: 0 } }
    const went = onKey(ui, s, { name: "return" }, 0).ui
    expect(went).toMatchObject({ main: "agent", viewing: "p:tester-2" })
    expect(went.palette).toBeUndefined()
    ui = { ...ui, palette: { query: "review", pick: 0 } }
    expect(onKey(ui, s, { name: "return" }, 0).ui).toMatchObject({ main: "review", sheet: false })
  })
})
