import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { type Answer, initial, type Inquiry, type Session, type SessionState } from "@zarg/client"
import { makeTheme, PALETTES } from "@zarg/tokens"
import { App } from "../src/app"
import { colorsOf, DEFAULT_THEME, type ThemeService } from "../src/theme"
import { POPOVER_GUARD_MS } from "../src/view"

const THEME = colorsOf(DEFAULT_THEME)

/** A session with fixed state that records what the UI asks of it. */
const fakeSession = (state: SessionState) => {
  const calls: Array<string> = []
  let current = state
  const listeners = new Set<() => void>()
  const session: Session = {
    state: () => current,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    start: () => calls.push("start"),
    answer: (a: Answer) => calls.push(`answer ${JSON.stringify(a)}`),
    send: (t) => calls.push(`send ${t}`),
    stop: () => calls.push("stop"),
    close: () => calls.push("close"),
    command: (t) => calls.push(`command ${t}`),
    pluginCommands: () => [],
    act: (agent, action, _section, rows, _view, text) => Promise.resolve(void calls.push(`act ${agent} ${action} ${rows.join(",")}${text !== undefined ? ` "${text}"` : ""}`)),
    answerPrompt: (id, choice) => Promise.resolve(void calls.push(`prompt ${id} ${choice}`)),
    answerTopic: (id, answer, text) => Promise.resolve(void calls.push(`topic ${id} ${answer ?? ""} ${text ?? ""}`.trim())),
    answerTopics: (ids, answer) => Promise.resolve(void calls.push(`topics ${ids.join(",")} ${answer}`)),
    snoozeTopic: (id) => Promise.resolve(void calls.push(`snooze ${id}`)),
    readTopic: (id) => Promise.resolve(void calls.push(`read ${id}`)),
    replyTopic: (id, text) => Promise.resolve(void calls.push(`reply ${id} ${text}`)),
    closePrompt: (id) => Promise.resolve(void calls.push(`close ${id}`)),
    archive: (change) => Promise.resolve(void calls.push(`archive ${JSON.stringify(change)}`)),
    answerAgent: (agent, question, answer) => Promise.resolve(void calls.push(`answer ${agent} ${question} ${JSON.stringify(answer)}`)),
  }
  const update = (next: SessionState) => {
    current = next
    for (const l of listeners) l()
  }
  return { session, calls, update }
}

const inquiry: Inquiry = {
  id: "inq-1",
  question: "Which card first?",
  options: [
    { id: "a", label: "Login" },
    { id: "b", label: "Checkout", recommended: true, why: "most used" },
  ],
  allowOther: true,
  about: [],
}
// As production (run.tsx): the app handles Ctrl-C itself, and nothing tears the renderer down on a signal.
const RENDERER = { exitOnCtrlC: false, exitSignals: [] }

const meta = { threadId: "main", repo: "zarg-v2", driver: "zarg-router:deepseek-v4.1-flash-exl3", mode: "child" as const }
const waiting: SessionState = {
  thread: {
    ...initial("main"),
    status: "waiting",
    pendingInquiry: inquiry,
    messages: [{ id: "m1", role: "assistant", text: "The agenda is empty." }],
    rlms: {
      "rlm-1": { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 3, budget: 25, tokens: 5847, status: "running", decisions: [{ kind: "atomize", atomic: true, criteria: [{ name: "single", answer: true, confidence: 0.91 }] }] },
      "rlm-2": { id: "rlm-2", parent: "rlm-1", preset: "research", depth: 1, turns: 2, budget: 15, status: "done", decisions: [] },
    },
  },
  core: "up",
}

let destroy: (() => void) | undefined
afterEach(() => destroy?.())
const render = async (state0: SessionState, size = { width: 110, height: 24 }, theme?: ThemeService) => {
  // As a live session: the core's events have arrived (the arrival rule waits for them).
  const state = state0.thread.seq === 0 ? { ...state0, thread: { ...state0.thread, seq: 1 } } : state0
  const fake = fakeSession(state)
  let exited = false
  const t = await testRender(<App session={fake.session} meta={meta} onExit={() => (exited = true)} {...(theme !== undefined ? { theme } : {})} />, { ...size, ...RENDERER })
  destroy = () => t.renderer.destroy()
  await t.waitForVisualIdle()
  // Running agents spin with the clock: frames show the spinner as ● so they compare; rawFrame keeps it.
  const rawFrame = () => t.captureCharFrame()
  return { ...t, ...fake, exited: () => exited, rawFrame, captureCharFrame: () => rawFrame().replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "●") }
}

// Arrow keys arrive as escape sequences the parser holds briefly; let them land, then draw.
const settle = async (t: { renderOnce: () => Promise<void>; waitForVisualIdle: () => Promise<unknown> }) => {
  await Bun.sleep(30)
  await t.renderOnce()
  await t.waitForVisualIdle()
}

// Home is the inbox: go to the grid the way the operator does, ^k "agents" ⏎.
const toGrid = async <T extends { mockInput: { pressKey: (k: string, m?: { ctrl?: boolean }) => void; typeText: (s: string) => Promise<void>; pressEnter: () => void }; renderOnce: () => Promise<void>; waitForVisualIdle: () => Promise<unknown> }>(t: T) => {
  t.mockInput.pressKey("k", { ctrl: true })
  await settle(t)
  await t.mockInput.typeText("agents")
  t.mockInput.pressEnter()
  await settle(t)
  return t
}

