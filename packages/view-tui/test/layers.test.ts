import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { onKey, SHELL } from "../src/layers"
import { hintsOf, startUi } from "@zarg/view"
import { barLine, closeOverlays, INBOX_ROW, initialUi, panelsShown, POPOVER_GUARD_MS, queueOf, syncUi, type Ui } from "../src/view"

const inquiry: Inquiry = { id: "inq-1", question: "Which card first?", options: [{ id: "a", label: "Login" }, { id: "b", label: "Checkout", recommended: true }], allowOther: true, about: [] }
const grant = (id: string) => ({ id, question: `Plugin ${id} wants to load.`, options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }], kind: "grant" as const })
const idle: SessionState = { thread: { ...initial("main") }, core: "up" }
const asking: SessionState = { thread: { ...initial("main"), status: "waiting", pendingInquiry: inquiry }, core: "up" }
const withView: SessionState = { ...idle, thread: { ...idle.thread, views: { "rehearse:t1": { agent: "rehearse:t1", layout: { name: "t", sections: [{ id: "findings", kind: "table", role: "primary", columns: [{ id: "c", label: "C" }], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" }] }] }, data: { findings: { rows: [{ id: "r1", cells: { c: "x" } }] } } } } } }
const key = (name: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({ name, ...mods })
const at = (ui: Partial<Ui>): Ui => ({ ...initialUi, ...ui })

describe("the shell's layers", () => {
  test("the bar owns printable keys while typing", () => {
    for (const k of ["g", "x", "/", "[", "a", "space", "backspace"]) {
      const r = onKey(at({ focus: "bar" }), withView, key(k), 0, "hello")
      expect([k, r.by, r.action]).toEqual([k, "bar", undefined])
    }
  })
  test("Alt keys work while typing: Alt+left goes to the agents, alt+v to the view", () => {
    expect(onKey(at({ focus: "bar" }), idle, key("left", { meta: true }), 0).ui.focus).toBe("agents")
    expect(onKey(at({ focus: "bar", viewing: "rehearse:t1" }), withView, key("v", { meta: true }), 0).ui).toMatchObject({ focus: "tile", sheet: false })
  })
  test("alt+m focuses the bar; a second alt+m opens the sheet; while zarg asks, focusing the bar opens it at once", () => {
    const once = onKey(at({ focus: "agents", viewing: "rehearse:t1" }), withView, key("m", { meta: true }), 0).ui
    expect(once).toMatchObject({ focus: "bar", sheet: false })
    expect(onKey(once, withView, key("m", { meta: true }), 0).ui.sheet).toBe(true)
    expect(onKey(at({ focus: "agents", viewing: "rehearse:t1" }), asking, key("m", { meta: true }), 0).ui).toMatchObject({ focus: "bar", sheet: true })
  })
  test("/ from the agents list opens the bar with the slash typed", () => {
    expect(onKey(at({ focus: "agents" }), idle, key("/"), 0)).toMatchObject({ ui: { focus: "bar" }, draft: "/", by: "agents" })
  })
  test("the slash box takes ↑↓ only while open", () => {
    expect(onKey(at({ focus: "bar" }), idle, key("down"), 0, "/re").by).toBe("slash")
    expect(onKey(at({ focus: "bar" }), asking, key("down"), 0, "").by).toBe("picker")
  })
  test("a question never takes keys from another panel", () => {
    expect(onKey(at({ main: "agent", focus: "tile", viewing: "rehearse:t1" }), { ...withView, thread: { ...withView.thread, pendingInquiry: inquiry } }, key("down"), 0).by).toBe("view")
    expect(onKey(at({ focus: "agents" }), asking, key("down"), 0).by).toBe("agents")
  })
  test("a popover takes every key but the global ones", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [grant("p1")] } }
    expect(onKey(at({ focus: "bar" }), s, key("a"), 0, "").by).toBe("popover")
    expect(onKey(at({ focus: "bar" }), s, key("left", { meta: true }), 0).by).toBe("global")
    expect(onKey(at({ focus: "bar" }), s, key("return"), 0).action).toEqual({ type: "answer-prompt", id: "p1", choice: "always" })
  })
  test("the queue is strictly first in, first out: Esc never reorders it", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [grant("p1"), grant("p2")] } }
    const r = onKey(at({}), s, key("escape"), 0)
    expect(r.by).toBe("popover")
    expect(onKey(r.ui, s, key("return"), 0).action).toEqual({ type: "answer-prompt", id: "p1", choice: "always" })
  })
  test("PgUp scrolls zarg's sheet; Esc collapses it back to the view", () => {
    const ui = at({ main: "agent", focus: "tile", sheet: true, viewing: "rehearse:t1" })
    expect(onKey(ui, withView, key("pageup"), 0).action).toEqual({ type: "scroll-talk", delta: -10 })
    expect(onKey(ui, withView, key("escape"), 0).ui).toMatchObject({ sheet: false, viewing: "rehearse:t1" })
  })
  test("Enter on zarg's row opens zarg's focus; on another agent it opens its view and closes the sheet", () => {
    const rlms = { zarg: { id: "zarg", parent: null, preset: "zarg", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [] }, "rehearse:t1": { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [] } }
    const s = { ...withView, thread: { ...withView.thread, rlms } }
    expect(onKey(at({ focus: "agents", agents: { cursor: "zarg", toggled: {}, tree: 0 } }), s, key("return"), 0).ui).toMatchObject({ main: "zarg", focus: "tile" })
    expect(onKey(at({ focus: "agents", sheet: true, agents: { cursor: "rehearse:t1", toggled: {}, tree: 0 } }), s, key("return"), 0).ui).toMatchObject({ sheet: false, focus: "tile", viewing: "rehearse:t1" })
  })
  test("an agent's action key works only in its view", () => {
    const ui = at({ main: "agent", focus: "tile", viewing: "rehearse:t1" })
    expect(onKey(ui, withView, key("a"), 0).action).toMatchObject({ type: "act", action: "apply" })
    expect(onKey({ ...ui, focus: "agents" }, withView, key("a"), 0).action).toBeUndefined()
  })
  test("Ctrl-C once stops, twice exits; Ctrl-D exits", () => {
    const r = onKey(at({}), idle, key("c", { ctrl: true }), 1000)
    expect(r.action).toEqual({ type: "stop" })
    expect(onKey(r.ui, idle, key("c", { ctrl: true }), 1500).action).toEqual({ type: "exit" })
    expect(onKey(at({}), idle, key("d", { ctrl: true }), 0).action).toEqual({ type: "exit" })
  })
})

describe("a grant needs a deliberate press", () => {
  const two = { ...idle, thread: { ...idle.thread, prompts: [grant("p1"), grant("p2")] } }
  test("a second Enter on the same grant is not sent again while the answer is on its way", () => {
    const first = onKey(syncUi(at({}), two, 0), two, key("return"), 1000)
    expect(first.action).toEqual({ type: "answer-prompt", id: "p1", choice: "always" })
    expect(onKey(first.ui, two, key("return"), 1010).action).toBeUndefined()
  })
  test("Enter on a grant that just appeared waits a moment: a fast double Enter never approves the next one unread", () => {
    const next = { ...idle, thread: { ...idle.thread, prompts: [grant("p2")] } }
    const ui = syncUi(at({ popover: { id: "p1", pick: 0, answering: "p1" } }), next, 1000)
    expect(onKey(ui, next, key("return"), 1100).action).toBeUndefined()
    expect(onKey(ui, next, key("return"), 1000 + POPOVER_GUARD_MS).action).toEqual({ type: "answer-prompt", id: "p2", choice: "always" })
  })
})

describe("popovers and the core", () => {
  test("a dead core's popover gives the keys back: nothing can answer it", () => {
    const s = { ...idle, core: "down" as const, thread: { ...idle.thread, prompts: [grant("p1")] } }
    expect(onKey(at({ focus: "agents" }), s, key("down"), 0).by).toBe("agents")
    expect(queueOf(at({}), s)).toEqual([])
  })
  test("a prompt with no options is never shown: it could not be answered", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [{ ...grant("p0"), options: [] }, grant("p1")] } }
    expect(queueOf(at({}), s).map((p) => p.id)).toEqual(["p1"])
  })
  test("under a popover the hints are the popover's alone", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [grant("p1")] } }
    expect(hintsOf(SHELL, at({ focus: "bar" }), { s, now: 0, draft: "" }).map((h) => h.keys)).toEqual(["←→", "Enter"])
  })
  test("after answering zarg, the bar says the answer is on its way until the core moves on", () => {
    expect(barLine(at({ answered: "inq-1", viewing: "x" }), asking, 0)).toEqual({ text: "sending your answer…", tone: "working" })
  })
})

