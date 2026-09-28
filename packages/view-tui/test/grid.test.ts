import { describe, expect, test } from "bun:test"
import { initial, type RlmNode, type SessionState } from "@zarg/client"
import { gridCards, gridShape } from "../src/grid"
import { onKey } from "../src/layers"
import { initialUi, syncUi, type Ui } from "../src/view"

const plugin = (id: string, status: "running" | "done", extra: Partial<RlmNode> = {}): RlmNode => ({ id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status, decisions: [], ...extra })
const st = (rlms: Record<string, RlmNode>, extra: Partial<SessionState["thread"]> = {}): SessionState => ({ thread: { ...initial("main"), seq: 1, rlms, ...extra }, core: "up" })
const z = plugin("zarg", "running", { preset: "zarg" })
const rlm = plugin("rlm-1", "running", { preset: "driver" })

const tester = {
  agent: "p:t1",
  layout: {
    name: "tester",
    card: { headline: "progress", recent: "steps", action: "apply" },
    sections: [
      { id: "progress", kind: "stats", role: "summary" },
      { id: "steps", kind: "log", role: "log" },
      { id: "findings", kind: "table", role: "primary", columns: [], actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] },
    ],
  },
  data: { progress: { items: [{ label: "steps", value: "12/18" }], progress: { done: 12, total: 18 } }, steps: { lines: ["a", "b", "c", "d"].map((text) => ({ text })) }, findings: { rows: [{ id: "R-1", cells: {} }] } },
}

describe("the grid", () => {
  test("cards: attention first (unseen first), then running, then finished; zarg and RLMs are not cards", () => {
    const s = st({ zarg: z, "rlm-1": rlm, "p:done": plugin("p:done", "done"), "p:run": plugin("p:run", "running"), "p:ask": plugin("p:ask", "done", { attention: { reason: "3 findings", since: 5 } }) })
    expect(gridCards(initialUi, s).map((c) => c.id)).toEqual(["p:ask", "p:run", "p:done"])
  })
  test("a declared card: its headline, gauge, last 3 recent lines and action", () => {
    const [c] = gridCards(initialUi, st({ "p:t1": plugin("p:t1", "running") }, { views: { "p:t1": tester as never } }))
    expect(c).toMatchObject({ headline: "12/18 steps", gauge: { done: 12, total: 18 }, recent: [{ text: "b" }, { text: "c" }, { text: "d" }], action: { id: "apply", key: "a", section: "findings" }, starting: false })
  })
  test("no card: the minimal card from the row; no view: starting", () => {
    const [c] = gridCards(initialUi, st({ "p:t1": plugin("p:t1", "running", { row: { text: "walking", progress: { done: 2, total: 9 } } }) }))
    expect(c).toMatchObject({ headline: "walking", gauge: { done: 2, total: 9 }, recent: [], starting: true })
  })
  test("the grid's shape: about 44×10 a card, at least 1×2", () => {
    expect(gridShape(100, 30)).toEqual({ cols: 2, rows: 3 })
    expect(gridShape(56, 20)).toEqual({ cols: 1, rows: 2 })
    expect(gridShape(180, 40)).toEqual({ cols: 4, rows: 4 })
  })
  test("the cursor survives a card leaving", () => {
    const two = st({ "p:a": plugin("p:a", "running"), "p:b": plugin("p:b", "running") })
    const ui: Ui = { ...syncUi(initialUi, two), grid: { cursor: 1 } }
    expect(syncUi(ui, st({ "p:a": plugin("p:a", "running") })).grid.cursor).toBe(0)
  })
  test("keys on the grid: arrows move, ⏎ opens the card's agent, its action key acts on it", () => {
    const s = st({ "p:t1": plugin("p:t1", "running"), "p:t2": plugin("p:t2", "running") }, { views: { "p:t1": tester as never } })
    const ui: Ui = { ...syncUi(initialUi, s), focus: "tile" }
    const moved = onKey(ui, s, { name: "right" }, 0)
    expect(moved.by).toBe("grid")
    expect(moved.ui.grid.cursor).toBe(1)
    expect(onKey(ui, s, { name: "return" }, 0).ui).toMatchObject({ main: "agent", viewing: "p:t1" })
    expect(onKey(ui, s, { name: "a" }, 0).action).toEqual({ type: "act", section: "findings", action: "apply", rows: ["R-1"], agent: "p:t1", view: "p:t1" })
  })
})

describe("grid review fixes", () => {
  test("the cursor follows its agent when the order changes", () => {
    const s = st({ "p:a": plugin("p:a", "running"), "p:b": plugin("p:b", "running") })
    const on = onKey({ ...syncUi(initialUi, s), focus: "tile" }, s, { name: "right" }, 0).ui
    const reordered = st({ "p:a": plugin("p:a", "running"), "p:b": plugin("p:b", "running"), "p:c": plugin("p:c", "done", { attention: { reason: "r", since: 1 } }) })
    const after = syncUi(on, reordered)
    expect(onKey(after, reordered, { name: "return" }, 0).ui).toMatchObject({ viewing: "p:b" })
  })
  test("Esc on the grid goes back", () => {
    const s = st({ "p:a": plugin("p:a", "running") })
    const ui: Ui = { ...syncUi(initialUi, s), focus: "tile", back: [{ main: "review" }] }
    expect(onKey(ui, s, { name: "escape" }, 0).ui.main).toBe("review")
  })
  test("the grid's shape: two columns beside the rail at 100 columns; one when the terminal is narrow", () => {
    expect(gridShape(72, 26)).toMatchObject({ cols: 2 })
    expect(gridShape(73, 20, true)).toMatchObject({ cols: 1 })
  })
})
