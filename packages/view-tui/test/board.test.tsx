import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { defineView, initialViewUi, layoutOf, type ViewState, type ViewUi } from "@zarg/view"
import { AgentView } from "../src/sections"
import { colorsOf, DEFAULT_THEME } from "../src/theme"

const T = colorsOf(DEFAULT_THEME)
let destroy: (() => void) | undefined
afterEach(() => destroy?.())
const layout = layoutOf(defineView("backlog", { board: { kind: "board", role: "primary", title: "" } }))
const cards = (lane: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${lane}-${i}`, title: `Item ${lane} ${i} with a title long enough to wrap`, tone: "severity.high", top: `B-${i} UX-000${i}`, badge: "◇2", lines: [{ text: "Operator", tone: "persona" }] }))
const view: ViewState = {
  agent: "backlog:backlog",
  layout,
  data: { board: { lanes: [{ id: "backlog", title: "Backlog", cards: cards("b", 8) }, { id: "ready", title: "Ready", cards: cards("r", 2) }, { id: "review", title: "Review", cards: cards("v", 1) }] } },
}
const frame = async (ui: ViewUi) => {
  const t = await testRender(<AgentView view={view} ui={ui} height={24} />, { width: 90, height: 24, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  for (let i = 0; i < 3; i++) {
    await t.renderOnce()
    await Bun.sleep(5)
  }
  return t
}
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`

describe("boards in the terminal", () => {
  test("lanes side by side, each count on the header row; a folded lane's count on that row too, its title top to bottom", async () => {
    const t = await frame({ ...initialViewUi, board: { board: { lane: 0, card: 0, folded: ["review"] } } })
    const lines = t.captureCharFrame().split("\n")
    const head = lines.findIndex((l) => l.includes("Backlog 8"))
    expect(lines[head]).toMatch(/Backlog 8.*◂.*Ready 2.*◂.*1/)
    const col = lines[head]!.lastIndexOf("1")
    expect(["R", "E", "V", "I", "E", "W"].every((ch, i) => lines[head + 2 + i]![col] === ch)).toBe(true)
  })
  test("the cursor card of a long lane is on screen; the stripe is in the card's tone", async () => {
    const t = await frame({ ...initialViewUi, board: { board: { lane: 0, card: 7, folded: [] } } })
    expect(t.captureCharFrame()).toContain("Item b 7")
    const stripe = t.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text === "▌")!
    expect(hex(stripe.fg)).toBe(T.error)
  })
})

import { wrap } from "../src/board"
test("a word longer than the lane is split across lines, never cut off", () => {
  expect(wrap("Scaffold supercalifragilistic models", 8)).toEqual(["Scaffold", "supercal", "ifragili", "stic", "models"])
})
