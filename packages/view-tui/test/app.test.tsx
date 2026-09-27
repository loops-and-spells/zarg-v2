import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { type Answer, initial, type Inquiry, type Session, type SessionState } from "@zarg/client"
import { App } from "../src/app"

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
    act: (agent, action, _section, rows) => Promise.resolve(void calls.push(`act ${agent} ${action} ${rows.join(",")}`)),
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

const meta = { threadId: "main", driver: "zarg-router:deepseek-v4.1-flash-exl3", mode: "child" as const }
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
const render = async (state: SessionState, size = { width: 110, height: 24 }) => {
  const fake = fakeSession(state)
  let exited = false
  const t = await testRender(<App session={fake.session} meta={meta} onExit={() => (exited = true)} />, { ...size, ...RENDERER })
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

describe("tui frames", () => {
  const testerView = {
    agent: "rehearse:tester-1",
    layout: { name: "tester", sections: [{ id: "steps", kind: "log" as const, role: "log" as const, title: "Steps" }, { id: "review", kind: "tabs" as const, role: "pinned" as const, tabs: [{ id: "findings", kind: "table" as const, title: "Findings", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" as const }] }] }] },
    data: { steps: { lines: [{ text: "UX-1: feel 1.80" }] }, "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1" } }, { id: "R-2", cells: { id: "R-2" } }] } },
  }
  const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], attention: { reason: "2 findings to review", since: 1 } }
  const withTester: SessionState = { ...waiting, thread: { ...waiting.thread, rlms: { ...waiting.thread.rlms, "rehearse:tester-1": tester }, views: { "rehearse:tester-1": testerView } } }
  const openTester = async (size: { width: number; height: number }) => {
    const t = await render(withTester, size)
    t.mockInput.pressTab()
    await settle(t)
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    return t
  }

  test("wide: zarg, the open agent and the agents tree side by side; Alt+arrows move between them", async () => {
    const t = await openTester({ width: 130, height: 22 })
    const top = t.captureCharFrame().split("\n")[0]!
    expect(top).toMatch(/^┌─zarg.*┌─rehearse:tester-1.*┌─Agents/)
    // The open view has focus: arrows move its table, not zarg's question.
    t.mockInput.pressArrow("down")
    await settle(t)
    expect(t.captureCharFrame()).toContain("▸ [ ] R-2")
    expect(t.captureCharFrame()).toContain("› Checkout (recommended)")
    // Alt+left: zarg's tile takes the keys; now arrows move the question.
    t.mockInput.pressArrow("left", { meta: true })
    await settle(t)
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame()).toContain("› Login")
    // Alt+right twice: the view, then the agents.
    t.mockInput.pressArrow("right", { meta: true })
    t.mockInput.pressArrow("right", { meta: true })
    await settle(t)
    t.mockInput.pressKey("escape")
    await settle(t)
    expect(t.captureCharFrame().split("\n")[0]).toMatch(/┌─rehearse:tester-1/)
  })

  test("at 80×24 zarg is above the view and the strip lists attention", async () => {
    const t = await openTester({ width: 80, height: 24 })
    const lines = t.captureCharFrame().split("\n")
    expect(lines[0]).toContain("tester-1")
    const zarg = lines.findIndex((l) => l.startsWith("┌─zarg"))
    const view = lines.findIndex((l) => l.startsWith("┌─rehearse:tester-1"))
    expect(zarg).toBeGreaterThan(0)
    expect(view).toBeGreaterThan(zarg)
  })

  test("Escape in the view tile closes it and gives the keys back to zarg", async () => {
    const t = await openTester({ width: 130, height: 22 })
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.captureCharFrame().split("\n")[0]).not.toContain("tester-1 ·")
    t.mockInput.pressArrow("up")
    await settle(t)
    expect(t.captureCharFrame()).toContain("› Login")
  })

  test("zarg's conversation is a tile: its messages and its question inside it, beside the agents", async () => {
    const t = await render(waiting)
    const lines = t.captureCharFrame().split("\n")
    expect(lines[0]).toMatch(/^┌─zarg─/)
    // The question sits inside zarg's tile: nothing spans the whole width under the tiles but the status line.
    expect(lines.at(-3)).toMatch(/^└─+┘└─+┘\s*$/)
    expect(lines.findIndex((l) => l.includes("Which card first?"))).toBeGreaterThan(0)
    expect(lines.find((l) => l.includes("Which card first?"))).toMatch(/│\s*$/)
  })

  test("an inquiry: picker with the recommended option preselected and its why; agents pane; status line", async () => {
    const t = await render(waiting)
    const frame = t.captureCharFrame()
    expect(frame).toContain("Which card first?")
    expect(frame).toContain("› Checkout (recommended) — most used")
    expect(frame).toContain("  Something else:")
    expect(frame).toContain("  Chat about this")
    expect(frame).not.toContain("Message")
    expect(frame).toContain("▾ ● driver rlm-1      ▰▱▱▱▱▱  3/25")
    expect(frame).toContain("  └ ✓ research rlm-2  ▰▱▱▱▱▱  2/15")
    expect(frame).toContain("driver rlm-1 · running")
    expect(frame).toContain("turn 3 of 25 · 5,847 tokens")
    expect(frame).toContain("  single          yes  0.91")
    expect(frame).toContain("core child · waiting · thread main · zarg-router:deepseek-v4.1-flash-exl3")
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
    expect(t.captureCharFrame()).toContain("┌─zarg")
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

  test("Tab moves focus to the agents pane, where the highlight walks a tall tree and the detail follows", async () => {
    const rlms = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`rlm-${i + 1}`, { id: `rlm-${i + 1}`, parent: i === 0 ? null : "rlm-1", preset: i === 0 ? "driver" : "research", depth: i === 0 ? 0 : 1, turns: 1, budget: 15, status: "done" as const, decisions: [] }]),
    )
    const t = await render({ thread: { ...initial("main"), status: "running", rlms }, core: "up" })
    expect(t.captureCharFrame()).not.toContain("rlm-40 ")
    t.mockInput.pressTab()
    await settle(t)
    for (let i = 0; i < 40; i++) t.mockInput.pressArrow("down")
    await settle(t)
    expect(t.captureCharFrame()).toContain("research rlm-40")
    expect(t.captureCharFrame()).toContain("research rlm-40 · done")
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

  test("Enter on an agent shows its view in place of the conversation; Escape goes back", async () => {
    const rlmView = {
      agent: "rlm-2",
      layout: { name: "rlm", sections: [{ id: "status", kind: "stats" as const, role: "summary" as const }, { id: "history", kind: "log" as const, role: "log" as const, title: "History" }] },
      data: { status: { items: [{ label: "turns", value: "2/15" }] }, history: { lines: [{ text: "research rlm-2: Find the VM grid" }, { text: '  Graph.show {"id":"S-1"}  11ms', tone: "dim" as const }] } },
    }
    const t = await render({ ...waiting, thread: { ...waiting.thread, views: { "rlm-2": rlmView } } })
    t.mockInput.pressTab()
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const open = t.captureCharFrame()
    expect(open).toContain("rlm-2 · Esc back")
    expect(open).toContain("2/15 turns")
    // The view tile sits beside zarg's now: its lines are cut at its width.
    expect(open).toContain("research rlm-2: Find")
    expect(open).toContain('Graph.show {"id":"S-1"}  11ms')
    expect(t.captureCharFrame()).toContain("research rlm-2: Find")
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.captureCharFrame()).toContain("The agenda is empty.")
    expect(t.captureCharFrame()).not.toContain("Esc back")
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
      data: { steps: { lines: [{ text: "UX-1: feel 1.80" }] }, "review.findings": { rows: [{ id: "R-1", cells: { id: "R-1", note: "no error shown" } }] } },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "rehearse:tester-1": tester }, views: { "rehearse:tester-1": view } }, core: "up" })
    t.mockInput.pressTab()
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("UX-1: feel 1.80")
    expect(frame).toContain("[Findings (1)]  Likes (0)")
    // The view opens on its table: its highlighted row takes the action at once.
    expect(t.captureCharFrame()).toContain("▸ [ ] R-1  no error shown")
    // A click on a row's box ticks it.
    const lines = t.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes("[ ] R-1"))
    await t.mockMouse.click(lines[y]!.indexOf("[ ]") + 1, y)
    await settle(t)
    expect(t.captureCharFrame()).toContain("[x] R-1")
    t.mockInput.pressKey("a")
    await settle(t)
    expect(t.calls).toContain("act rehearse:tester-1 apply R-1")
  })

  test("the agents pane folds: → opens a child's subtree, ← closes it", async () => {
    const rlms = {
      "rlm-1": { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 1, budget: 25, status: "running" as const, decisions: [] },
      "rlm-2": { id: "rlm-2", parent: "rlm-1", preset: "research", depth: 1, turns: 1, budget: 15, status: "running" as const, decisions: [] },
      "rlm-3": { id: "rlm-3", parent: "rlm-2", preset: "research", depth: 2, turns: 1, budget: 15, status: "failed" as const, error: "budget", decisions: [] },
    }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms }, core: "up" })
    expect(t.captureCharFrame()).toContain("▸ ● research rlm-2")
    expect(t.captureCharFrame()).not.toContain("rlm-3")
    t.mockInput.pressTab()
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("right")
    t.mockInput.pressArrow("down")
    await settle(t)
    const open = t.captureCharFrame()
    expect(open).toContain("    └ ✗ research rlm-3")
    expect(open).toContain("error  budget")
    t.mockInput.pressArrow("left")
    t.mockInput.pressArrow("left")
    await settle(t)
    expect(t.captureCharFrame()).not.toContain("rlm-3")
  })

  test("typing / shows the command box; Tab completes; Enter runs the command", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    await t.mockInput.typeText("/re")
    await t.waitForVisualIdle()
    const frame = t.captureCharFrame()
    expect(frame).toContain("commands")
    expect(frame).toContain("/reconcile  turn plan and implement on for this session")
    // Tab writes the completion into the input itself (the box row alone would not prove it).
    t.mockInput.pressTab()
    await t.waitForVisualIdle()
    const messageLine = (frame: string) => frame.split("\n").find((l, i, all) => i > 0 && all[i - 1]!.includes("Message")) ?? ""
    expect(messageLine(t.captureCharFrame())).toContain("/reconcile")
    t.mockInput.pressEnter()
    await t.waitForVisualIdle()
    expect(t.calls).toEqual(["command /reconcile"])
  })

  test("a key typed right after Tab lands after the completion", async () => {
    const t = await render({ thread: { ...initial("main"), status: "idle" }, core: "up" })
    await t.mockInput.typeText("/re")
    await t.waitForVisualIdle()
    t.mockInput.pressTab()
    await t.mockInput.typeText("x")
    await t.waitForVisualIdle()
    const line = t.captureCharFrame().split("\n").find((l, i, all) => i > 0 && all[i - 1]!.includes("Message")) ?? ""
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

  test("a question replaces the Message box; Something else… is typed in the picker and answers", async () => {
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

  test("Chat about this brings the Message box back; what you type there is sent as a message", async () => {
    const t = await render(waiting)
    t.mockInput.pressArrow("down")
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("Chat about: Which card first?")
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
    t.mockInput.pressTab()
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    const f = t.captureCharFrame()
    for (const title of ["Workers", "Steps", "Findings"]) expect(f).toContain(title)
    // The question is zarg's: it stays in zarg's tile, above the open view, never over it.
    const lines = f.split("\n")
    const viewTop = lines.findIndex((l) => l.startsWith("┌─rehearse:tester-1"))
    expect(lines.findIndex((l) => l.includes("Which card first?"))).toBeLessThan(viewTop)
  })
})