describe("surfaces in the shell", () => {
  const stats = { name: "status", sections: [{ id: "line", kind: "stats" as const, role: "summary" as const }] }
  const table = { name: "t", sections: [{ id: "rows", kind: "table" as const, role: "primary" as const, columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" as const }] }] }
  const views = {
    "two:t1": { agent: "two:t1", layout: table, data: { rows: { rows: [{ id: "r1", cells: {} }, { id: "r2", cells: {} }] } } },
    "two:t1@status": { agent: "two:t1@status", layout: stats, data: {} },
  }
  const popover = { id: "p1", kind: "surface" as const, question: "two ask", options: [], view: "two:t1", agent: "two:t1" }
  const panel = (input: "none" | "onFocus", edge: "bottom" | "right" = "bottom") => ({ id: `two:status:two:t1`, plugin: "two", agent: "two:t1", view: "two:t1", name: "status", scope: "shell" as const, edge, size: 2, input })
  // zarg's bar is a panel too: with it, zarg is loaded.
  const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
  const with_ = (thread: Partial<SessionState["thread"]>): SessionState => ({ ...idle, thread: { ...idle.thread, views, ...thread, panels: [zargBar, ...(thread.panels ?? [])] } })

  test("a plugin's popover: its action key acts on its agent; Esc closes it", () => {
    const s = with_({ prompts: [popover] })
    expect(onKey(at({}), s, key("a"), 0).action).toEqual({ type: "act", section: "rows", action: "apply", rows: ["r1"], agent: "two:t1", view: "two:t1" })
    expect(onKey(at({}), s, key("escape"), 0).action).toEqual({ type: "close-prompt", id: "p1" })
  })
  test("Alt+down from the tile reaches a focusable bottom panel before the bar; one that takes no keys is skipped", () => {
    const tile = at({ main: "agent", focus: "tile", viewing: "two:t1" })
    expect(onKey(tile, with_({ panels: [panel("onFocus")] }), key("down", { meta: true }), 0).ui).toMatchObject({ focus: "panel", panel: "two:status:two:t1" })
    expect(onKey(tile, with_({ panels: [panel("none")] }), key("down", { meta: true }), 0).ui.focus).toBe("bar")
    expect(onKey(tile, with_({ panels: [panel("onFocus", "right")] }), key("right", { meta: true }), 0).ui).toMatchObject({ focus: "panel" })
  })
  test("a focused panel takes its view's keys; Esc closes it and gives the tile the keys", () => {
    const s = with_({ panels: [panel("onFocus")] })
    const ui = at({ main: "agent", focus: "panel", panel: "two:status:two:t1", viewing: "two:t1" })
    expect(onKey(ui, s, key("down"), 0).ui.panelView?.rows.rows).toBe(1)
    expect(onKey(ui, s, key("a"), 0).action).toMatchObject({ type: "act", action: "apply", agent: "two:t1", view: "two:t1" })
    expect(onKey(ui, s, key("escape"), 0).ui).toMatchObject({ focus: "tile", closedPanels: ["two:status:two:t1"] })
  })
  test("a drawer over the view closes on Esc while the view has the keys (the view stays); a menu open in the view closes first", () => {
    const drawer = { ...panel("onFocus", "right"), id: "two:item:two:t1", overlay: true }
    const s = with_({ panels: [drawer] })
    const ui = at({ main: "agent", focus: "tile", viewing: "two:t1" })
    expect(onKey(ui, s, key("escape"), 0).ui).toMatchObject({ main: "agent", viewing: "two:t1", closedPanels: ["two:item:two:t1"] })
    expect(closeOverlays(ui, s).closedPanels).toEqual(["two:item:two:t1"])
    // Nothing over the view: the same ui back.
    expect(closeOverlays(ui, with_({}))).toBe(ui)
    const menu = { ...ui, view: { ...startUi(views["two:t1"] as never), menu: { path: "x", col: 0, pick: 0 } } } as never
    expect(onKey(menu, s, key("escape"), 0).ui.closedPanels).toEqual([])
  })
  test("a drawer's own keys work while the view keeps the keys (its buttons need no Alt+arrow first); the view's keys stay the view's", () => {
    const item = { agent: "two:t1@item", layout: { name: "item", sections: [{ id: "body", kind: "text" as const, role: "primary" as const }], actions: [{ id: "drop", label: "Drop", key: "X", on: "none" as const }, { id: "move", label: "Move ▾", key: "m", on: "none" as const, choices: [{ id: "ready", label: "Ready" }] }] }, data: {} }
    const drawer = { ...panel("onFocus", "right"), id: "two:item:two:t1", view: "two:t1@item", overlay: true }
    const s = with_({ panels: [drawer], views: { ...views, "two:t1@item": item } as never })
    const ui = at({ main: "agent", focus: "tile", viewing: "two:t1" })
    expect(onKey(ui, s, key("x", { shift: true }), 0).action).toMatchObject({ type: "act", action: "drop", view: "two:t1@item" })
    expect(onKey(ui, s, key("a"), 0).action).toMatchObject({ type: "act", action: "apply", view: "two:t1" })
    // Move ▾ opens its menu in the drawer, which takes the keys (as a click on the button does).
    const moved = onKey(ui, s, key("m"), 0).ui
    expect(moved).toMatchObject({ focus: "panel", panel: "two:item:two:t1" })
    expect(moved.panelView?.choose).toBeDefined()
  })
  test("Esc in a plugin's sheet or panel first leaves a search, a line being typed or a dropdown; only then closes it", () => {
    const searching = { ...startUi(views["two:t1"] as never), searching: "rows" }
    const sheet = at({ main: "agent", focus: "tile", sheet: true, sheetOf: "two:t1", viewing: "two:t1", sheetView: searching } as never)
    const r = onKey(sheet, with_({}), key("escape"), 0).ui
    expect(r.sheet).toBe(true)
    expect(r.sheetView?.searching).toBeUndefined()
    const s = with_({ panels: [panel("onFocus")] })
    const inPanel = at({ main: "agent", focus: "panel", panel: "two:status:two:t1", viewing: "two:t1", panelView: { ...startUi(views["two:t1"] as never), input: { action: "x", section: "rows", rows: [], text: "" } } } as never)
    const p = onKey(inPanel, s, key("escape"), 0).ui
    expect(p.focus).toBe("panel")
    expect(p.panelView?.input).toBeUndefined()
  })
  test("a plugin's sheet takes its view's keys; Esc closes it", () => {
    const ui = at({ main: "agent", focus: "tile", sheet: true, sheetOf: "two:t1", viewing: "two:t1" })
    expect(onKey(ui, with_({}), key("a"), 0).action).toMatchObject({ type: "act", action: "apply", agent: "two:t1" })
    const closed = onKey(ui, with_({}), key("escape"), 0).ui
    expect(closed.sheet).toBe(false)
    expect(closed.sheetOf).toBeUndefined()
  })
})

describe("zarg's bar", () => {
  const other = { id: "two:status:two:t1", plugin: "two", agent: "two:t1", view: "two:t1", name: "status", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "none" as const }
  const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
  test("without zarg's bar panel (zarg is not loaded) alt+m and / leave focus where it is", () => {
    const s = { ...idle, thread: { ...idle.thread, panels: [other] } }
    expect(onKey(at({ focus: "agents" }), s, key("m", { meta: true }), 0).ui.focus).toBe("agents")
    expect(onKey(at({ focus: "agents" }), s, key("/"), 0).ui.focus).toBe("agents")
    expect(barLine(at({}), s, 0)).toEqual({ text: "zarg is not loaded", tone: "idle" })
  })
  test("zarg's bar panel is the bar, never drawn as a panel", () => {
    const s = { ...idle, thread: { ...idle.thread, panels: [zargBar] } }
    expect(onKey(at({ focus: "agents" }), s, key("m", { meta: true }), 0).ui.focus).toBe("bar")
    expect(panelsShown(at({}), s).bottom).toEqual([])
  })
})

describe("surface fixes", () => {
  const table = { name: "t", sections: [{ id: "rows", kind: "table" as const, role: "primary" as const, columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" as const }] }] }
  const views = { "two:t1@x": { agent: "two:t1@x", layout: table, data: { rows: { rows: [{ id: "r1", cells: {} }] } } } }
  test("an action from a tile of another view acts on the agent the view belongs to", () => {
    const s: SessionState = { ...idle, thread: { ...idle.thread, views } }
    expect(onKey(at({ main: "agent", focus: "tile", viewing: "two:t1@x" }), s, key("a"), 0).action).toMatchObject({ type: "act", action: "apply", agent: "two:t1", view: "two:t1@x" })
  })
  test("a plugin popover that just showed takes no keys for a moment; its hints are its own", () => {
    const s: SessionState = { ...idle, thread: { ...idle.thread, views, prompts: [{ id: "p1", kind: "surface", question: "two ask", options: [], view: "two:t1@x", agent: "two:t1" }] } }
    const ui = syncUi(at({}), s, 1000)
    expect(onKey(ui, s, key("a"), 1100).action).toBeUndefined()
    expect(onKey(ui, s, key("a"), 1000 + POPOVER_GUARD_MS).action).toMatchObject({ type: "act", action: "apply" })
    expect(hintsOf(SHELL, ui, { s, now: 0, draft: "" }).map((h) => h.keys)).toEqual(["Esc", "a"])
  })
})

describe("focus review fixes (keys)", () => {
  test("an agent view's status line keeps no view keys (its actions are buttons in the view): only Esc back", () => {
    const ui = at({ main: "agent", focus: "tile", viewing: "rehearse:t1" })
    const keys = hintsOf(SHELL, ui, { s: withView, now: 0, draft: "" }).map((h) => `${h.keys} ${h.does}`)
    expect(keys).toEqual(["Esc back"])
  })
  test("a view of several sections hints [ ] between them, in the tile and in a plugin's sheet", () => {
    const two = { agent: "p:t1", layout: { name: "t", sections: [{ id: "a", kind: "table" as const, role: "primary" as const, columns: [] }, { id: "b", kind: "table" as const, role: "primary" as const, columns: [] }] }, data: {} }
    const s: SessionState = { ...idle, thread: { ...idle.thread, views: { "p:t1": two } } }
    const tile = hintsOf(SHELL, at({ main: "agent", focus: "tile", viewing: "p:t1" }), { s, now: 0, draft: "" }).map((h) => `${h.keys} ${h.does}`)
    expect(tile).toContain("[ ] section")
    const sheet = hintsOf(SHELL, at({ focus: "tile", sheet: true, sheetOf: "p:t1" }), { s, now: 0, draft: "" }).map((h) => `${h.keys} ${h.does}`)
    expect(sheet).toContain("[ ] section")
  })
  test("the palette's highlight stays on the ten entries it shows", () => {
    const many = { ...idle, thread: { ...idle.thread, rlms: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`p:t${i}`, { id: `p:t${i}`, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }])) } }
    let ui = at({ palette: { query: "", pick: 0 } })
    for (let i = 0; i < 15; i++) ui = onKey(ui, many, key("down"), 0).ui
    expect(ui.palette?.pick).toBe(9)
  })
})

import { defineView as dv, layoutOf as lo } from "@zarg/view"
test("a focused toggle table says on the status line that space flips a row; a board says how to fold and move", () => {
  const withToggle = (kind: "toggle" | "board"): SessionState => ({ ...idle, thread: { ...idle.thread, views: { "backlog:feedback": { agent: "backlog:feedback", layout: lo(kind === "toggle" ? dv("f", { list: { kind: "table", role: "primary", columns: [{ id: "c", label: "c" }], toggle: true } }) : dv("b", { board: { kind: "board", role: "primary" } })), data: {} } } } })
  const at = { ...initialUi, focus: "tile" as const, main: "agent" as const, viewing: "backlog:feedback" }
  const hints = (s: SessionState) => hintsOf(SHELL, at as never, { s, now: 0, draft: "" }, 6)
  expect(hints(withToggle("toggle"))).toEqual(expect.arrayContaining([{ keys: "Space", does: "flip" }]))
  expect(hints(withToggle("board"))).toEqual(expect.arrayContaining([{ keys: "z Z", does: "fold" }, { keys: "⇧←→", does: "move" }]))
})

test("typing a letter at zarg's question starts Say it in your own words with it: nothing typed goes to other keys", () => {
  const r = onKey(at({ focus: "bar" }), asking, { name: "i", sequence: "I", shift: true } as never, 0, "")
  expect(r.by).toBe("picker")
  expect(r.ui.other).toBe(true)
  expect(r.ui.focus).toBe("bar")
  expect(r.draft).toBe("I")
  // g (go to attention elsewhere) is a letter too while zarg asks.
  expect(onKey(at({ focus: "bar" }), asking, { name: "g", sequence: "g" } as never, 0, "").draft).toBe("g")
  // Digits still pick an answer; arrows still move.
  expect(onKey(at({ focus: "bar" }), asking, key("down"), 0, "").ui.other).not.toBe(true)
})

test("a number at zarg's question answers that option, as in the inbox", () => {
  const r = onKey(at({ focus: "bar" }), asking, key("2"), 0, "")
  expect(r.action).toEqual({ type: "answer", answer: { choice: "b" } })
  // No option 9: nothing happens.
  expect(onKey(at({ focus: "bar" }), asking, key("9"), 0, "").action).toBeUndefined()
})

test("the rail's arrows reach the Inbox above the views; Enter there goes home", () => {
  const navved: SessionState = { ...idle, thread: { ...idle.thread, nav: [{ id: "gherkin", label: "Journeys", view: "gherkin:journeys" }] } as never }
  const atJourneys = at({ focus: "agents", main: "agent", viewing: "gherkin:journeys", agents: { toggled: {}, tree: 0, cursor: "nav:gherkin" } })
  const up = onKey(atJourneys, navved, key("up"), 0)
  expect(up.ui.agents.cursor).toBe(INBOX_ROW)
  const home = onKey(up.ui, navved, key("return"), 0)
  expect(home.ui.main).toBe("inbox")
  expect(home.ui.focus).toBe("tile")
  // Down from the Inbox: the first view.
  expect(onKey(up.ui, navved, key("down"), 0).ui.agents.cursor).toBe("nav:gherkin")
})

test("grants waiting together: the first offers Allow all, which answers every waiting grant at once", () => {
  const topic = (id: string, created: number) => ({ id, kind: "grant", state: "open", blocking: true, created, updated: created, title: `Plugin ${id} wants to load.`, why: "grant", about: [], messages: [], from: { plugin: id }, answers: [{ id: "always", label: "Allow", recommended: true }, { id: "deny", label: "Not now" }] })
  const s: SessionState = { ...idle, thread: { ...idle.thread, inbox: { "T-1": topic("T-1", 1), "T-2": topic("T-2", 2), "T-3": topic("T-3", 3) } } as never }
  const head = queueOf(initialUi, s)[0]!
  expect(head.options.map((o) => o.label)).toEqual(["Allow", "Not now", "Allow all 3"])
  const r = onKey(at({ popover: { pick: 2, since: 0 } }), s, key("return"), 10_000)
  expect(r.action).toEqual({ type: "answer-topics", ids: ["T-1", "T-2", "T-3"], answer: "always" })
  // One grant alone: no Allow all.
  const one: SessionState = { ...idle, thread: { ...idle.thread, inbox: { "T-1": topic("T-1", 1) } } as never }
  expect(queueOf(initialUi, one)[0]!.options.map((o) => o.label)).toEqual(["Allow", "Not now"])
})

test("a grant that arrives while the operator types waits: the bar keeps the keys until the draft is sent or cleared", () => {
  const topic = { id: "T-1", kind: "grant", state: "open", blocking: true, created: 1, updated: 1, title: "Plugin p wants to load.", why: "grant", about: [], messages: [], from: { plugin: "p" }, answers: [{ id: "always", label: "Allow", recommended: true }, { id: "deny", label: "Not now" }] }
  const s: SessionState = { ...idle, thread: { ...idle.thread, inbox: { "T-1": topic } } as never }
  expect(onKey(at({ focus: "bar" }), s, key("return"), 10_000, "half a sentence").by).not.toBe("popover")
  // Nothing typed: the grant has the keys.
  expect(onKey(at({ focus: "bar" }), s, key("return"), 10_000, "").by).toBe("popover")
})
