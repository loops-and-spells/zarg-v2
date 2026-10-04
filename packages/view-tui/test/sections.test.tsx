import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { defineView, initialViewUi, layoutOf, type ViewState } from "@zarg/view"
import { AgentView, NowContext, type Scroller } from "../src/sections"
import { colorsOf, DEFAULT_THEME } from "../src/theme"

const THEME = colorsOf(DEFAULT_THEME)

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
    workers: { items: [{ id: "s3", text: "story 3  S-0001 ▸ [S-0012]", detail: "screening", state: "busy" }, { id: "s5", text: "story 5", detail: "waits for story 3 at S-0012", state: "waiting" }] },
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
  // @scenario S-0076
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

  // @scenario S-0076
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
    expect(lines.find((l) => l.includes("R-0"))).toMatch(/● R-0/)
    expect(lines.find((l) => l.includes("R-1"))).toMatch(/▍○ R-1/)
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
      data: { task: { markdown: ["Fix ST-1", "", "```ts", "yield* Graph.show({ id: \"ST-1\" })", "```"].join("\n") } },
    }
    const f = await frame(rlm)
    expect(f).toContain('yield* Graph.show({ id: "ST-1" })')
  })

  test("a cell with line breaks stays on its row", async () => {
    const v = view(1)
    const withBreaks: ViewState = { ...v, data: { ...v.data, "review.findings": { rows: [{ id: "R-0", cells: { id: "R-0", note: "first line\nsecond line" } }] } } }
    const f = await frame(withBreaks, { ...initialViewUi, focus: 3 })
    expect(f).toContain("R-0   first line second line")
  })
})

test("a section titled with an empty string draws no heading: its content starts at once", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "primary", title: "", columns: [{ id: "name", label: "journey" }] }, flow: { kind: "text", role: "pinned", title: "Flow" } })),
    data: { list: { rows: [{ id: "J-1", cells: { name: "Checkout" } }] }, flow: { markdown: "hello" } },
  }
  const lines = (await frame(v)).split("\n")
  expect(lines[0]).toMatch(/^\s+journey/)
  expect(lines.some((l) => l.startsWith("Flow ─"))).toBe(true)
})

test("a column's tone colours its cells, its tones by value (a severity's high, medium, low); a row's own tone wins", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "pinned", title: "F", columns: [{ id: "card", label: "card", tone: "warn" }, { id: "sev", label: "severity", tones: { high: "error", low: "dim" } }] } })),
    data: { list: { rows: [{ id: "a", cells: { card: "S-0001", sev: "high" } }, { id: "b", cells: { card: "S-0002", sev: "low" } }, { id: "c", cells: { card: "S-0003", sev: "high" }, tone: "ok" }] } },
  }
  const t = await testRender(<AgentView view={v} ui={{ ...initialViewUi, rows: { list: 1 } }} height={30} />, { width: 60, height: 30, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`
  const fgOf = (text: string, nth = 0) => hex(t.captureSpans().lines.flatMap((l) => l.spans).filter((s) => s.text.includes(text))[nth]!.fg)
  expect(fgOf("S-0001")).toBe(THEME.attention)
  expect(fgOf("high")).toBe(THEME.error)
  expect(fgOf("low")).toBe(THEME.dim)
  expect(fgOf("S-0003")).toBe(THEME.ok)
})

test("a ref cell draws its label: glyph and text in its tone", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "pinned", title: "F", columns: [{ id: "card", label: "card", ref: true }] } })),
    data: { list: { rows: [{ id: "a", cells: { card: "gherkin/scenario:S-0001" } }], labels: { "gherkin/scenario:S-0001": { text: "S-0001 Plugin asks", tone: "scenario", glyph: "◇" } } } },
  }
  const t = await testRender(<AgentView view={v} ui={initialViewUi} height={20} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const f = t.captureCharFrame()
  expect(f).toContain("◇ S-0001 Plugin asks")
  expect(f).not.toContain("gherkin/scenario:")
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`
  // The table row (the row card under it draws its first column in the accent).
  const span = t.captureSpans().lines.filter((l) => !l.spans.some((s) => s.text.includes("┃"))).flatMap((l) => l.spans).find((s) => s.text.includes("S-0001"))!
  expect(hex(span.fg)).toBe(THEME.attention)
})

