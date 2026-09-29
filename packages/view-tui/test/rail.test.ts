import { expect, test } from "bun:test"
import { initial, type RlmNode, type SessionState } from "@zarg/client"
import { displayName, railRows } from "../src/rail"
import { initialUi } from "../src/view"

const node = (p: Partial<RlmNode> & { id: string }): RlmNode => ({ parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running", decisions: [], ...p })
const stateWith = (rlms: Record<string, RlmNode>): SessionState => ({ thread: { ...initial("main"), rlms }, core: "up" })
const rlms = {
  zarg: node({ id: "zarg", preset: "zarg", attention: { reason: "asks: Split UX-0012?", since: 1 } }),
  "rlm-1": node({ id: "rlm-1", parent: "zarg", preset: "driver", turns: 3, budget: 25 }),
  "rehearse:run": node({ id: "rehearse:run", preset: "rehearse", row: { progress: { done: 12, total: 18 }, text: "12/18 steps" } }),
  "rehearse:tester-1": node({ id: "rehearse:tester-1", parent: "rehearse:run", status: "done", attention: { reason: "3 findings to review", since: 2 } }),
}

test("displayName for RLMs, plugin agents and zarg", () => {
  expect(displayName(node({ id: "rehearse:tester-1", preset: "tester" }))).toBe("tester-1")
  expect(displayName(node({ id: "rlm-12", preset: "driver" }))).toBe("driver 12")
  expect(displayName(node({ id: "zarg", preset: "zarg" }))).toBe("zarg")
  expect(displayName(node({ id: "rehearse:run", preset: "rehearse" }))).toBe("rehearse")
})

test("the rail is flat and indented: glyph, name, a right-aligned note, a gauge under running work", () => {
  const rows = railRows(initialUi, stateWith(rlms), undefined, 24)
  expect(rows.map((r) => [r.depth, r.glyph, r.name, r.note])).toEqual([
    [0, "◆", "zarg", "asks"],
    [1, "⠼", "driver 1", "3/25"],
    [0, "▾", "rehearse", "12/18"],
    [1, "◆", "tester-1", "3"],
  ])
  expect(rows[2]!.gauge).toEqual({ done: 12, total: 18 })
})

test("a long name is cut to its room; a finished agent is dimmed", () => {
  const rows = railRows(initialUi, stateWith({ "p:a-very-long-agent-name-indeed": node({ id: "p:a-very-long-agent-name-indeed", status: "done" }) }), undefined, 24)
  expect(rows[0]!.name.endsWith("…")).toBe(true)
  expect(rows[0]!.dimmed).toBe(true)
  expect(rows[0]!.note).toBe("done")
})

test("archived agents fold into one row at the foot", () => {
  const s: SessionState = { ...stateWith({ ...rlms, "p:old": node({ id: "p:old", status: "done" }) }), thread: { ...stateWith({ ...rlms, "p:old": node({ id: "p:old", status: "done" }) }).thread, archived: { "p:old": { reason: "ttl (24h)", at: 0 } } } }
  const rows = railRows(initialUi, s, undefined, 24)
  expect(rows.at(-1)).toMatchObject({ glyph: "▸", name: "archived", note: "1" })
})

test("while zarg's question waits, its agents stand still; a plugin's agents spin on", () => {
  const s = { ...stateWith({ "rlm-1": node({ id: "rlm-1", preset: "driver" }), "triage:triage-1": node({ id: "triage:triage-1", preset: "triage" }) }), thread: { ...stateWith({}).thread, rlms: { "rlm-1": node({ id: "rlm-1", preset: "driver" }), "triage:triage-1": node({ id: "triage:triage-1", preset: "triage" }) }, pendingInquiry: { id: "q", question: "?", options: [], allowOther: true, about: [] } } } as SessionState
  const glyphs = Object.fromEntries(railRows(initialUi, s, 200, 24).map((r) => [r.id, r.glyph]))
  expect(glyphs["rlm-1"]).toBe("⠼")
  expect(glyphs["triage:triage-1"]).toBe("⠹")
})
