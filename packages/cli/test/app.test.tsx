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
  const t = await testRender(<App session={fake.session} meta={meta} onExit={() => (exited = true)} />, size)
  destroy = () => t.renderer.destroy()
  await t.waitForVisualIdle()
  return { ...t, ...fake, exited: () => exited }
}

describe("tui frames", () => {
  test("an inquiry: picker with the recommended option preselected and its why; agents pane; status line", async () => {
    const t = await render(waiting)
    const frame = t.captureCharFrame()
    expect(frame).toContain("Which card first?")
    expect(frame).toContain("› Checkout (recommended) — most used")
    expect(frame).toContain("  Something else…")
    expect(frame).toContain("driver rlm-1  3/25 5847 tok  running")
    expect(frame).toContain("  research rlm-2  2/15  done")
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

  test("at 80 columns with a long thread and driver, the status line still shows the core state and thread status", async () => {
    const fake = fakeSession({ thread: { ...initial("feature-checkout-refactor"), status: "error" }, core: "down" })
    const t = await testRender(
      <App session={fake.session} meta={{ threadId: "feature-checkout-refactor", driver: "openrouter:anthropic/claude-sonnet-4.5", mode: "child" }} onExit={() => {}} />,
      { width: 80, height: 24 },
    )
    destroy = () => t.renderer.destroy()
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).toContain("core stopped · error")
  })

  test("Tab moves focus to the agents pane, where arrows scroll a tall tree", async () => {
    const rlms = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`rlm-${i + 1}`, { id: `rlm-${i + 1}`, parent: i === 0 ? null : "rlm-1", preset: i === 0 ? "driver" : "research", depth: i === 0 ? 0 : 1, turns: 1, budget: 15, status: "done" as const, decisions: [] }]),
    )
    const t = await render({ thread: { ...initial("main"), status: "running", rlms }, core: "up" })
    expect(t.captureCharFrame()).not.toContain("rlm-40 ")
    t.mockInput.pressTab()
    await t.waitForVisualIdle()
    for (let i = 0; i < 40; i++) t.mockInput.pressArrow("down")
    await t.waitForVisualIdle()
    expect(t.captureCharFrame()).toContain("research rlm-40")
  })
})
