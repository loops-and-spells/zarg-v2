import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { conversation, EXIT_WINDOW_MS, initialUi, inputFocused, OTHER, onKey, onSubmit, pickerRows, statusLine, syncUi, tree } from "../src/tui/view"

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
const waiting: SessionState = { thread: { ...initial("main"), status: "waiting", pendingInquiry: inquiry }, core: "up" }
const running: SessionState = { thread: { ...initial("main"), status: "running" }, core: "up" }

describe("picker", () => {
  test("a new inquiry preselects the recommended option; its why is shown; the last row is Something else…", () => {
    const ui = syncUi(initialUi, waiting)
    expect(ui.pick).toBe(1)
    const rows = pickerRows(inquiry, ui.pick)
    expect(rows.map((r) => [r.label, r.selected])).toEqual([["Login", false], ["Checkout", true], ["Something else…", false]])
    expect(rows[1]).toMatchObject({ recommended: true, why: "most used" })
    expect(syncUi(ui, waiting)).toBe(ui)
  })

  test("arrows move within the rows; Enter answers with the selected option", () => {
    let ui = syncUi(initialUi, waiting)
    ui = onKey(ui, waiting, { name: "up" }, 0).ui
    ui = onKey(ui, waiting, { name: "up" }, 0).ui
    expect(ui.pick).toBe(0)
    expect(onKey(ui, waiting, { name: "return" }, 0).action).toEqual({ type: "answer", answer: { choice: "a" } })
    for (let i = 0; i < 5; i++) ui = onKey(ui, waiting, { name: "down" }, 0).ui
    expect(pickerRows(inquiry, ui.pick)[ui.pick]!.id).toBe(OTHER)
  })

  test("Something else… opens the text field; Enter there answers with the text; Escape closes it", () => {
    let ui = { ...syncUi(initialUi, waiting), pick: 2 }
    expect(inputFocused(ui, waiting)).toBe(false)
    ui = onKey(ui, waiting, { name: "return" }, 0).ui
    expect(ui.other).toBe(true)
    expect(inputFocused(ui, waiting)).toBe(true)
    expect(onSubmit(ui, waiting, "do payments first")).toEqual({ ui: { ...ui, other: false }, action: { type: "answer", answer: { other: "do payments first" } } })
    expect(onKey(ui, waiting, { name: "escape" }, 0).ui.other).toBe(false)
  })

  test("once the inquiry is answered the picker state clears", () => {
    const ui = { ...syncUi(initialUi, waiting), other: true }
    expect(syncUi(ui, running)).toEqual({ focus: "conversation", pick: 1, other: false })
  })
})

describe("keys and input", () => {
  test("typing while the driver works sends the message (an interjection)", () => {
    expect(inputFocused(initialUi, running)).toBe(true)
    expect(onSubmit(initialUi, running, "also add logout").action).toEqual({ type: "send", text: "also add logout" })
    expect(onSubmit(initialUi, running, "  ").action).toBeUndefined()
  })

  test("Ctrl-C once stops; twice within the window exits; Ctrl-D exits; Tab switches focus", () => {
    const first = onKey(initialUi, running, { name: "c", ctrl: true }, 1000)
    expect(first.action).toEqual({ type: "stop" })
    expect(onKey(first.ui, running, { name: "c", ctrl: true }, 1000 + EXIT_WINDOW_MS - 1).action).toEqual({ type: "exit" })
    expect(onKey(first.ui, running, { name: "c", ctrl: true }, 1000 + EXIT_WINDOW_MS + 1).action).toEqual({ type: "stop" })
    expect(onKey(initialUi, running, { name: "d", ctrl: true }, 0).action).toEqual({ type: "exit" })
    expect(onKey(initialUi, running, { name: "tab" }, 0).ui.focus).toBe("agents")
  })
})

describe("conversation, agents and status", () => {
  test("messages, then a run error and a transport notice", () => {
    const s: SessionState = {
      thread: { ...initial("main"), messages: [{ id: "1", role: "user", text: "hi" }, { id: "2", role: "assistant", text: "hello" }], status: "error", error: { code: "model", message: "router down" } },
      core: "down",
      notice: "core stopped",
    }
    expect(conversation(s)).toEqual([
      { kind: "you", text: "hi" },
      { kind: "zarg", text: "hello" },
      { kind: "error", text: "model: router down" },
      { kind: "notice", text: "core stopped" },
    ])
    expect(statusLine(s, { threadId: "main", driver: "zarg-router:deepseek", mode: "child" })).toBe("thread main · zarg-router:deepseek · core stopped · error")
  })

  test("the RLM tree nests children under parents with decisions and confidence", () => {
    const node = (id: string, parent: string | null, preset: string, extra = {}) => ({ id, parent, preset, depth: 0, turns: 2, budget: 25, status: "running" as const, decisions: [], ...extra })
    const lines = tree({
      "rlm-10": node("rlm-10", "rlm-1", "research", { status: "failed", error: "budget" }),
      "rlm-1": node("rlm-1", null, "driver", { tokens: 900, decisions: [{ kind: "atomize", atomic: false, criteria: [{ name: "single", answer: false, confidence: 0.82 }] }] }),
      "rlm-2": node("rlm-2", "rlm-1", "research", { status: "done" }),
    })
    expect(lines).toEqual([
      { depth: 0, kind: "rlm", text: "driver rlm-1  2/25 900 tok  running" },
      { depth: 1, kind: "decision", text: "plan  single no 0.82" },
      { depth: 1, kind: "rlm", text: "research rlm-2  2/25  done" },
      { depth: 1, kind: "rlm", text: "research rlm-10  2/25  failed: budget" },
    ])
  })
})
