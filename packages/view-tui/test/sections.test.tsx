import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
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
  // @card UX-0076
  test("text sections size themselves to rendered Markdown diagrams", async () => {
    const v: ViewState = {
      agent: "writer",
      layout: { name: "writer", sections: [{ id: "report", kind: "text", role: "primary", title: "Report" }] },
      data: { report: { markdown: "```mermaid\nflowchart TD\nA[Start] --> B[Finish]\n```" } },
    }
    const t = await testRender(<AgentView view={v} ui={initialViewUi} height={60} />, { width: 100, height: 60, exitOnCtrlC: false, exitSignals: [] })
    destroy = () => t.renderer.destroy()
    for (let i = 0; i < 5; i++) await act(async () => { await t.renderOnce(); await Bun.sleep(5) })
    const f = t.captureCharFrame()
    expect(f).not.toContain("A[Start]")
    expect(f).toContain("Finish")
    expect(f.split("\n").filter((line) => line.includes("└")).length).toBe(2)
  })

  // @card UX-0076
  test("agent conversation messages render Mermaid through the shared renderer", async () => {
    const v: ViewState = {
      agent: "writer",
      layout: { name: "writer", sections: [{ id: "talk", kind: "conversation", role: "primary", title: "Conversation" }] },
      data: { talk: { messages: [{ id: "m1", role: "agent", text: "```mermaid\nflowchart LR\nA[Read] --> B[Render]\n```" }] } },
    }
    const f = await frame(v, initialViewUi, { width: 100, height: 60 })
    expect(f).toContain("agent")
    expect(f).toContain("Render")
    expect(f).not.toContain("A[Read]")
    expect(f).toMatch(/[┌╭]/)
  })

  test("summary on top, then workers and steps, the review tables pinned at the bottom", async () => {
    const f = await frame(view(3))
    const lines = f.split("\n")
    const at = (s: string) => lines.findIndex((l) => l.includes(s))
    expect(at("14/22")).toBeLessThan(at("Workers"))
    expect(at("Workers")).toBeLessThan(at("Steps"))
    expect(at("Steps")).toBeLessThan(at("Findings"))
    expect(f).toContain("story 3")
    expect(f).toContain("R-2")
    // Keys live on the status line, never inside a table.
    expect(f).not.toContain("a Apply")
    // The log shows its newest lines (it follows the bottom).
    expect(f).toContain("step 39")
  })

  test("at 80×20 every section keeps its title; the log and the pinned table share what is left", async () => {
    const f = await frame(view(30), initialViewUi, { width: 80, height: 20 })
    for (const t of ["Workers", "Steps", "Findings"]) expect(f).toContain(t)
    const lines = f.split("\n")
    const steps = lines.findIndex((l) => l.includes("Steps"))
    const pinned = lines.findIndex((l) => l.includes("Findings"))
    // Both get rows: neither swallows the other.
    expect(pinned - steps).toBeGreaterThanOrEqual(4)
    expect(lines.filter((l) => /R-\d/.test(l)).length).toBeGreaterThanOrEqual(2)
  })

  test("sections are headed blocks: a title and a rule, no frames", async () => {
    const f = await frame(view(3))
    expect(f).not.toMatch(/[┌┐└┘│]/)
    expect(f).toMatch(/Workers ─+/)
    expect(f).toMatch(/Steps ─+/)
  })

  test("the current tab is marked in the heading", async () => {
    const f = await frame(view(3))
    expect(f).toMatch(/Findings 3 {3}Likes 0 ─+/)
  })

  test("a selectable table: ○ on each row, ● on selected ones, ▍ on the cursor", async () => {
    const ui = { ...initialViewUi, focus: 3, rows: { "review.findings": 1 }, selected: { "review.findings": ["R-0"] } }
    const lines = (await frame(view(3), ui)).split("\n")
    expect(lines.findLast((l) => l.includes("R-0"))).toMatch(/● R-0/)
    expect(lines.findLast((l) => l.includes("R-1"))).toMatch(/▍○ R-1/)
    expect(lines.find((l) => l.includes("R-2"))).toMatch(/ ○ R-2/)
  })

  test("an empty selectable table", async () => {
    const f = await frame(view(0), { ...initialViewUi, focus: 3 })
    expect(f).toContain("nothing yet")
    expect(f).not.toMatch(/[○●]/)
  })

  test("a long cell ends in … on one line", async () => {
    const long = { ...view(1), data: { ...view(1).data, "review.findings": { rows: [{ id: "R-0", cells: { id: "R-0", note: "word ".repeat(60) } }] } } }
    const lines = (await frame(long, initialViewUi, { width: 80, height: 30 })).split("\n").filter((l) => l.includes("word"))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.trimEnd()).toMatch(/…$/)
  })

  test("the highlighted row of a long table stays on screen", async () => {
    const f = await frame(view(30), { ...initialViewUi, focus: 3, rows: { "review.findings": 25 } }, { width: 80, height: 20 })
    expect(f).toContain("▍○ R-25")
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

  test("a cell with line breaks stays on its row", async () => {
    const v = view(1)
    const withBreaks: ViewState = { ...v, data: { ...v.data, "review.findings": { rows: [{ id: "R-0", cells: { id: "R-0", note: "first line\nsecond line" } }] } } }
    const f = await frame(withBreaks, { ...initialViewUi, focus: 3 })
    expect(f).toContain("R-0   first line second line")
  })
})