describe("tui frames", () => {
  // @scenario S-0076
  test("zarg's sheet renders Mermaid inside agent messages", async () => {
    const t = await render({ thread: { ...initial("main"), messages: [{ id: "m1", role: "assistant", text: "```mermaid\nflowchart LR\nA[Read] --> B[Render]\n```" }] }, core: "up" })
    const frame = t.captureCharFrame()
    expect(frame).toContain("Read")
    expect(frame).toContain("Render")
    expect(frame).not.toContain("A[Read]")
    expect(frame).toMatch(/[┌╭]/)
  })

  test("a click in zarg's sheet never gives its scrollbox the arrow keys: the agents list keeps them", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: "assistant" as const, text: `message ${i}` }))
    const { pendingInquiry: _, ...quiet } = waiting.thread
    const t = await render({ ...waiting, thread: { ...quiet, status: "idle", messages: many } })
    await t.mockMouse.click(60, 5)
    await settle(t)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    const before = t.captureCharFrame().split("\n").slice(1, 6).map((l) => l.slice(30, 100))
    t.mockInput.pressArrow("up")
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame().split("\n").slice(1, 6).map((l) => l.slice(30, 100))).toEqual(before)
  })

  const testerView = {
    agent: "rehearse:tester-1",
    layout: { name: "tester", sections: [{ id: "steps", kind: "log" as const, role: "log" as const, title: "Steps" }, { id: "review", kind: "tabs" as const, role: "pinned" as const, tabs: [{ id: "findings", kind: "table" as const, title: "Findings", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" as const }] }] }] },
    data: { steps: { lines: [{ text: "S-1: feel 1.80" }] }, "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1" } }, { id: "R-2", cells: { id: "R-2" } }] } },
  }
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], attention: { reason: "2 findings to review", since: 1 } }
  const withTester: SessionState = { ...waiting, thread: { ...waiting.thread, rlms: { ...waiting.thread.rlms, "rehearse:tester-1": tester }, views: { "rehearse:tester-1": testerView } } }
  const openTester = async (size: { width: number; height: number }) => {
    const t = await render(withTester, size)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    return t
  }

  test("wide: the agents list, the open agent's view and zarg's bar; Alt+arrows move between them", async () => {
    const t = await openTester({ width: 130, height: 22 })
    const lines = t.captureCharFrame().split("\n")
    expect(lines.find((l) => l.startsWith(" AGENTS"))).toMatch(/^ AGENTS +◆\d/)
    expect(t.captureCharFrame()).toContain("tester-1  rehearse")
    // The open view has focus: arrows move its table, not zarg's question (which waits in the bar).
    t.mockInput.pressArrow("down")
    await settle(t)
    expect(t.captureCharFrame()).toContain("▍○ R-2")
    expect(t.captureCharFrame()).toContain("◆ zarg asks Which card first?")
    // Alt+down: the bar takes the keys, zarg's sheet opens with the question; arrows move it.
    t.mockInput.pressArrow("down", { meta: true })
    await settle(t)
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame()).toContain("› Login")
    // alt+v: back to the view.
    t.mockInput.pressKey("v", { meta: true })
    await settle(t)
    expect(t.captureCharFrame()).toContain("R-2")
    expect(t.captureCharFrame()).not.toContain("› Login")
  })

  test("at 80×24 the strip lists attention above the view, and the bar sits under it", async () => {
    const t = await openTester({ width: 80, height: 24 })
    const lines = t.captureCharFrame().split("\n")
    // The rail folds to its glyphs: the one asking shows ◆ at the left edge.
    expect(lines.some((l) => l.slice(0, 3).includes("◆"))).toBe(true)
    const view = lines.findIndex((l) => l.includes("tester-1  rehearse"))
    const bar = lines.findIndex((l) => l.includes("◆ zarg asks Which card first?"))
    expect(view).toBeGreaterThanOrEqual(0)
    expect(bar).toBeGreaterThan(view)
  })

  test("at 80×24 with many agents, a four-option question and a long table: the strip keeps attention, the sheet keeps every option", async () => {
    const node = (i: number) => ({ id: `rehearse:tester-${i}`, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], ...(i === 6 ? { attention: { reason: "3 findings to review", since: 1 } } : {}) })
    const rlms = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`rehearse:tester-${i}`, node(i)]))
    const four = { ...inquiry, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }, { id: "d", label: "Delta" }] }
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `R-${i}`, cells: { id: `R-${i}` } }))
    const big = { ...testerView, agent: "rehearse:tester-1", data: { ...testerView.data, "review.findings": { rows } } }
    const t = await render({ ...waiting, thread: { ...waiting.thread, pendingInquiry: four, rlms, views: { "rehearse:tester-1": big } } }, { width: 80, height: 24 })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const lines = t.captureCharFrame().split("\n")
    expect(lines.some((l) => l.slice(0, 3).includes("◆"))).toBe(true)
    expect(t.captureCharFrame()).toContain("R-1")
    // The question waits in the bar; alt+m opens zarg's sheet with every option.
    t.mockInput.pressKey("m", { meta: true })
    await settle(t)
    for (const o of ["Alpha", "Beta", "Gamma", "Delta"]) expect(t.captureCharFrame()).toContain(o)
  })

  test("a click on a tile gives it the keys", async () => {
    const t = await openTester({ width: 130, height: 22 })
    // The view has the keys; a click on the bar gives them to zarg: its sheet opens and arrows move its question.
    const y = t.captureCharFrame().split("\n").findIndex((l) => l.includes("◆ zarg asks Which card first?"))
    await t.mockMouse.click(60, y)
    await settle(t)
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame()).toContain("› Login")
  })

  test("Escape in the view goes back home to the inbox; zarg's question waits in the bar, alt+m opens it", async () => {
    const t = await openTester({ width: 130, height: 22 })
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.captureCharFrame()).toContain("Nothing needs you.")
    expect(t.captureCharFrame()).toContain("◆ zarg asks Which card first?")
    t.mockInput.pressKey("m", { meta: true })
    await settle(t)
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame()).toContain("› Login")
  })

  test("with no agent open, zarg's sheet holds its messages and its question beside the agents list", async () => {
    const t = await render(waiting)
    const lines = t.captureCharFrame().split("\n")
    expect(lines[0]).toContain("inbox")
    expect(lines.find((l) => l.includes("zarg  The agenda is empty."))).toBeDefined()
    const q = lines.find((l) => l.includes("Which card first?") && !l.includes("zarg asks"))
    expect(q).toBeDefined()
  })

  test("an inquiry: picker with the recommended option preselected and its why; agents pane; status line", async () => {
    const t = await render(waiting)
    const frame = t.captureCharFrame()
    expect(frame).toContain("Which card first?")
    expect(frame).toContain("› Checkout (recommended) — most used")
    expect(frame).toContain("  Something else…")
    expect(frame).toContain("  Chat about this")
    expect(frame).not.toContain("Message")
    expect(frame).toMatch(/▾ driver 1 +3\/25/)
    expect(frame).toMatch(/└ ✓ research 2 +done/)
    expect(frame).toContain("core child · waiting · thread main")
    expect(frame).toMatchSnapshot()
  })

  test("a run error shows its kind and message in the conversation", async () => {
    const t = await render({ thread: { ...initial("main"), status: "error", error: { code: "model", message: "zarg-router is not reachable" } }, core: "up" })
    const frame = t.captureCharFrame()
    expect(frame).toContain("!  model: zarg-router is not reachable")
    expect(frame).toMatchSnapshot()
  })

  test("arrow keys and Enter answer the inquiry", async () => {
    const t = await render(waiting)
    t.mockInput.pressArrow("up")
    t.mockInput.pressEnter()
    await t.renderOnce()
    expect(t.calls).toEqual(['answer {"choice":"a"}'])
  })

  test("typing while the driver works sends a message; Ctrl-C stops, twice exits", async () => {
    const t = await render({ thread: { ...initial("main"), status: "running" }, core: "up" })
    await t.mockInput.typeText("also add logout")
    t.mockInput.pressEnter()
    await t.renderOnce()
    t.mockInput.pressKey("c", { ctrl: true })
    t.mockInput.pressKey("c", { ctrl: true })
    await t.renderOnce()
    expect(t.calls).toEqual(["send also add logout", "stop"])
    expect(t.exited()).toBe(true)
  })

  test("an 80-column terminal still shows the question, the options and the status", async () => {
    const t = await render(waiting, { width: 80, height: 24 })
    const frame = t.captureCharFrame()
    expect(frame).toContain("Which card first?")
    expect(frame).toContain("› Checkout (recommended)")
    expect(frame).toContain("thread main")
  })

  test("a long message wraps inside the conversation pane", async () => {
    const long = "word ".repeat(40).trim()
    const t = await render({ thread: { ...initial("main"), messages: [{ id: "m", role: "assistant", text: long }] }, core: "up" })
    const rows = t.captureCharFrame().split("\n").filter((r) => r.includes("word"))
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.join(" ").match(/word/g)?.length).toBe(40)
  })

  test("a long question wraps inside the picker at 80 columns", async () => {
    const question = "Checkout has two open branches: card declined and address invalid. Which one should we specify first, given the agenda?"
    const t = await render({ ...waiting, thread: { ...waiting.thread, pendingInquiry: { ...inquiry, question } } }, { width: 80, height: 30 })
    const words = t.captureCharFrame().match(/[A-Za-z:,.?]+/g) ?? []
    for (const w of question.split(" ")) expect(words).toContain(w)
  })

  test("one Ctrl-C stops the driver and leaves the TUI on screen", async () => {
    const t = await render({ thread: { ...initial("main"), status: "running" }, core: "up" })
    t.mockInput.pressKey("c", { ctrl: true })
    await settle(t)
    expect(t.calls).toEqual(["stop"])
    expect(t.captureCharFrame()).toContain("agents")
  })

  test("at 80 columns with a long thread and driver, the status line still shows the core state and thread status", async () => {
    const fake = fakeSession({ thread: { ...initial("feature-checkout-refactor"), status: "error" }, core: "down" })
    const t = await testRender(
      <App session={fake.session} meta={{ threadId: "feature-checkout-refactor", driver: "openrouter:anthropic/claude-sonnet-4.5", mode: "child" }} onExit={() => {}} />,
      { width: 80, height: 24, ...RENDERER },
    )
    destroy = () => t.renderer.destroy()
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).toContain("core stopped · error")
  })

  // @scenario S-0073
  test("alt+a gives the agents list the keys; the highlight walks a tall tree and the detail follows", async () => {
    const rlms = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`rlm-${i + 1}`, { id: `rlm-${i + 1}`, parent: i === 0 ? null : "rlm-1", preset: i === 0 ? "driver" : "research", depth: i === 0 ? 0 : 1, turns: 1, budget: 15, status: "done" as const, decisions: [] }]),
    )
    const t = await render({ thread: { ...initial("main"), status: "running", rlms }, core: "up" })
    expect(t.captureCharFrame()).not.toContain("research 40")
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    for (let i = 0; i < 40; i++) t.mockInput.pressArrow("down")
    await settle(t)
    expect(t.captureCharFrame()).toContain("research 40")
  })

  test("while the driver works, the conversation ends with the animated working line", async () => {
    const root = { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 4, budget: 25, status: "running" as const, decisions: [] }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "rlm-1": root } }, core: "up" })
    const first = t.rawFrame()
    expect(first).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] zarg is preparing a reply · 0:00 · turn 4\/25/)
    const spinnerAt = (f: string) => /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) zarg is preparing/.exec(f)?.[1]
    await Bun.sleep(250)
    await settle(t)
    expect(spinnerAt(t.rawFrame())).not.toBe(spinnerAt(first))
  })

  test("Enter on an agent shows its view in the tile area; Escape closes it", async () => {
    const rlmView = {
      agent: "rlm-2",
      layout: { name: "rlm", sections: [{ id: "status", kind: "stats" as const, role: "summary" as const }, { id: "history", kind: "log" as const, role: "log" as const, title: "History" }] },
      data: { status: { items: [{ label: "turns", value: "2/15" }] }, history: { lines: [{ text: "research rlm-2: Find the VM grid" }, { text: '  Graph.show {"id":"ST-1"}  11ms', tone: "dim" as const }] } },
    }
    const t = await render({ ...waiting, thread: { ...waiting.thread, views: { "rlm-2": rlmView } } })
    t.mockInput.pressKey("a", { meta: true })
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const open = t.captureCharFrame()
    expect(open).toContain("research 2")
    expect(open).toContain("2/15 turns")
    // The view tile sits beside zarg's now: its lines are cut at its width.
    expect(open).toContain("research rlm-2: Find")
    expect(open).toContain('Graph.show {"id":"ST-1"}  11ms')
    expect(t.captureCharFrame()).toContain("research rlm-2: Find")
    t.mockInput.pressEscape()
    await settle(t)
    // Back to where it was opened from: home, the inbox, with zarg's sheet inset over it.
    expect(t.captureCharFrame()).toContain("The agenda is empty.")
    expect(t.captureCharFrame()).toContain("Nothing needs you.")
  })

  test("a plugin agent's view: its steps, a Findings table, and a key that acts on the highlighted row", async () => {
    const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "rehearse:tester-1",
      layout: {
        name: "tester",
        sections: [
          { id: "steps", kind: "log" as const, role: "log" as const, title: "Steps" },
          { id: "review", kind: "tabs" as const, role: "pinned" as const, tabs: [{ id: "findings", kind: "table" as const, title: "Findings", columns: [{ id: "id", label: "id" }, { id: "note", label: "note" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" as const }] }, { id: "likes", kind: "table" as const, title: "Likes", columns: [{ id: "id", label: "id" }] }] },
        ],
      },
      data: { steps: { lines: [{ text: "S-1: feel 1.80" }] }, "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1", note: "no error shown" } }] } },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "rehearse:tester-1": tester }, views: { "rehearse:tester-1": view } }, core: "up" })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("S-1: feel 1.80")
    expect(frame).toMatch(/Findings 1   Likes 0 ─/)
    // The view opens on its table: its highlighted row takes the action at once.
    expect(t.captureCharFrame()).toContain("▍○ R-1   no error shown")
    // A click on a row's box ticks it.
    const lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes("▍○ R-1"))
    await t.mockMouse.click(lines[y]!.indexOf("○"), y)
    await settle(t)
    expect(t.captureCharFrame()).toContain("● R-1")
    t.mockInput.pressKey("a")
    await settle(t)
    expect(t.calls).toContain("act rehearse:tester-1 apply R-1")
  })

  test("a list whose highlight fills the view: moving the cursor tells the plugin the row, once per row", async () => {
    const agent = { id: "backlog:feedback", parent: null, preset: "view", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "backlog:feedback",
      layout: { name: "feedback", sections: [{ id: "journeys", kind: "table" as const, role: "primary" as const, title: "", columns: [{ id: "journey", label: "journey" }], actions: [{ id: "journey", label: "Show", on: "row" as const, default: true, highlight: true }] }] },
      data: { journeys: { rows: [{ id: "Set up", cells: { journey: "Set up" } }, { id: "Reconcile", cells: { journey: "Reconcile" } }] } },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "backlog:feedback": agent }, views: { "backlog:feedback": view } }, core: "up" })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    t.mockInput.pressKey("v", { meta: true })
    t.mockInput.pressArrow("down")
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    expect(t.calls.filter((c) => c.startsWith("act"))).toEqual(["act backlog:feedback journey Reconcile"])
    // It runs on its own: no button for it.
    expect(t.captureCharFrame()).not.toContain("Show")
  })

  test("a plugin sheet opened by a command takes the keys: ] moves to the next section, f searches it", async () => {
    const agent = { id: "core:setup", parent: null, preset: "view", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "core:setup",
      layout: { name: "setup", sections: [
        { id: "summary", kind: "text" as const, role: "summary" as const, title: "" },
        { id: "providers", kind: "table" as const, role: "primary" as const, title: "Providers", columns: [{ id: "provider", label: "provider" }], actions: [{ id: "login", label: "Log in", on: "row" as const, default: true }] },
        { id: "fields", kind: "table" as const, role: "primary" as const, title: "Log in", columns: [{ id: "name", label: "setting" }], actions: [{ id: "set", label: "Set", on: "row" as const, default: true, input: "the value" }, { id: "done", label: "Check and save", key: "c", on: "none" as const }] },
        { id: "models", kind: "table" as const, role: "primary" as const, title: "Default model", search: true, columns: [{ id: "model", label: "model" }], actions: [{ id: "default", label: "Use as default", on: "row" as const, default: true }] },
      ] },
      data: { summary: { markdown: "1 provider ready" }, providers: { rows: [{ id: "r", cells: { provider: "router" } }] }, fields: { rows: [{ id: "URL", cells: { name: "URL" } }] }, models: { rows: [{ id: "m1", cells: { model: "alpha-model" } }, { id: "m2", cells: { model: "jevk5-judge" } }] } },
    }
    // As live: zarg's bar is loaded and zarg asks a question while the operator types /models.
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const before = { thread: { ...initial("main"), status: "waiting" as const, pendingInquiry: inquiry, panels: [zargBar], rlms: { "core:setup": agent } }, core: "up" as const }
    const t = await render(before, { width: 120, height: 40 })
    t.mockInput.pressKey("/")
    await settle(t)
    await t.mockInput.typeText("models")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    t.update({ ...before, thread: { ...before.thread, seq: 2, views: { "core:setup": view }, navigate: { seq: 1, kind: "sheet", view: "core:setup", at: Date.now() } } })
    await settle(t)
    t.mockInput.pressKey("]")
    t.mockInput.pressKey("]")
    await settle(t)
    // Focused, the table still shows its rows.
    expect(t.captureCharFrame()).toMatch(/alpha-model[\s\S]*jevk5-judge[\s\S]*Use as default/)
    t.mockInput.pressKey("f")
    await settle(t)
    for (const c of "jevk") t.mockInput.pressKey(c)
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("jevk5-judge")
    expect(frame).not.toContain("alpha-model")
  })

  test("a wide view shows a long first column whole (model names that differ only at their end)", async () => {
    const agent = { id: "core:setup", parent: null, preset: "view", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "core:setup",
      layout: { name: "setup", sections: [{ id: "models", kind: "table" as const, role: "primary" as const, title: "", columns: [{ id: "model", label: "model" }, { id: "about", label: "" }] }] },
      data: { models: { rows: [{ id: "a", cells: { model: "zarg-router:deepseek-v4.1-flash-exl3", about: "256k" } }, { id: "b", cells: { model: "zarg-router:deepseek-v4.1-pro-exl3", about: "192k" } }] } },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "core:setup": agent }, views: { "core:setup": view } }, core: "up" }, { width: 140, height: 24 })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    // The rows themselves (the highlighted one's line under the table is whole anyway).
    expect(t.captureCharFrame()).toMatch(/▍ zarg-router:deepseek-v4\.1-flash-exl3 +256k/)
    expect(t.captureCharFrame()).toContain("  zarg-router:deepseek-v4.1-pro-exl3 ")
  })

  test("a table offers only the actions its data names; one that asks for text takes a line, prefilled, and sends it", async () => {
    const agent = { id: "backlog:feedback", parent: null, preset: "view", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "backlog:feedback",
      layout: { name: "feedback", sections: [{ id: "feedback", kind: "table" as const, role: "primary" as const, title: "", columns: [{ id: "card", label: "card" }], actions: [{ id: "refine", label: "Refine", key: "r", on: "none" as const }, { id: "accept", label: "Accept", key: "a", on: "none" as const }, { id: "note", label: "Note", key: "n", on: "row" as const, input: "your note for refinement" }] }] },
      data: { feedback: { rows: [{ id: "F-1", cells: { card: "S-0001" }, text: "keep it" }], actions: ["refine", "note"] } },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "backlog:feedback": agent }, views: { "backlog:feedback": view } }, core: "up" })
    t.mockInput.pressKey("a", { meta: true }); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    t.mockInput.pressKey("v", { meta: true }); await settle(t)
    expect(t.captureCharFrame()).toContain(" Refine ")
    expect(t.captureCharFrame()).not.toContain(" Accept ")
    t.mockInput.pressKey("a"); await settle(t)
    expect(t.calls.filter((c) => c.startsWith("act"))).toEqual([])
    t.mockInput.pressKey("n"); await settle(t)
    expect(t.captureCharFrame()).toContain("✎ keep it▎")
    await t.mockInput.typeText(" short"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    await Bun.sleep(30); await settle(t)
    expect(t.calls.filter((c) => c.startsWith("act"))).toEqual(['act backlog:feedback note F-1 "keep it short"'])
    expect(t.captureCharFrame()).not.toContain("✎")
  })

  test("the agents pane folds: → opens a child's subtree, ← closes it", async () => {
    const rlms = {
      "rlm-1": { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 1, budget: 25, status: "running" as const, decisions: [] },
      "rlm-2": { id: "rlm-2", parent: "rlm-1", preset: "research", depth: 1, turns: 1, budget: 15, status: "running" as const, decisions: [] },
      "rlm-3": { id: "rlm-3", parent: "rlm-2", preset: "research", depth: 2, turns: 1, budget: 15, status: "failed" as const, error: "budget", decisions: [] },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms }, core: "up" })
    expect(t.captureCharFrame()).toMatch(/▸ research 2 +\+1/)
    expect(t.captureCharFrame()).not.toContain("rlm-3")
    t.mockInput.pressKey("a", { meta: true })
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("right")
    t.mockInput.pressArrow("down")
    await settle(t)
    const open = t.captureCharFrame()
    // Two levels down the name is cut to its room, the note stays.
    expect(open).toMatch(/└ ✗ resear… +failed/)
    t.mockInput.pressArrow("left")
    t.mockInput.pressArrow("left")
    await settle(t)
    expect(t.captureCharFrame()).not.toContain("failed")
  })

  test("typing / shows the command box; Tab completes; Enter runs the command", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    await t.mockInput.typeText("/re")
    await t.waitForVisualIdle()
    const frame = t.captureCharFrame()
    expect(frame).toContain("commands")
    expect(frame).toContain("/reconcile  turn plan and implement on (it stays on)")
    // Tab writes the completion into the input itself (the box row alone would not prove it).
    t.mockInput.pressTab()
    await t.waitForVisualIdle()
    const messageLine = (frame: string) => frame.split("\n").find((l) => l.includes("› /")) ?? ""
    expect(messageLine(t.captureCharFrame())).toContain("/reconcile")
    t.mockInput.pressEnter()
    await t.waitForVisualIdle()
    expect(t.calls).toEqual(["command /reconcile"])
  })

  test("keys typed in the same burst as / (from the inbox, before the bar renders) land in the bar, never as the panel's hotkeys", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    t.mockInput.pressKey("v", { meta: true })
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).toContain("⏎ open")
    // One burst, as a terminal delivers fast typing or a paste: no render between the keys.
    await t.mockInput.typeText("/re")
    await settle(t)
    expect(t.captureCharFrame().split("\n").find((l) => l.includes("› /")) ?? "").toContain("/re")
  })

  test("in that same burst, Backspace deletes and Enter runs the command (as typed slowly)", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    t.mockInput.pressKey("v", { meta: true })
    await t.waitForVisualIdle()
    await t.mockInput.typeText("/reconcilx\x7fe\r")
    await settle(t)
    expect(t.calls).toEqual(["command /reconcile"])
  })

  test("a key typed right after Tab lands after the completion", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    await t.mockInput.typeText("/re")
    await t.waitForVisualIdle()
    t.mockInput.pressTab()
    await t.mockInput.typeText("x")
    await t.waitForVisualIdle()
    const line = t.captureCharFrame().split("\n").find((l) => l.includes("› /")) ?? ""
    expect(line).toContain("/reconcilex")
  })

  test("while answering Something else…, no command box is shown", async () => {
    const t = await render(waiting)
    t.mockInput.pressArrow("down")
    await settle(t)
    await t.mockInput.typeText("/re")
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).not.toContain("commands")
  })

  test("a question shows in the picker; Something else… is typed in the bar and answers", async () => {
    const t = await render(waiting)
    const frame = t.captureCharFrame()
    expect(frame).not.toContain("Message")
    expect(frame).toContain("Chat about this")
    t.mockInput.pressArrow("down")
    await settle(t)
    await t.mockInput.typeText("payments first")
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.calls).toEqual(['answer {"other":"payments first"}'])
  })

  test("Chat about this moves the typing to the bar; what you type there is sent as a message", async () => {
    const t = await render(waiting)
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("chat ›")
    expect(frame).not.toContain("Checkout (recommended)")
    await t.mockInput.typeText("why Checkout?")
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.calls).toEqual(["send why Checkout?"])
  })

  test("an unknown command shows its lint and is not sent", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    await t.mockInput.typeText("/nope")
    t.mockInput.pressEnter()
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).toContain("✗ unknown command /nope")
    expect(t.calls).toEqual([])
  })

  test("at 80×20 with a question pending, an open agent's view keeps every section's title on screen", async () => {
    const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const view = {
      agent: "rehearse:tester-1",
      layout: {
        name: "tester",
        sections: [
          { id: "progress", kind: "stats" as const, role: "summary" as const },
          { id: "workers", kind: "list" as const, role: "primary" as const, title: "Workers" },
          { id: "steps", kind: "log" as const, role: "log" as const, title: "Steps" },
          { id: "review", kind: "tabs" as const, role: "pinned" as const, tabs: [{ id: "findings", kind: "table" as const, title: "Findings", columns: [{ id: "id", label: "id" }] }] },
        ],
      },
      data: {
        workers: { items: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, text: `story ${i}`, state: "busy" as const })) },
        steps: { lines: Array.from({ length: 30 }, (_, i) => ({ text: `step ${i}` })) },
        "review.findings": { rows: Array.from({ length: 20 }, (_, i) => ({ id: `R-${i}`, cells: { id: `R-${i}` } })) },
      },
    }
    const t = await render({ ...waiting, thread: { ...waiting.thread, rlms: { "rehearse:tester-1": tester }, views: { "rehearse:tester-1": view } } }, { width: 80, height: 20 })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const f = t.captureCharFrame()
    for (const title of ["Workers", "Steps", "Findings"]) expect(f).toContain(title)
    // The question is zarg's: it waits in the bar, under the open view, never over it.
    const lines = f.split("\n")
    const viewTop = lines.findIndex((l) => l.includes("tester-1  rehearse"))
    expect(viewTop).toBeGreaterThanOrEqual(0)
    expect(lines.findIndex((l) => l.includes("◆ zarg asks Which card first?"))).toBeGreaterThan(viewTop)
  })
})

