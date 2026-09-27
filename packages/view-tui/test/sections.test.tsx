import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { defineView, initialViewUi, layoutOf, type ViewState } from "@zarg/view"
import { AgentView, type Scroller } from "../src/sections"

const tester = layoutOf(
  defineView("tester", {
    progress: { kind: "stats", role: "summary" },
    workers: { kind: "list", role: "primary", title: "Workers" },
    steps: { kind: "log", role: "log", title: "Steps" },
    review: {
      kind: "tabs",
      role: "pinned",
      tabs: {
        findings: { kind: "table", title: "Findings", columns: [{ id: "id", label: "id" }, { id: "note", label: "note" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] },
        likes: { kind: "table", title: "Likes", columns: [{ id: "id", label: "id" }] },
      },
    },
  }),
)
const view = (findings: number): ViewState => ({
  agent: "rehearse:tester-1",
  layout: tester,
  data: {
    progress: { items: [{ label: "steps", value: "14/22" }, { label: "flagged", value: "3" }], progress: { done: 14, total: 22 } },
    workers: { items: [{ id: "s3", text: "story 3  UX-0001 ▸ [UX-0012]", detail: "screening", state: "busy" }, { id: "s5", text: "story 5", detail: "waits for story 3 at UX-0012", state: "waiting" }] },
    steps: { lines: Array.from({ length: 40 }, (_, i) => ({ text: `step ${i}` })) },
    "review.findings": { rows: Array.from({ length: findings }, (_, i) => ({ id: `R-${i}`, cells: { id: `R-${i}`, note: `note ${i}` } })) },
    "review.likes": { rows: [] },
  },
})

let destroy: (() => void) | undefined
afterEach(() => destroy?.())
const frame = async (v: ViewState, ui = initialViewUi, size = { width: 100, height: 30 }) => {
  const t = await testRender(<AgentView view={v} ui={ui} height={size.height} />, { ...size, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  // Scrolling a highlighted row into view happens after the first frame's layout.
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  return t.captureCharFrame()
}

describe("the terminal draws an agent's view", () => {
  test("summary on top, then workers and steps, the review tables pinned at the bottom", async () => {
    const f = await frame(view(3))
    const lines = f.split("\n")
    const at = (s: string) => lines.findIndex((l) => l.includes(s))
    expect(at("14/22")).toBeLessThan(at("Workers"))
    expect(at("Workers")).toBeLessThan(at("Steps"))
    expect(at("Steps")).toBeLessThan(at("Findings"))
    expect(f).toContain("story 3")
    expect(f).toContain("R-2")
    expect(f).toContain("a Apply")
    // The log shows its newest lines (it follows the bottom).
    expect(f).toContain("step 39")
  })

  test("at 80×20 every section keeps its title and the pinned table stays within 40%", async () => {
    const f = await frame(view(30), initialViewUi, { width: 80, height: 20 })
    for (const t of ["Workers", "Steps", "Findings"]) expect(f).toContain(t)
    const lines = f.split("\n")
    const pinnedFrom = lines.findIndex((l) => l.includes("Findings"))
    expect(lines.length - pinnedFrom).toBeLessThanOrEqual(Math.ceil(20 * 0.4) + 1)
  })

  test("the focused section is marked, the highlighted row shows, selected rows are ticked", async () => {
    const f = await frame(view(3), { ...initialViewUi, focus: 3, rows: { "review.findings": 1 }, selected: { "review.findings": ["R-2"] } })
    expect(f).toContain("▸ [ ] R-1")
    expect(f).toContain("  [x] R-2")
  })

  test("the highlighted row of a long table stays on screen", async () => {
    const f = await frame(view(30), { ...initialViewUi, focus: 3, rows: { "review.findings": 25 } }, { width: 80, height: 20 })
    expect(f).toContain("▸ [ ] R-25")
  })

  test("the focused section scrolls when the shell asks", async () => {
    const scroller: { current?: Scroller } = {}
    const t = await testRender(<AgentView view={view(3)} ui={{ ...initialViewUi, focus: 2 }} height={30} scroller={scroller} />, { width: 100, height: 30, exitOnCtrlC: false, exitSignals: [] })
    destroy = () => t.renderer.destroy()
    await t.renderOnce()
    expect(t.captureCharFrame()).not.toContain("step 20 ")
    scroller.current?.(-12)
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("step 20")
  })

  test("a text section shows as many lines as its role's share allows", async () => {
    const rlm: ViewState = {
      agent: "rlm-1",
      layout: { name: "rlm", sections: [{ id: "task", kind: "text", role: "primary", title: "Task" }, { id: "history", kind: "log", role: "log", title: "History" }] },
      data: { task: { markdown: ["Fix S-1", "", "```ts", "yield* Graph.show({ id: \"S-1\" })", "```"].join("\n") } },
    }
    const f = await frame(rlm)
    expect(f).toContain('yield* Graph.show({ id: "S-1" })')
  })
})