test("a toggle table marks rows on [●] or off [ ]; an off row is faint", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "pinned", title: "F", toggle: true, columns: [{ id: "c", label: "c" }] } })),
    data: { list: { rows: [{ id: "a", cells: { c: "kept" }, on: true }, { id: "b", cells: { c: "dropped" }, on: false }] } },
  }
  const t = await testRender(<AgentView view={v} ui={{ ...initialViewUi, focus: -1 }} height={20} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const f = t.captureCharFrame()
  expect(f).toMatch(/\[●\] kept/)
  expect(f).toMatch(/\[ \] dropped/)
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`
  const span = t.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes("dropped"))!
  expect(hex(span.fg)).toBe(THEME.faint)
})

test("a click on a toggle row's mark asks the plugin to flip it", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "pinned", title: "F", toggle: true, columns: [{ id: "c", label: "c" }] } })),
    data: { list: { rows: [{ id: "a", cells: { c: "kept" }, on: true }, { id: "b", cells: { c: "dropped" }, on: false }] } },
  }
  const acts: Array<[string | undefined, string, ReadonlyArray<string>]> = []
  const t = await testRender(<AgentView view={v} ui={initialViewUi} height={20} onAct={(s, a, r) => void acts.push([s, a, r])} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const lines = t.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("dropped"))
  await t.mockMouse.click(lines[y]!.indexOf("["), y)
  expect(acts).toEqual([["list", "toggle", ["b"]]])
})

test("a read-only row reports: no mark, and a click flips nothing; the other rows still toggle", async () => {
  const v: ViewState = {
    agent: "t",
    layout: layoutOf(defineView("t", { list: { kind: "table", role: "pinned", title: "F", toggle: true, columns: [{ id: "c", label: "c" }, { id: "s", label: "status" }] } })),
    data: { list: { rows: [{ id: "a", cells: { c: "kept", s: "drafted" }, on: true, readonly: true }, { id: "b", cells: { c: "dropped", s: "" }, on: false }] } },
  }
  const acts: Array<unknown> = []
  const t = await testRender(<AgentView view={v} ui={initialViewUi} height={20} onAct={(s, a, r) => void acts.push([s, a, r])} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const f = t.captureCharFrame()
  expect(f).not.toMatch(/\[[● ]\] kept/)
  expect(f).toMatch(/kept\s+drafted/)
  expect(f).toMatch(/\[ \] dropped/)
  const lines = f.split("\n")
  const y = lines.findIndex((l) => l.includes("kept"))
  await t.mockMouse.click(lines[y]!.indexOf("kept") - 2, y)
  expect(acts).toEqual([])
})

describe("a busy row", () => {
  const spinning = (now: number) => ({
    agent: "triage:triage",
    layout: layoutOf(defineView("t", { cards: { kind: "table", role: "primary", title: "", columns: [{ id: "g", label: "" }, { id: "card", label: "card" }] } })),
    data: { cards: { rows: [{ id: "a", cells: { g: "✓", card: "S-0001" } }, { id: "b", cells: { g: "⠋", card: "S-0002" }, busy: true }] } },
  }) satisfies ViewState
  const draw = async (now: number) => {
    const t = await testRender(<NowContext.Provider value={now}><AgentView view={spinning(now)} ui={initialViewUi} height={20} /></NowContext.Provider>, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
    await t.renderOnce()
    await Bun.sleep(5)
    await t.renderOnce()
    const f = t.captureCharFrame()
    t.renderer.destroy()
    return f
  }
  test("its first cell spins with the shell's clock; other rows keep their text", async () => {
    const [a, b] = [await draw(0), await draw(200)]
    expect(a).toMatch(/⠋\s+S-0002/)
    expect(b).toMatch(/⠹\s+S-0002/)
    expect(b).toMatch(/✓\s+S-0001/)
  })
})

test("a view's own actions are buttons at its top; a click runs one", async () => {
  const v: ViewState = {
    agent: "backlog:item",
    layout: layoutOf(defineView("item", { item: { kind: "text", role: "primary", title: "" } }, { actions: [{ id: "ready", label: "→ Ready", key: "r", on: "none" }, { id: "drop", label: "Drop", key: "X", on: "none" }] })),
    data: { item: { markdown: "**Grant prompt**" } },
  }
  const acts: Array<unknown> = []
  const t = await testRender(<AgentView view={v} ui={initialViewUi} height={20} onAct={(s, a, r) => void acts.push([s, a, r])} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const lines = t.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("→ Ready"))
  expect(y).toBeGreaterThanOrEqual(0)
  expect(y).toBeLessThan(lines.findIndex((l) => l.includes("Grant prompt")))
  await t.mockMouse.click(lines[y]!.indexOf("Drop") + 1, y)
  expect(acts).toEqual([[undefined, "drop", []]])
})

test("a view's only section takes the whole view, whatever its role (a drawer's text)", async () => {
  const v: ViewState = {
    agent: "backlog:item",
    layout: layoutOf(defineView("item", { item: { kind: "text", role: "primary", title: "" } })),
    data: { item: { markdown: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n") } },
  }
  const t = await testRender(<AgentView view={v} ui={initialViewUi} height={30} />, { width: 60, height: 30, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(20)
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("line 12")
})

test("a view's buttons show only those its text offers now; a dropped-down Move lists its choices and a click picks one", async () => {
  const LANES = [{ id: "backlog", label: "Backlog" }, { id: "ready", label: "Ready" }]
  const v: ViewState = {
    agent: "backlog:item",
    layout: layoutOf(defineView("item", { item: { kind: "text", role: "primary", title: "" } }, { actions: [{ id: "move", label: "Move ▾", key: "m", on: "none", choices: LANES }, { id: "drop", label: "Drop", key: "X", on: "none" }, { id: "resync", label: "Resync", key: "s", on: "none" }] })),
    data: { item: { markdown: "B-01", actions: ["move", "drop"] } },
  }
  const picks: Array<number> = []
  const t = await testRender(<AgentView view={v} ui={{ ...initialViewUi, choose: { action: "move", rows: [], choices: LANES, pick: 0 } }} height={20} onAct={() => {}} onChoose={(i) => void picks.push(i)} />, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const f = t.captureCharFrame()
  expect(f).toContain("Move ▾")
  expect(f).not.toContain("Resync")
  const lines = f.split("\n")
  const y = lines.findIndex((l) => /Ready/.test(l))
  expect(y).toBeGreaterThan(lines.findIndex((l) => l.includes("Move ▾")))
  await t.mockMouse.click(lines[y]!.indexOf("Ready"), y)
  expect(picks).toEqual([1])
})

test("a text that is loading shows its line in the middle, with a spinner, in place of its text", async () => {
  const v: ViewState = {
    agent: "backlog:item",
    layout: layoutOf(defineView("item", { item: { kind: "text", role: "primary", title: "" } })),
    data: { item: { markdown: "old plan", loading: "Loading B-02…" } },
  }
  const t = await testRender(<NowContext.Provider value={200}><AgentView view={v} ui={initialViewUi} height={20} /></NowContext.Provider>, { width: 60, height: 20, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  await Bun.sleep(5)
  await t.renderOnce()
  const lines = t.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("Loading B-02…"))
  expect(y).toBeGreaterThan(4)
  expect(lines[y]).toContain("⠹")
  expect(lines[y]!.indexOf("⠹")).toBeGreaterThan(10)
  expect(lines.join("\n")).not.toContain("old plan")
})

describe("a secret input", () => {
  test("is drawn masked, one dot per character", async () => {
    const v: ViewState = {
      agent: "setup",
      layout: layoutOf(defineView("setup", { fields: { kind: "table", role: "primary", title: "Fields", columns: [{ id: "name", label: "name" }], actions: [{ id: "set", label: "Set", on: "row", input: "the value" }] } })),
      data: { fields: { rows: [{ id: "K", cells: { name: "KEY" }, secret: true }] } },
    }
    const f = await frame(v, { ...initialViewUi, input: { section: "fields", action: "set", rows: ["K"], text: "sk-or-abc", placeholder: "the value", secret: true } } as never)
    expect(f).toContain("•••••••••")
    expect(f).not.toContain("sk-or-abc")
  })
})