const idleState: SessionState = { thread: { ...initial("main"), messages: [{ id: "m1", role: "assistant", text: "Hello." }] }, core: "up" }
const grantPrompt = (id: string) => ({ id, question: `Plugin ${id} wants to load.`, options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }], kind: "grant" as const })
const viewState: SessionState = {
  ...idleState,
  thread: {
    ...idleState.thread,
    rlms: { "rehearse:t1": { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "running", decisions: [] } },
    views: { "rehearse:t1": { agent: "rehearse:t1", layout: { name: "t", sections: [{ id: "findings", kind: "table", role: "primary", columns: [{ id: "c", label: "C" }], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" }] }] }, data: { findings: { rows: [{ id: "r1", cells: { c: "x" } }] } } } },
  },
}

describe("the shell", () => {
  const wide = { width: 130, height: 22 }
  test("the agents list runs full height on the left; the bar sits under the tile area only", async () => {
    const t = await render(idleState, wide)
    const lines = t.captureCharFrame().split("\n")
    expect(lines[0]).toContain("inbox")
    // The bar starts with the keys: you can type to zarg at once.
    const bar = lines.findIndex((l) => l.includes("type a message"))
    expect(bar).toBeGreaterThan(10)
    // The rail runs down past the bar's row: the bar does not run under it.
    expect(lines[bar]!.indexOf("type a message")).toBeGreaterThan(24)
  })
  test("with no agent open, zarg's sheet fills the tile area with its messages", async () => {
    const t = await render(idleState, wide)
    expect(t.captureCharFrame()).toContain("zarg  Hello.")
  })
  test("zarg asks while a view is open: the bar shows the question on one line; alt+m opens the sheet with the picker", async () => {
    const t = await render({ ...viewState, thread: { ...viewState.thread, status: "waiting", pendingInquiry: inquiry } }, wide)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    let f = t.captureCharFrame()
    expect(f).toContain("◆ zarg asks Which card first?   ⏎ answer   / chat")
    expect(f).not.toContain("› Checkout (recommended)")
    t.mockInput.pressKey("m", { meta: true })
    await settle(t)
    f = t.captureCharFrame()
    expect(f).toContain("esc closes")
    expect(f).toContain("› Checkout (recommended)")
  })
  test("a grant popover shows over everything with its place in the queue; Enter answers it", async () => {
    const t = await render({ ...idleState, thread: { ...idleState.thread, prompts: [grantPrompt("p1"), grantPrompt("p2")] } }, wide)
    expect(t.captureCharFrame()).toContain("grant  1 of 2")
    // A grant that just showed ignores Enter for a moment: a deliberate press.
    await Bun.sleep(POPOVER_GUARD_MS)
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.calls).toContain("prompt p1 always")
  })
  test("a grant popover blurs the bar; answering it gives the bar back", async () => {
    const t = await render(idleState, wide)
    await t.mockInput.typeText("hel")
    t.update({ ...idleState, thread: { ...idleState.thread, prompts: [grantPrompt("p1")] } })
    await settle(t)
    await t.mockInput.typeText("xx")
    t.update(idleState)
    await settle(t)
    await t.mockInput.typeText("lo")
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.calls).toContain("send hello")
  })
  test("hotkey letters show in the panels' names", async () => {
    const t = await render(viewState, wide)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const f = t.captureCharFrame()
    expect(f).toContain("AGENTS")
    expect(f).toContain("t1  rehearse")
    expect(f).toContain("zarg Hello.")
  })
  test("at 80×24 the agents fold to a strip above the tile area; alt+a unfolds them there", async () => {
    const t = await render(waiting, { width: 80, height: 24 })
    // Folded: glyphs only, no names.
    expect(t.captureCharFrame()).not.toContain("driver 1")
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    expect(t.captureCharFrame()).toContain("driver 1")
  })
})

describe("review fixes", () => {
  test("at 80 columns a click on blank space in the unfolded agents list keeps the list", async () => {
    const t = await render(viewState, { width: 80, height: 24 })
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    await t.mockMouse.click(20, 12)
    await settle(t)
    expect(t.captureCharFrame()).toMatch(/⠼ t1|● t1| t1 /)
  })
  test("a click on an agent's row opens its view with the keys: its action key acts", async () => {
    const t = await render(viewState, { width: 110, height: 24 })
    const lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => / t1 /.test(l.slice(0, 24)))
    await t.mockMouse.click(5, y)
    await settle(t)
    t.mockInput.pressKey("a")
    await settle(t)
    expect(t.calls).toContain("act rehearse:t1 apply r1")
  })
})

describe("surfaces", () => {
  const status = { agent: "rehearse:run@status", layout: { name: "status", sections: [{ id: "line", kind: "stats" as const, role: "summary" as const }] }, data: { line: { items: [{ label: "stories", value: "2/5" }] } } }
  const panel = { id: "rehearse:status:rehearse:run", plugin: "rehearse", agent: "rehearse:run", view: "rehearse:run@status", name: "status", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "none" as const }
  const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
  const withStatus: SessionState = { ...idleState, thread: { ...idleState.thread, views: { "rehearse:run@status": status }, panels: [zargBar, panel] } }
  test("a shell-scope bottom panel shows under the tile area and above the bar; its × hides it", async () => {
    const t = await render(withStatus, { width: 110, height: 24 })
    const lines = t.captureCharFrame().split("\n")
    const at = lines.findIndex((l) => l.includes("2/5"))
    const bar = lines.findIndex((l) => l.includes("type a message"))
    expect(at).toBeGreaterThan(0)
    expect(bar).toBeGreaterThan(at)
    const head = lines.findIndex((l) => l.includes("status ×"))
    await t.mockMouse.click(lines[head]!.indexOf("×"), head)
    await settle(t)
    expect(t.captureCharFrame()).not.toContain("2/5")
  })
  test("without zarg's bar the bar's place says zarg is not loaded", async () => {
    const t = await render({ ...idleState, thread: { ...idleState.thread, panels: [] } }, { width: 110, height: 24 })
    expect(t.captureCharFrame()).toContain("zarg is not loaded")
    expect(t.captureCharFrame()).not.toContain("type a message")
  })
  test("a plugin's popover shows its view; Esc closes it", async () => {
    const t = await render({ ...idleState, thread: { ...idleState.thread, views: { "rehearse:run@status": status }, prompts: [{ id: "p1", kind: "surface", question: "rehearse ask", options: [], view: "rehearse:run@status", agent: "rehearse:run" }] } }, { width: 110, height: 24 })
    const f = t.captureCharFrame()
    expect(f).toContain("rehearse ask")
    expect(f).toContain("2/5")
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.calls).toContain("close p1")
  })
})

describe("archive", () => {
  const done = { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 1, budget: 1, status: "done" as const, decisions: [] }
  test("x on a finished agent asks the core to archive it; archived ones wait in a folded row", async () => {
    const t = await render({ ...idleState, thread: { ...idleState.thread, rlms: { "rehearse:t1": done, "rehearse:t2": { ...done, id: "rehearse:t2" } }, archived: { "rehearse:t2": { reason: "ttl (24h)", at: Date.now() } } } }, { width: 110, height: 24 })
    expect(t.captureCharFrame()).toMatch(/▸ archived +1/)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressKey("x")
    await settle(t)
    expect(t.calls).toContain('archive {"archive":["rehearse:t1"]}')
  })
})


describe("the look", () => {
test("no frames around the focus, the bar or the status line", async () => {
  const t = await render(viewState, { width: 130, height: 22 })
  t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
  const lines = t.captureCharFrame().split("\n").filter((l) => l.trim().length > 0)
  expect(lines.filter((l) => /[┌┐└┘]/.test(l))).toEqual([])
  // Right of the rail: the bar, then the status line.
  expect(lines.at(-2)!.slice(24)).toMatch(/^ ›|^ ◆ zarg asks|^ zarg /)
  expect(lines.at(-1)!.slice(24)).toMatch(/^ core child · \w+ · thread main/)
})
test("an open agent's header names it without its plugin prefix or view key", async () => {
  const t = await render(viewState, { width: 130, height: 22 })
  t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
  const f = t.captureCharFrame()
  expect(f).toContain("t1  rehearse")
  expect(f).not.toContain("rehearse:t1")
  expect(f).not.toContain("alt+v")
})
test("zarg's question in the bar is one line with its keys", async () => {
  const t = await render({ ...viewState, thread: { ...viewState.thread, status: "waiting", pendingInquiry: inquiry } }, { width: 130, height: 22 })
  t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
  expect(t.captureCharFrame()).toMatch(/◆ zarg asks Which card first\? +⏎ answer +\/ chat/)
})
test("hints use key glyphs on the status line", async () => {
  const t = await render(waiting, { width: 130, height: 22 })
  expect(t.captureCharFrame().split("\n").filter((l) => l.trim().length > 0).at(-1)).toMatch(/↑↓ pick +⏎ answer/)
})
test("a grant popover: rounded, its options on one line, no key line of its own", async () => {
  const t = await render({ ...idleState, thread: { ...idleState.thread, prompts: [grantPrompt("p1")] } }, { width: 130, height: 22 })
  const f = t.captureCharFrame()
  expect(f).toMatch(/╭/)
  expect(f).toMatch(/› Allow +Not now/)
  expect(f).not.toContain("←→ pick · Enter choose")
})
})

describe("review fixes (look)", () => {
  test("a view beside a right panel cuts its lines with … inside its own width", async () => {
    const long = "word ".repeat(40)
    const v = { ...viewState.thread.views!["rehearse:t1"]!, layout: { name: "t", sections: [{ id: "log", kind: "log" as const, role: "log" as const, title: "Steps" }] }, data: { log: { lines: [{ text: long }] } } }
    const side = { id: "rehearse:side:rehearse:t1", plugin: "rehearse", agent: "rehearse:t1", view: "rehearse:t1@side", name: "side", scope: "agent" as const, edge: "right" as const, size: 30, input: "none" as const }
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const t = await render({ ...viewState, thread: { ...viewState.thread, views: { ...viewState.thread.views, "rehearse:t1": v }, panels: [zargBar, side] } }, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    const line = t.captureCharFrame().split("\n").find((l) => l.includes("word word"))!
    expect(line).toContain("…")
  })
  test("an overlay panel lies over the right of the view: the view keeps its width (its line runs on under the panel)", async () => {
    const long = "word ".repeat(40)
    const v = { ...viewState.thread.views!["rehearse:t1"]!, layout: { name: "t", sections: [{ id: "log", kind: "log" as const, role: "log" as const, title: "Steps" }] }, data: { log: { lines: [{ text: long }] } } }
    const drawer = { id: "rehearse:drawer:rehearse:t1", plugin: "rehearse", agent: "rehearse:t1", view: "rehearse:t1@side", name: "drawer", scope: "agent" as const, edge: "right" as const, size: 30, input: "none" as const, overlay: true }
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const t = await render({ ...viewState, thread: { ...viewState.thread, views: { ...viewState.thread.views, "rehearse:t1": v }, panels: [zargBar, drawer] } }, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    const f = t.captureCharFrame()
    expect(f).toContain("×")
    const line = f.split("\n").find((l) => l.includes("word word"))!
    expect(line).not.toContain("…")
  })
  test("a wide overlay leaves a strip of the view showing", async () => {
    const long = "word ".repeat(40)
    const v = { ...viewState.thread.views!["rehearse:t1"]!, layout: { name: "t", sections: [{ id: "log", kind: "log" as const, role: "log" as const, title: "Steps" }] }, data: { log: { lines: [{ text: long }] } } }
    const drawer = { id: "rehearse:drawer:rehearse:t1", plugin: "rehearse", agent: "rehearse:t1", view: "rehearse:t1@side", name: "drawer", scope: "agent" as const, edge: "right" as const, size: 120, input: "none" as const, overlay: true }
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const t = await render({ ...viewState, thread: { ...viewState.thread, views: { ...viewState.thread.views, "rehearse:t1": v }, panels: [zargBar, drawer] } }, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    const line = t.captureCharFrame().split("\n").find((l) => l.includes("word"))!
    // The view's first words stay in sight, left of the drawer.
    expect(line).toMatch(/word word/)
  })
  test("an overlay drawer shows its view's text, under no name (its × at the right)", async () => {
    const side = { agent: "rehearse:t1@side", layout: { name: "side", sections: [{ id: "item", kind: "text" as const, role: "primary" as const, title: "" }] }, data: { item: { markdown: "PLAN BODY\n\nsecond line" } } }
    const drawer = { id: "rehearse:item:rehearse:t1", plugin: "rehearse", agent: "rehearse:t1", view: "rehearse:t1@side", name: "item", scope: "agent" as const, edge: "right" as const, size: 50, input: "onFocus" as const, overlay: true }
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const t = await render({ ...viewState, thread: { ...viewState.thread, views: { ...viewState.thread.views, "rehearse:t1@side": side }, panels: [zargBar, drawer] } }, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    await Bun.sleep(30); await settle(t)
    const f = t.captureCharFrame()
    expect(f).toContain("PLAN BODY")
    expect(f).toContain("second line")
    expect(f).not.toMatch(/item ×/)
    expect(f).toContain("×")
  })
  test("a click outside an overlay drawer closes it; a click inside keeps it", async () => {
    const side = { agent: "rehearse:t1@side", layout: { name: "side", sections: [{ id: "item", kind: "text" as const, role: "primary" as const, title: "" }] }, data: { item: { markdown: "PLAN BODY" } } }
    const drawer = { id: "rehearse:item:rehearse:t1", plugin: "rehearse", agent: "rehearse:t1", view: "rehearse:t1@side", name: "item", scope: "agent" as const, edge: "right" as const, size: 50, input: "onFocus" as const, overlay: true }
    const zargBar = { id: "zarg:bar:zarg", plugin: "zarg", agent: "zarg", view: "zarg", name: "bar", scope: "shell" as const, edge: "bottom" as const, size: 1, input: "onFocus" as const }
    const t = await render({ ...viewState, thread: { ...viewState.thread, views: { ...viewState.thread.views, "rehearse:t1@side": side }, panels: [zargBar, drawer] } }, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    await Bun.sleep(30); await settle(t)
    const y = t.captureCharFrame().split("\n").findIndex((l) => l.includes("PLAN BODY"))
    await t.mockMouse.click(t.captureCharFrame().split("\n")[y]!.indexOf("PLAN BODY") + 2, y); await settle(t)
    expect(t.captureCharFrame()).toContain("PLAN BODY")
    await t.mockMouse.click(40, y); await settle(t)
    expect(t.captureCharFrame()).not.toContain("PLAN BODY")
  })
  test("at 80 columns the status line keeps its keys (the status gives way)", async () => {
    const t = await render(waiting, { width: 80, height: 24 })
    expect(t.captureCharFrame().split("\n").filter((l) => l.trim().length > 0).at(-1)).toContain("↑↓ pick")
  })
  test("a long zarg question in the bar keeps its keys; a long popover title keeps its count", async () => {
    const long = { ...inquiry, question: "Which of these many interesting and important cards should we specify first given the agenda?" }
    const t = await render({ ...viewState, thread: { ...viewState.thread, status: "waiting", pendingInquiry: long } }, { width: 80, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    expect(t.captureCharFrame()).toMatch(/…   ⏎ answer   \/ chat/)
    const pop = await render({ ...idleState, thread: { ...idleState.thread, views: { "rehearse:run@status": { agent: "rehearse:run@status", layout: { name: "status", sections: [] }, data: {} } }, prompts: [{ id: "p1", kind: "surface", question: "q".repeat(120), options: [], view: "rehearse:run@status", agent: "rehearse:run" }, grantPrompt("p2")] } }, { width: 100, height: 24 })
    expect(pop.captureCharFrame()).toContain("1 of 2")
  })
})

describe("focuses", () => {
  const big = { width: 130, height: 32 }
  const two = (): SessionState => {
    const v = (agent: string, rows: ReadonlyArray<string>) => ({ agent, layout: { name: "t", sections: [{ id: "findings", kind: "table" as const, role: "primary" as const, columns: [{ id: "note", label: "note" }], selectable: true, review: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" as const }] }] }, data: { findings: { rows: rows.map((id) => ({ id, cells: { note: `note ${id}` } })) } } })
    const n = (id: string) => ({ id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], row: { text: `walking ${id}` } })
    return { ...idleState, thread: { ...idleState.thread, rlms: { "p:a": n("p:a"), "p:b": n("p:b") }, views: { "p:a": v("p:a", ["R-1", "R-3"]), "p:b": v("p:b", ["R-2"]) } } }
  }
  test("arrival with agents working: the inbox, no sheet", async () => {
    const t = await render(two(), big)
    const f = t.captureCharFrame()
    expect(f).toContain("inbox")
    expect(f).toContain("Nothing needs you.")
    expect(f).not.toContain("zarg  Hello.")
  })
  test("the inbox: blocking first with ◆, a report with ·; the status line counts; Enter opens a topic and a number answers it", async () => {
    const topic = (id: string, over: Record<string, unknown>) => ({ id, kind: "grant", from: { plugin: "backlog" }, title: `title ${id}`, why: "fs write", about: [], blocking: false, messages: [], state: "open", created: Date.now(), updated: 0, ...over })
    const inbox = {
      "T-2": topic("T-2", { kind: "report", from: { plugin: "rehearse" }, title: "Watch agents run done" }),
      "T-1": topic("T-1", { kind: "question", blocking: true, title: "backlog wants to write .zarg/triage", answers: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }], evidence: "Refine saves the round." }),
    }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox } as never }, big)
    const f = t.captureCharFrame()
    expect(f.indexOf("◆ backlog")).toBeGreaterThan(-1)
    expect(f.indexOf("◆ backlog")).toBeLessThan(f.indexOf("· rehearse"))
    expect(f).toContain("◆ 1 blocking · 2 open")
    t.mockInput.pressEnter(); await settle(t)
    expect(t.captureCharFrame()).toContain("Refine saves the round.")
    t.mockInput.pressKey("2"); await settle(t)
    expect(t.calls).toContain("topic T-1 deny")
  })
  test("a topic with long evidence keeps its header: the title line and who asks, each on its own line", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `- S-00${i} (feature, medium): a long note that goes on and on about what the tester wanted`).join("\n")
    const t0 = { id: "T-7", kind: "question", from: { plugin: "backlog" }, title: "Set up: 80 feedback entries want your call", why: "rehearse asks", about: [], blocking: false, messages: [], state: "open", created: Date.now(), updated: 0, evidence: long, answers: [{ id: "on", label: "Keep them all on" }, { id: "off", label: "Turn them all off" }] }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-7": t0 } } as never }, big)
    t.mockInput.pressEnter(); await settle(t)
    const lines = t.captureCharFrame().split("\n")
    expect(lines.some((l) => l.includes("← Inbox") && l.includes("Set up: 80 feedback entries want your call"))).toBe(true)
    expect(lines.some((l) => l.includes("backlog · question · rehearse asks"))).toBe(true)
  })
  test("a question whose title holds the whole change shows all of it in the topic, so nothing is approved unseen", async () => {
    const change = "Add this to the requirements?\n\nAdd an intent for this product:\nIntent: Family chore tracker\nOutcomes:\n  - A parent adds a chore for a family member\n  - A family member marks a chore done\nConstraints:\n  - A member sees only their own chores"
    const t0 = { id: "T-8", kind: "question", from: { plugin: "zarg", agent: "zarg" }, title: change, why: "zarg asks", about: [], blocking: true, messages: [], state: "open", created: Date.now(), updated: 0, answers: [{ id: "add", label: "Add it", recommended: true }, { id: "skip", label: "Skip" }] }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-8": t0 } } as never }, big)
    t.mockInput.pressEnter(); await settle(t)
    const f = t.captureCharFrame()
    expect(f).toContain("A family member marks a chore done")
    expect(f).toContain("A member sees only their own chores")
  })
  test("a reply typed in one burst (as a fast typist or a paste) is sent whole, its r and t letters too", async () => {
    const t0 = { id: "T-9", kind: "question", from: { plugin: "zarg", agent: "zarg" }, title: "Which?", why: "zarg asks", about: [], blocking: true, messages: [], state: "open", created: Date.now(), updated: 0, answers: [{ id: "a", label: "A", recommended: true }, { id: "b", label: "B" }] }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-9": t0 } } as never }, big)
    t.mockInput.pressEnter(); await settle(t)
    t.mockInput.pressKey("r"); await settle(t)
    t.renderer.stdin.emit("data", Buffer.from("Nothing follows a refused mark"))
    await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    expect(t.calls).toContain("reply T-9 Nothing follows a refused mark")
  })
  test("an answered topic does not say it is waiting", async () => {
    const done = { id: "T-6", kind: "question", from: { plugin: "zarg", agent: "zarg" }, title: "Who uses it?", why: "zarg asks", about: [], blocking: true, messages: [], state: "answered", answer: { id: "a", by: "operator", at: 1 }, created: 1, updated: 1, answers: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-6": done } } as never }, big)
    t.mockInput.pressKey("a"); await settle(t)
    const row = t.captureCharFrame().split("\n").find((l) => l.includes("Who uses it?")) ?? ""
    expect(row).not.toContain("waiting")
  })
  test("from the inbox, ^k opens the palette and its zarg entry opens zarg's conversation", async () => {
    const t0 = { id: "T-5", kind: "report", from: { plugin: "rehearse" }, title: "Run done", why: "r", about: [], blocking: false, messages: [], state: "open", created: Date.now(), updated: 0 }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-5": t0 } } as never }, big)
    t.mockInput.pressKey("k", { ctrl: true }); await settle(t)
    expect(t.captureCharFrame()).toContain("the conversation")
    for (const ch of "zarg") t.mockInput.pressKey(ch)
    await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    expect(t.captureCharFrame()).toContain("zarg  Hello.")
  })
  test("^k opens the palette from the message bar too (it is not the line's)", async () => {
    const t = await render(viewState, big)
    t.mockInput.pressKey("m", { meta: true }); await settle(t)
    t.mockInput.pressKey("k", { ctrl: true }); await settle(t)
    expect(t.captureCharFrame()).toContain("the conversation")
  })
  test("^k opens the palette while zarg asks something (a question pending, its topic blocking)", async () => {
    const q = { id: "T-4", kind: "question", from: { plugin: "zarg", agent: "zarg" }, title: "Who uses it?", why: "zarg asks", about: [], blocking: true, messages: [], state: "open", created: Date.now(), updated: 0, answers: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
    const t = await render({ ...waiting, thread: { ...waiting.thread, inbox: { "T-4": q } } as never }, big)
    t.mockInput.pressKey("k", { ctrl: true }); await settle(t)
    expect(t.captureCharFrame()).toContain("the conversation")
  })
  test("a grant topic shows as the popover; its Enter answers the topic", async () => {
    const grant = { id: "T-9", kind: "grant", from: { plugin: "tracker" }, title: "Plugin tracker wants to reach a.test.", why: "grant", about: [], blocking: true, messages: [], state: "open", created: 1, updated: 1, answers: [{ id: "once", label: "Allow once", recommended: true }, { id: "deny", label: "Deny" }] }
    const t = await render({ ...viewState, thread: { ...viewState.thread, inbox: { "T-9": grant } } as never }, big)
    expect(t.captureCharFrame()).toContain("Plugin tracker wants to reach a.test.")
    await Bun.sleep(350)
    t.mockInput.pressEnter(); await settle(t)
    expect(t.calls).toContain("topic T-9 once")
  })
  test("arrival with nothing working: the grid behind zarg's open sheet", async () => {
    const t = await render(idleState, big)
    expect(t.captureCharFrame()).toContain("zarg  Hello.")
  })
  test("⏎ on a card opens its view; Esc comes back to the grid", async () => {
    const t = await toGrid(await render(two(), big))
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.captureCharFrame()).toContain("note R-1")
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.captureCharFrame()).toContain("all agents")
  })
  test("a click on a card opens its view", async () => {
    const t = await toGrid(await render(two(), big))
    const lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes("walking p:b"))
    await t.mockMouse.click(lines[y]!.indexOf("walking p:b") + 2, y)
    await settle(t)
    expect(t.captureCharFrame()).toContain("note R-2")
  })
  test("review: both agents' findings; a acts once per agent", async () => {
    const t = await render(two(), big)
    t.mockInput.pressKey("k", { ctrl: true })
    await t.mockInput.typeText("review")
    t.mockInput.pressEnter()
    await settle(t)
    const f = t.captureCharFrame()
    for (const r of ["note R-1", "note R-3", "note R-2"]) expect(f).toContain(r)
    t.mockInput.pressKey(" ")
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("down")
    t.mockInput.pressKey(" ")
    await settle(t)
    t.mockInput.pressKey("a")
    await settle(t)
    expect(t.calls).toContain("act p:a apply R-1")
    expect(t.calls).toContain("act p:b apply R-2")
  })
  test("^k, type, ⏎ opens that agent; no match says so", async () => {
    const t = await render(two(), big)
    t.mockInput.pressKey("k", { ctrl: true })
    await t.mockInput.typeText("zzz")
    await settle(t)
    expect(t.captureCharFrame()).toContain("nothing matches")
    t.mockInput.pressKey("escape")
    await settle(t)
    t.mockInput.pressKey("k", { ctrl: true })
    await t.mockInput.typeText("b")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.captureCharFrame()).toContain("note R-2")
  })
  test("at 80×24 the grid is one column", async () => {
    const t = await toGrid(await render(two(), { width: 80, height: 24 }))
    const lines = t.captureCharFrame().split("\n")
    const a = lines.findIndex((l) => l.includes("walking p:a"))
    const b = lines.findIndex((l) => l.includes("walking p:b"))
    expect(b).toBeGreaterThan(a)
  })
  test("the status line names the first agent asking", async () => {
    const s = two()
    const asked = { ...s, thread: { ...s.thread, rlms: { ...s.thread.rlms, "p:a": { ...s.thread.rlms["p:a"]!, attention: { reason: "3 findings to review", since: 1 } } } } }
    const t = await render(asked, big)
    expect(t.captureCharFrame().split("\n").filter((l) => l.trim().length > 0).at(-1)).toContain("◆ a 3 findings to review")
  })
})

describe("focus review fixes (frames)", () => {
  test("^k over zarg's open sheet: the typing goes to the palette, never to zarg", async () => {
    const t = await render(idleState, { width: 130, height: 32 })
    t.mockInput.pressKey("k", { ctrl: true })
    await settle(t)
    await t.mockInput.typeText("review")
    t.mockInput.pressEnter()
    await settle(t)
    expect(t.calls.filter((c) => c.startsWith("send"))).toEqual([])
    expect(t.captureCharFrame()).toContain("review")
  })
  test("attaching: the replay arrives after the first frame, and agents at work keep the sheet closed", async () => {
    const fake = fakeSession({ thread: { ...initial("main") }, core: "up" })
    const t = await testRender(<App session={fake.session} meta={meta} onExit={() => {}} />, { width: 130, height: 32, ...RENDERER })
    destroy = () => t.renderer.destroy()
    await t.renderOnce()
    const n = { id: "p:a", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], row: { text: "walking p:a" } }
    fake.update({ thread: { ...initial("main"), seq: 30, rlms: { "p:a": n }, messages: [{ id: "m1", role: "assistant", text: "Hello." }] }, core: "up" })
    await settle(t)
    expect(t.captureCharFrame()).toContain("Nothing needs you.")
    expect(t.captureCharFrame()).not.toContain("zarg  Hello.")
  })
})

describe("the inset sheet", () => {
  test("zarg's sheet rises from the bar inset over the grid: the top cards and the edges stay visible", async () => {
    const n = (id: string) => ({ id, parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], row: { text: `walking ${id}` } })
    const t = await toGrid(await render({ ...idleState, thread: { ...idleState.thread, rlms: { "p:a": n("p:a"), "p:b": n("p:b") } } }, { width: 130, height: 32 }))
    t.mockInput.pressKey("m", { meta: true })
    await settle(t)
    t.mockInput.pressKey("m", { meta: true })
    await settle(t)
    const lines = t.captureCharFrame().split("\n")
    const card = lines.findIndex((l) => l.includes("walking p:a"))
    const talk = lines.findIndex((l) => l.includes("zarg  Hello."))
    expect(card).toBeGreaterThanOrEqual(0)
    expect(talk).toBeGreaterThan(card)
    // Inset: a half-block lip a few columns right of the focus area's edge, then the header; no box-drawing border.
    const lip = lines.findIndex((l, i) => i > card && l.slice(24).includes("▄▄▄"))
    expect(lip).toBeGreaterThan(card)
    expect(lines[lip]!.indexOf("▄")).toBe(27)
    expect(lines[lip + 1]).toContain("zarg   esc closes")
    // The fill lines up with its edges: every cell of the header row, from the lip's first column to its last, is shaded; the conversation below is raised.
    const spans = t.captureSpans()
    const bgAt = (row: number, col: number) => {
      let x = 0
      for (const sp of spans.lines[row]!.spans) {
        if (col < x + sp.width) return sp.bg
        x += sp.width
      }
      return undefined
    }
    const hex = (c: { r: number; g: number; b: number } | undefined) => (c === undefined ? "" : `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`)
    const last = lines[lip]!.lastIndexOf("▄")
    expect(hex(bgAt(lip + 1, 27))).toBe(THEME.shade)
    expect(hex(bgAt(lip + 1, last))).toBe(THEME.shade)
    expect(hex(bgAt(lip + 1, 26))).toBe(THEME.bg)
    expect(hex(bgAt(lip + 2, 27))).toBe(THEME.raised)
  })
})

describe("action buttons", () => {
  const acts = [{ id: "apply", label: "Send to zarg", key: "a", on: "selection" as const }, { id: "dismiss", label: "Dismiss", key: "d", on: "selection" as const }]
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const withFindings = (review: boolean): SessionState => ({
    thread: {
      ...initial("main"),
      status: "running",
      rlms: { "rehearse:tester-1": tester },
      views: {
        "rehearse:tester-1": {
          agent: "rehearse:tester-1",
          layout: { name: "tester", sections: [{ id: "findings", kind: "table" as const, role: "pinned" as const, title: "Findings", columns: [{ id: "id", label: "id" }], selectable: true, actions: acts, ...(review ? { review: true } : {}) }] },
          data: { findings: { rows: [{ id: "R-1", cells: { id: "R-1" } }, { id: "R-2", cells: { id: "R-2" } }] } },
        },
      },
    },
    core: "up",
  })
  // The frame above the status line (which lists the keys, labels and all).
  const body = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n").slice(0, -2).join("\n")
  const clickOn = async (t: Awaited<ReturnType<typeof render>>, text: string) => {
    const lines = body(t).split("\n")
    const y = lines.findIndex((l) => l.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    await t.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
    await settle(t)
  }
  // The status line: the last line of the frame.
  const statusOf = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n").filter((l) => l.trim() !== "").at(-1)!
  test("in an agent's view: a table's actions are buttons under it, always there; none ticked, they act on the highlighted row", async () => {
    const t = await render(withFindings(false), { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    expect(body(t)).toContain("Send to zarg")
    expect(body(t)).not.toContain("Send to zarg ·")
    // The status line keeps no view keys: the buttons carry them.
    expect(statusOf(t)).not.toContain("Send to zarg")
    expect(statusOf(t)).not.toContain("sections")
    await clickOn(t, "Send to zarg")
    expect(t.calls).toContain("act rehearse:tester-1 apply R-1")
  })
  test("ticked rows: the buttons count them and act on them; sent, the count goes and the buttons stay", async () => {
    const t = await render(withFindings(false), { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    await clickOn(t, "○ R-2")
    const lines = t.captureCharFrame().split("\n")
    const button = lines.findIndex((l) => l.includes("Send to zarg · 1"))
    expect(button).toBeGreaterThan(lines.findIndex((l) => l.includes("● R-2")))
    expect(lines[button]).toContain("Dismiss")
    await clickOn(t, "Send to zarg")
    expect(t.calls).toContain("act rehearse:tester-1 apply R-2")
    expect(body(t)).not.toContain("Send to zarg ·")
    expect(body(t)).toContain("Send to zarg")
  })
  test("in the review queue: the same buttons under the queue, always there; a click acts on the selected rows' agent", async () => {
    const t = await render(withFindings(true), { width: 130, height: 32 })
    t.mockInput.pressKey("k", { ctrl: true }); await settle(t)
    await t.mockInput.typeText("review"); t.mockInput.pressEnter(); await settle(t)
    expect(body(t)).toContain("Dismiss")
    expect(statusOf(t)).not.toContain("dismiss")
    t.mockInput.pressKey(" "); await settle(t)
    await clickOn(t, "Dismiss")
    expect(t.calls).toContain("act rehearse:tester-1 dismiss R-1")
    expect(body(t)).toContain("Dismiss")
  })
  test("Clear drops the selection: the count and Clear go, nothing is sent", async () => {
    const t = await render(withFindings(false), { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    await clickOn(t, "○ R-2")
    await clickOn(t, "Clear")
    expect(body(t)).not.toContain("Send to zarg ·")
    expect(body(t)).not.toContain("Clear")
    expect(body(t)).toContain("○ R-2")
    expect(t.calls.filter((c) => c.startsWith("act"))).toEqual([])
  })
  test("a long one-paragraph text section shows as many wrapped lines as fit its share, not one", async () => {
    const long = "The testers walked every journey. ".repeat(20)
    const s = withFindings(false)
    const v = s.thread.views!["rehearse:tester-1"]!
    const withReport = { ...v, layout: { ...v.layout, sections: [{ id: "report", kind: "text" as const, role: "aside" as const, title: "Report" }, ...v.layout.sections] }, data: { ...v.data, report: { markdown: long } } }
    const t = await render({ ...s, thread: { ...s.thread, views: { "rehearse:tester-1": withReport } } }, { width: 130, height: 40 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    expect(body(t).split("\n").filter((l) => l.includes("walked every")).length).toBeGreaterThanOrEqual(3)
  })
})

describe("column menus", () => {
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const cols = [{ id: "id", label: "id" }, { id: "severity", label: "severity", order: ["high", "medium", "low"] }]
  const rows = [
    { id: "F1", cells: { id: "F1", severity: "low" } },
    { id: "F2", cells: { id: "F2", severity: "high" } },
    { id: "F3", cells: { id: "F3", severity: "medium" } },
  ]
  const state: SessionState = {
    thread: {
      ...initial("main"),
      status: "running",
      rlms: { "rehearse:tester-1": tester },
      views: {
        "rehearse:tester-1": {
          agent: "rehearse:tester-1",
          layout: { name: "tester", sections: [{ id: "findings", kind: "table" as const, role: "pinned" as const, title: "Findings", columns: cols, selectable: true, actions: [{ id: "apply", label: "Send to zarg", key: "a", on: "selection" as const }] }] },
          data: { findings: { rows } },
        },
      },
    },
    core: "up",
  }
  const open = async () => {
    const t = await render(state, { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    return t
  }
  const order = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n").flatMap((l) => l.match(/[○●] (F\d)/)?.[1] ?? [])
  test("↑ to the header, → to severity, Enter opens its menu; a sort reorders the rows and marks the header", async () => {
    const t = await open()
    t.mockInput.pressArrow("up"); await settle(t)
    t.mockInput.pressArrow("right"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("▲ high first")
    expect(frame).toMatch(/○ medium\s+0\/1/)
    t.mockInput.pressEnter(); await settle(t)
    t.mockInput.pressEscape(); await settle(t)
    expect(t.captureCharFrame()).not.toContain("▲ high first")
    expect(t.captureCharFrame()).toContain("severity ▲")
    expect(order(t)).toEqual(["F2", "F3", "F1"])
  })
  test("a click on a header opens its menu; a click on a value ticks its rows and the buttons show", async () => {
    const t = await open()
    let lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => /id\s+severity/.test(l))
    await t.mockMouse.click(lines[y]!.indexOf("severity") + 1, y)
    await settle(t)
    lines = t.captureCharFrame().split("\n")
    const v = lines.findIndex((l) => /○ high/.test(l))
    expect(v).toBeGreaterThanOrEqual(0)
    await t.mockMouse.click(lines[v]!.indexOf("high"), v)
    await settle(t)
    expect(t.captureCharFrame()).toMatch(/● high\s+1\/1/)
    // Esc closes the menu; the ticked row and its buttons stay.
    t.mockInput.pressEscape(); await settle(t)
    expect(t.captureCharFrame()).toContain("● F2")
    expect(t.captureCharFrame()).toContain("Send to zarg · 1")
  })
  test("a click outside an open menu closes it: on the rail, and on a row of its own table", async () => {
    const t = await open()
    for (const outside of ["rail", "row"] as const) {
      let lines = t.captureCharFrame().split("\n")
      const y = lines.findIndex((l) => /id\s+severity/.test(l))
      await t.mockMouse.click(lines[y]!.indexOf("severity") + 1, y)
      await settle(t)
      expect(t.captureCharFrame()).toContain("▲ high first")
      lines = t.captureCharFrame().split("\n")
      if (outside === "rail") await t.mockMouse.click(2, lines.length - 3)
      else { const r = lines.findIndex((l) => /[○●] F1/.test(l)); await t.mockMouse.click(lines[r]!.indexOf("F1"), r) }
      await settle(t)
      expect(t.captureCharFrame()).not.toContain("▲ high first")
    }
  })
})

describe("column filters and the row card", () => {
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const long = "The checkout step says pay but never says what happens when the card is declined; the tester had to guess and gave up on the purchase entirely."
  const cols = [
    { id: "id", label: "id", filter: "none" as const },
    { id: "sev", label: "severity", order: ["high", "medium", "low"], filter: "values" as const },
    { id: "suggested", label: "suggested", filter: { range: [0, 1] as const, step: 0.1 } },
    { id: "note", label: "note", filter: "search" as const },
  ]
  const rows = [
    { id: "F1", cells: { id: "F1", sev: "low", suggested: "fix 0.2", note: "login copy is unclear" } },
    { id: "F2", cells: { id: "F2", sev: "high", suggested: "fix 0.9", note: long } },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `G${i}`, cells: { id: `G${i}`, sev: `s${i}`, suggested: "", note: `other ${i}` } })),
  ]
  const state = (height: number): SessionState => ({
    thread: {
      ...initial("main"),
      status: "running",
      rlms: { "rehearse:tester-1": tester },
      views: {
        "rehearse:tester-1": {
          agent: "rehearse:tester-1",
          layout: {
            name: "tester",
            sections: [
              { id: "progress", kind: "stats" as const, role: "summary" as const },
              { id: "findings", kind: "table" as const, role: "pinned" as const, title: "Findings", columns: cols, selectable: true, actions: [{ id: "apply", label: "Send to zarg", key: "a", on: "selection" as const }] },
            ],
          },
          data: { progress: { items: [{ label: "steps", value: `${height}/9` }] }, findings: { rows } },
        },
      },
    },
    core: "up",
  })
  const open = async (height = 32) => {
    const t = await render(state(height), { width: 130, height })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    return t
  }
  const body = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n").slice(0, -2)
  test("the highlighted row shows in full under its table, the summary stays; a click on a row only moves the cursor, its mark ticks it", async () => {
    const t = await open()
    expect(t.captureCharFrame()).toContain("32/9")
    let lines = body(t)
    const y = lines.findIndex((l) => l.includes("F2   ") && l.includes("○"))
    await t.mockMouse.click(lines[y]!.indexOf("F2") + 4, y)
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("gave up on the purchase entirely.")
    expect(frame).toContain("▍○ F2")
    expect(frame).not.toContain("Send to zarg ·")
    lines = body(t)
    const z = lines.findIndex((l) => l.includes("▍○ F2"))
    await t.mockMouse.click(lines[z]!.indexOf("○"), z)
    await settle(t)
    expect(t.captureCharFrame()).toContain("▍● F2")
  })
  test("a menu drops down under its header and never past the view: it scrolls, with ▾ when more is below", async () => {
    const t = await open(24)
    t.mockInput.pressArrow("up"); await settle(t)
    t.mockInput.pressArrow("right"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    const lines = t.captureCharFrame().split("\n")
    const head = lines.findIndex((l) => /id\s+severity/.test(l))
    const top = lines.findIndex((l) => l.includes("╭─ severity"))
    const bottom = lines.findIndex((l, i) => i > top && l.includes("╰"))
    const bar = lines.findIndex((l) => l.includes("● zarg") || l.includes("type a message"))
    expect(top).toBe(head + 1)
    expect(bottom).toBeGreaterThan(top)
    expect(bottom).toBeLessThan(bar < 0 ? lines.length - 1 : bar)
    expect(lines[bottom]).toContain("▾")
  })
  test("a search menu takes the typing (g and / too) and sorts the rows by match as you type", async () => {
    const t = await open()
    t.mockInput.pressArrow("up"); await settle(t)
    for (let i = 0; i < 3; i++) { t.mockInput.pressArrow("right"); await settle(t) }
    t.mockInput.pressEnter(); await settle(t)
    await t.mockInput.typeText("g/declined")
    await settle(t)
    expect(t.captureCharFrame()).toContain("g/declined▎")
    for (let i = 0; i < 10; i++) { t.mockInput.pressBackspace(); await settle(t) }
    await t.mockInput.typeText("declined"); await settle(t)
    t.mockInput.pressEscape(); await settle(t)
    const rowsNow = t.captureCharFrame().split("\n").flatMap((l) => l.match(/[○●] (F\d|G\d)\s/)?.[1] ?? [])
    expect(rowsNow[0]).toBe("F2")
    expect(t.captureCharFrame()).toContain("note ⌕")
  })
  test("a range menu: a click on ▸ moves the bound, and its tick ticks the rows inside", async () => {
    const t = await open()
    t.mockInput.pressArrow("up"); await settle(t)
    for (let i = 0; i < 2; i++) { t.mockInput.pressArrow("right"); await settle(t) }
    t.mockInput.pressEnter(); await settle(t)
    let lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes("from") && l.includes("◂"))
    for (let i = 0; i < 5; i++) {
      await t.mockMouse.click(lines[y]!.indexOf("▸"), y)
      await settle(t)
    }
    expect(t.captureCharFrame()).toMatch(/from\s+◂ 0\.50 ▸/)
    t.mockInput.pressArrow("down"); await settle(t)
    t.mockInput.pressArrow("down"); await settle(t)
    t.mockInput.pressArrow("down"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    lines = t.captureCharFrame().split("\n")
    expect(t.captureCharFrame()).toMatch(/● tick those in range\s+1\/1/)
  })
})

describe("tabs, the fixed card, breathing room", () => {
  const tester = { id: "rehearse:run", parent: null, preset: "run", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const cols = [{ id: "id", label: "id", filter: "none" as const }, { id: "note", label: "note", filter: "search" as const }]
  const long = "a long note ".repeat(40)
  const state: SessionState = {
    thread: {
      ...initial("main"),
      status: "running",
      rlms: { "rehearse:run": tester },
      views: {
        "rehearse:run": {
          agent: "rehearse:run",
          layout: {
            name: "run",
            sections: [
              { id: "report", kind: "text" as const, role: "aside" as const, title: "Report" },
              { id: "review", kind: "tabs" as const, role: "pinned" as const, tabs: [{ id: "findings", kind: "table" as const, title: "Findings", columns: cols, selectable: true }, { id: "likes", kind: "table" as const, title: "Likes", columns: cols, selectable: true }] },
            ],
          },
          data: {
            report: { markdown: "The run went fine." },
            "review.findings": { rows: [{ id: "F1", cells: { id: "F1", note: long } }, { id: "F2", cells: { id: "F2", note: "short" } }] },
            "review.likes": { rows: [{ id: "L1", cells: { id: "L1", note: "liked the flow" } }] },
          },
        },
      },
    },
    core: "up",
  }
  const open = async () => {
    const t = await render(state, { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    return t
  }
  const lines = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n")
  test("the tabs: the current one underlined; a click on another shows its rows", async () => {
    const t = await open()
    let ls = lines(t)
    const y = ls.findIndex((l) => l.includes("Findings 2") && l.includes("Likes 1"))
    expect(ls[y + 1]!.slice(ls[y]!.indexOf("Findings"), ls[y]!.indexOf("Findings") + 10)).toBe("▔".repeat(10))
    await t.mockMouse.click(ls[y]!.indexOf("Likes") + 1, y)
    await settle(t)
    // The click focused the section: the row card shows above it, so find the tabs again.
    ls = lines(t)
    const z = ls.findIndex((l) => l.includes("Findings 2") && l.includes("Likes 1"))
    expect(t.captureCharFrame()).toContain("▍○ L1")
    expect(ls[z + 1]!.slice(ls[z]!.indexOf("Likes"), ls[z]!.indexOf("Likes") + 7)).toBe("▔".repeat(7))
  })
  test("the row card sits under its table, a blank row between, as tall as its row needs; the heading above stays put", async () => {
    const t = await open()
    t.mockInput.pressKey("]"); await settle(t)
    const at = () => lines(t).findIndex((l) => l.includes("Findings 2"))
    const before = at()
    let ls = lines(t)
    const last = ls.findIndex((l) => l.includes("○ F2"))
    expect(ls[last + 1]!.slice(24).trim()).toBe("")
    // A panel, not a row: an accent bar, no ○.
    expect(ls[last + 2]).toContain("┃ F1")
    expect(ls[last + 2]).not.toContain("○")
    expect(ls.findIndex((l, i) => i > last && l.includes("a long note a long note"))).toBeGreaterThan(last + 2)
    t.mockInput.pressArrow("down"); await settle(t)
    ls = lines(t)
    expect(t.captureCharFrame()).toContain("▍○ F2")
    expect(at()).toBe(before)
    // A short row: a short card (its line, with its note inline).
    const card = ls.findIndex((l, i) => i > last + 1 && l.includes("┃ F2"))
    expect(ls[card]).toContain("note short")
    // A blank row under the card too.
    expect(ls[card + 1]!.slice(24).trim()).toBe("")
    expect(ls.slice(card + 1).some((l) => l.includes("a long note a long"))).toBe(false)
  })
  test("a full table: its card keeps a blank row under it, above the bar", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `M${i}`, cells: { id: `M${i}`, note: "short" } }))
    const v = state.thread.views!["rehearse:run"]!
    const full = { ...state, thread: { ...state.thread, views: { "rehearse:run": { ...v, data: { ...v.data, "review.findings": { rows: many } } } } } }
    const t = await render(full, { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    t.mockInput.pressKey("]"); await settle(t)
    const ls = lines(t)
    const card = ls.findIndex((l) => l.includes("┃ M0"))
    expect(card).toBeGreaterThan(0)
    expect(ls[card + 1]!.slice(24).trim()).toBe("")
  })
  test("a blank row between one section and the next", async () => {
    const t = await open()
    const ls = lines(t)
    const report = ls.findIndex((l) => l.includes("The run went fine."))
    const tabs = ls.findIndex((l) => l.includes("Findings 2"))
    expect(tabs).toBe(report + 2)
    expect(ls[report + 1]!.slice(24).trim()).toBe("")
  })
})

describe("nav items above the agents", () => {
  const nav = [{ id: "gherkin:journeys", plugin: "gherkin", name: "journeys", label: "Journeys", view: "gherkin:journeys@journeys" }]
  const journeysView = {
    agent: "gherkin:journeys@journeys",
    layout: {
      name: "journeys",
      sections: [
        { id: "list", kind: "table" as const, role: "primary" as const, title: "Journeys", columns: [{ id: "name", label: "journey" }, { id: "cards", label: "cards" }], actions: [{ id: "show", label: "Show", key: "s", on: "row" as const, default: true }] },
        { id: "flow", kind: "text" as const, role: "pinned" as const, title: "Flow", follows: "list" },
      ],
    },
    data: {
      list: { rows: [{ id: "J-0002", cells: { name: "Browse", cards: "1" } }, { id: "J-0001", cells: { name: "Checkout", cards: "2" } }] },
      flow: {
        markdown: "No journeys yet.",
        rows: {
          "J-0002": "```gherkin\nBrowse  # J-0002 · 1 card\n\nS-0001 Visitor opens pricing\n  Given the visitor is on the home page  # ST-0001\n```",
          "J-0001": "```text\nCheckout  # J-0001 · 2 cards\n\nS-0004 Payment succeeds\n```",
        },
      },
    },
  }
  const tester = { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const state: SessionState = { thread: { ...initial("main"), status: "idle", rlms: { "rehearse:t1": tester }, nav, views: { "gherkin:journeys@journeys": journeysView } }, core: "up" }
  const big = { width: 130, height: 32 }

  test("the rail lists nav items above the agents header; agents stay below as they were", async () => {
    const t = await render(state, big)
    const lines = t.captureCharFrame().split("\n").map((l) => l.slice(0, 24))
    const journeys = lines.findIndex((l) => l.includes("Journeys"))
    const agents = lines.findIndex((l) => l.includes("AGENTS"))
    const row = lines.findIndex((l) => l.includes("t1"))
    expect(journeys).toBeGreaterThanOrEqual(0)
    expect(agents).toBeGreaterThan(journeys)
    expect(row).toBeGreaterThan(agents)
  })

  test("keys: up from the first agent reaches Journeys; Enter opens its view and asks gherkin to fill it", async () => {
    const t = await render(state, big)
    t.mockInput.pressKey("a", { meta: true }); await settle(t)
    t.mockInput.pressArrow("up"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    expect(t.calls).toContain("act gherkin:journeys open ")
    const frame = t.captureCharFrame()
    // The Flow follows the table: no row card repeats the highlighted journey under it.
    expect(frame).not.toContain("┃ Browse")
    // Its header is the nav item's label, not an agent id.
    expect(frame).not.toContain("gherkin:journeys")
    expect(frame).toContain("Browse")
    expect(frame).toContain("Given the visitor is on the home page")
    // The flow is highlighted: its keywords in the accent colour.
    const given = t.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text.includes("Given"))!
    expect(`#${[given.fg.r, given.fg.g, given.fg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`).toBe(THEME.accent)
    // Moving the highlight to another journey shows its flow at once (no round trip to the plugin).
    t.mockInput.pressArrow("down"); await settle(t)
    expect(t.captureCharFrame()).toContain("Checkout  # J-0001")
    expect(t.captureCharFrame()).not.toContain("Browse  # J-0002")
    expect(t.calls.filter((c) => c.startsWith("act"))).toEqual(["act gherkin:journeys open "])
  })

  test("a column menu drops over the Flow below it: nothing of the Flow shows through", async () => {
    const t = await render(state, big)
    t.mockInput.pressKey("a", { meta: true }); await settle(t)
    t.mockInput.pressArrow("up"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    t.mockInput.pressArrow("up"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    const lines = t.captureCharFrame().split("\n")
    const top = lines.findIndex((l) => l.includes("╭─ journey"))
    const bottom = lines.findIndex((l, i) => i > top && l.includes("╰"))
    const inside = lines.slice(top, bottom + 1).join("\n")
    expect(top).toBeGreaterThan(0)
    // The Flow heading and text sit under the menu here: they must not show inside its box.
    expect(inside).not.toMatch(/Flow|Given the visitor/)
  })

  test("a click on the nav item opens it too", async () => {
    const t = await render(state, big)
    const lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.slice(0, 24).includes("Journeys"))
    await t.mockMouse.click(lines[y]!.indexOf("Journeys") + 1, y)
    await settle(t)
    expect(t.calls).toContain("act gherkin:journeys open ")
    expect(t.captureCharFrame()).toContain("Checkout")
  })
})

describe("table search and a detail beside its list", () => {
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
  const rows = [
    { id: "F1", cells: { card: "S-0035", kind: "transition" }, search: "The prior step promised local-first ordering" },
    { id: "F2", cells: { card: "S-0062", kind: "friction" }, search: "The grant question names scope and target" },
    { id: "F3", cells: { card: "S-0062", kind: "gap" }, search: "No failure path when the operator denies the grant" },
  ]
  const state: SessionState = {
    thread: {
      ...initial("main"),
      status: "running",
      rlms: { "rehearse:tester-1": tester },
      views: {
        "rehearse:tester-1": {
          agent: "rehearse:tester-1",
          layout: {
            name: "tester",
            sections: [
              { id: "findings", kind: "table" as const, role: "pinned" as const, title: "Findings", search: true, selectable: true, columns: [{ id: "card", label: "card" }, { id: "kind", label: "kind" }], actions: [{ id: "apply", label: "Send to zarg", key: "a", on: "selection" as const }] },
              { id: "detail", kind: "text" as const, role: "pinned" as const, title: "", follows: "findings", beside: "findings" },
            ],
          },
          data: { findings: { rows }, detail: { markdown: "", rows: { F1: "local-first ordering detail", F2: "grant question detail", F3: "failure path detail" } } },
        },
      },
    },
    core: "up",
  }
  const open = async () => {
    const t = await render(state, { width: 130, height: 32 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    return t
  }
  const lines = (t: Awaited<ReturnType<typeof render>>) => t.captureCharFrame().split("\n")
  test("the detail sits beside its list: the list on the left, the highlighted row's detail on the right, from the list's top", async () => {
    const t = await open()
    const ls = lines(t)
    const top = ls.findIndex((l) => l.includes("Findings ─"))
    expect(ls[top]).toContain("local-first ordering detail")
    expect(ls[top]!.indexOf("local-first")).toBeGreaterThan(ls[top]!.indexOf("Findings"))
    // Moving the highlight changes the detail beside it.
    t.mockInput.pressArrow("down"); await settle(t)
    expect(lines(t)[top]).toContain("grant question detail")
  })
  test("f types into the search: the list narrows, best first, with a count; the typing reaches no shell key; Esc brings every row back", async () => {
    const t = await open()
    expect(t.captureCharFrame()).toContain("⌕ search")
    t.mockInput.pressKey("f"); await settle(t)
    await t.mockInput.typeText("grant g/"); await settle(t)
    t.mockInput.pressBackspace(); t.mockInput.pressBackspace(); t.mockInput.pressBackspace(); await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("⌕ grant▎")
    expect(frame).toContain("2 of 3")
    expect(frame).not.toContain("S-0035")
    t.mockInput.pressEscape(); await settle(t)
    expect(t.captureCharFrame()).toContain("S-0035")
    expect(t.captureCharFrame()).not.toContain("2 of 3")
  })
  test("the search field stays at the top while the rows scroll under it", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `M${i}`, cells: { card: `S-${String(i).padStart(4, "0")}`, kind: "gap" } }))
    const v = state.thread.views!["rehearse:tester-1"]!
    const long = { ...state, thread: { ...state.thread, views: { "rehearse:tester-1": { ...v, data: { ...v.data, findings: { rows: many } } } } } }
    const t = await render(long, { width: 130, height: 24 })
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    for (let i = 0; i < 35; i++) t.mockInput.pressArrow("down")
    await settle(t); await Bun.sleep(30); await settle(t)
    const ls = lines(t)
    expect(t.captureCharFrame()).toContain("S-0035")
    expect(t.captureCharFrame()).not.toContain("S-0000")
    const field = ls.findIndex((l) => l.includes("⌕ search"))
    expect(field).toBeGreaterThan(0)
    expect(field).toBeLessThan(ls.findIndex((l) => l.includes("S-0035")))
  })
  test("Enter leaves the field with the search kept; a click on the field types into it again", async () => {
    const t = await open()
    t.mockInput.pressKey("f"); await settle(t)
    await t.mockInput.typeText("prior"); await settle(t)
    t.mockInput.pressEnter(); await settle(t)
    expect(t.captureCharFrame()).toContain("1 of 3")
    expect(t.captureCharFrame()).not.toContain("⌕ prior▎")
    const ls = lines(t)
    const y = ls.findIndex((l) => l.includes("⌕ prior"))
    await t.mockMouse.click(ls[y]!.indexOf("⌕") + 2, y); await settle(t)
    expect(t.captureCharFrame()).toContain("⌕ prior▎")
  })
})

describe("the theme", () => {
  test("with the 16-colour palette the cursor row still differs from the rows around it", async () => {
    const theme = makeTheme(PALETTES["terminal.ansi16"], "terminal.ansi16")
    const t = await render(viewState, { width: 110, height: 24 }, theme)
    t.mockInput.pressKey("a", { meta: true })
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
    const spans = t.captureSpans().lines.flatMap((l) => l.spans)
    const cursor = spans.find((s) => s.text.includes("▍"))!
    expect(hex(cursor.bg)).toBe(theme.value("selection").fg)
    expect(hex(cursor.bg)).not.toBe(theme.value("ground").fg)
  })
})

describe("clicking through the rail", () => {
  const nav = [
    { id: "gherkin:journeys", plugin: "gherkin", name: "journeys", label: "Journeys", view: "gherkin:journeys@journeys" },
    { id: "backlog:feedback", plugin: "backlog", name: "feedback", label: "Feedback", view: "backlog:feedback@feedback" },
    { id: "backlog:backlog", plugin: "backlog", name: "backlog", label: "Backlog", view: "backlog:backlog@backlog" },
  ]
  const view = (v: string, name: string) => ({ agent: v, layout: { name, sections: [{ id: "t", kind: "text" as const, role: "primary" as const, title: "" }] }, data: { t: { markdown: name } } })
  const state: SessionState = {
    thread: {
      ...initial("main"),
      status: "idle",
      nav,
      views: Object.fromEntries(nav.map((n) => [n.view, view(n.view, n.name)])),
      rlms: {
        "rlm-1": { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 1, budget: 25, status: "done", decisions: [] },
        "rehearse:run": { id: "rehearse:run", parent: null, preset: "rehearse", depth: 0, turns: 0, budget: 1, status: "done", decisions: [] },
      },
    },
    core: "up",
  }
  test("clicking nav items and agents never draws a row twice", async () => {
    const t = await render(state, { width: 110, height: 30 })
    const railLines = () => t.captureCharFrame().split("\n").map((l) => l.slice(0, 24))
    for (const label of ["Feedback", "Journeys", "Backlog", "Journeys", "Feedback"]) {
      const y = railLines().findIndex((l) => l.includes(label))
      await t.mockMouse.click(railLines()[y]!.indexOf(label) + 1, y)
      await settle(t)
      const rail = railLines()
      for (const l of ["Journeys", "Feedback", "Backlog"]) expect(`${label}: ${rail.filter((x) => x.includes(l)).length}`).toBe(`${label}: 1`)
    }
  })
  test("clicking the rail many times adds no listeners that pile up", async () => {
    const warnings: Array<string> = []
    const onWarning = (w: Error) => void warnings.push(`${w.name}: ${w.message}`)
    process.on("warning", onWarning)
    try {
      const t = await render(state, { width: 110, height: 30 })
      const railLines = () => t.captureCharFrame().split("\n").map((l) => l.slice(0, 24))
      for (let i = 0; i < 30; i++) {
        const label = ["Feedback", "Journeys", "Backlog", "driver", "rehearse"][i % 5]!
        const y = railLines().findIndex((l) => l.includes(label))
        if (y < 0) continue
        await t.mockMouse.click(railLines()[y]!.indexOf(label) + 1, y)
        await settle(t)
      }
      await Bun.sleep(50)
      console.error("WARNINGS", JSON.stringify(warnings))
      expect(warnings.filter((w) => /MaxListeners/.test(w))).toEqual([])
    } finally {
      process.off("warning", onWarning)
    }
  })
  test("a board with many lanes (a scroll box each) raises no listener warning that would print over the screen", async () => {
    const warnings: Array<string> = []
    const onWarning = (w: Error) => void warnings.push(w.name)
    process.on("warning", onWarning)
    try {
      const board = { agent: "backlog:backlog@backlog", layout: { name: "backlog", sections: [{ id: "board", kind: "board" as const, role: "primary" as const, title: "" }] }, data: { board: { lanes: Array.from({ length: 14 }, (_, i) => ({ id: `l${i}`, title: `L${i}`, cards: [{ id: `c${i}`, title: "a card" }] })) } } }
      const s: SessionState = { ...state, thread: { ...state.thread, views: { ...state.thread.views, "backlog:backlog@backlog": board } } }
      const t = await render(s, { width: 200, height: 30 })
      const railLines = () => t.captureCharFrame().split("\n").map((l) => l.slice(0, 24))
      const y = railLines().findIndex((l) => l.includes("Backlog"))
      await t.mockMouse.click(railLines()[y]!.indexOf("Backlog") + 1, y)
      await settle(t)
      await Bun.sleep(20)
      expect(warnings.filter((w) => /MaxListeners/.test(w))).toEqual([])
    } finally {
      process.off("warning", onWarning)
    }
  })
})
