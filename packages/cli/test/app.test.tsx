import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { type Answer, initial, type Inquiry, type Session, type SessionState } from "@zarg/client"
import { App } from "../src/tui/app"

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
    act: (agent, action, rows) => Promise.resolve(void calls.push(`act ${agent} ${action} ${rows.join(",")}`)),
    body: (agent) =>
      Promise.resolve(
        agent.includes(":")
          ? { parts: [{ kind: "history" as const, lines: [{ type: "step", rlm: agent, turn: 0, text: "UX-1: feel 1.80", cells: [] }] }, { kind: "tabs" as const, tabs: [{ title: "Feedback", columns: ["id", "note"], rows: [{ id: "R-1", cells: ["R-1", "no error shown"] }] }, { title: "Likes", columns: ["id", "note"], rows: [] }], actions: [{ id: "apply", label: "Apply", key: "a" }] }] }
          : { parts: [{ kind: "history" as const, lines: [{ type: "start", rlm: agent, preset: "research", task: "Find the VM grid" }, { type: "call", rlm: agent, turn: 1, service: "Graph", method: "show", params: { id: "S-1" }, ok: true, result: {}, ms: 11 }] }] },
      ),
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
    expect(t.captureCharFrame()).toContain("Conversation")
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

  test("Enter on an agent shows its history in place of the conversation; Escape goes back", async () => {
    const t = await render(waiting)
    t.mockInput.pressTab()
    t.mockInput.pressArrow("down")
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const open = t.captureCharFrame()
    expect(open).toContain("Agent rlm-2 · Esc back")
    expect(open).toContain("research rlm-2: Find the VM grid")
    expect(open).toContain('Graph.show {"id":"S-1"}  11ms')
    expect(t.captureCharFrame()).toContain("research rlm-2: Find the VM grid")
    t.mockInput.pressEscape()
    await settle(t)
    expect(t.captureCharFrame()).toContain("The agenda is empty.")
    expect(t.captureCharFrame()).not.toContain("Esc back")
  })

  test("a plugin agent's body: history, a Feedback table, and a key that acts on the highlighted row", async () => {
    const tester = { id: "rehearse:tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [] }
    const t = await render({ thread: { ...initial("main"), status: "running", rlms: { "rehearse:tester-1": tester } }, core: "up" })
    t.mockInput.pressTab()
    await settle(t)
    t.mockInput.pressEnter()
    await settle(t)
    await Bun.sleep(30)
    await settle(t)
    const frame = t.captureCharFrame()
    expect(frame).toContain("UX-1: feel 1.80")
    expect(frame).toContain("[Feedback]  Likes")
    expect(frame).toContain("▸ [ ] R-1  no error shown")
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
})
