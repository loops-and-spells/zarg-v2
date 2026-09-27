import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { conversation, EXIT_WINDOW_MS, initialUi, inputFocused, OTHER, onKey, onSubmit, pickerRows, slashActive, slashBox, statusLine, syncUi, tree } from "../src/tui/view"

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
    expect(onSubmit(ui, waiting, "do payments first")).toEqual({ ui: { ...ui, other: false, answered: "inq-1" }, action: { type: "answer", answer: { other: "do payments first" } } })
    expect(onKey(ui, waiting, { name: "escape" }, 0).ui.other).toBe(false)
  })

  test("a second Enter on the same inquiry does nothing (the answer is on its way)", () => {
    const ui = syncUi(initialUi, waiting)
    const first = onKey(ui, waiting, { name: "return" }, 0)
    expect(first.action).toEqual({ type: "answer", answer: { choice: "b" } })
    expect(onKey(first.ui, waiting, { name: "return" }, 0).action).toBeUndefined()
    const typed = onSubmit({ ...first.ui, other: true }, waiting, "text")
    expect(typed.action).toBeUndefined()
  })

  test("once the inquiry is answered the picker state clears", () => {
    const ui = { ...syncUi(initialUi, waiting), other: true }
    expect(syncUi(ui, running)).toEqual({ focus: "conversation", pick: 1, other: false })
  })
})

describe("keys and input", () => {
  test("a path or a /-answer is text, not a command", () => {
    expect(onSubmit(initialUi, running, "/api/v2 should return 404").action).toEqual({ type: "send", text: "/api/v2 should return 404" })
    expect(onSubmit(initialUi, running, "/etc/hosts is wrong").action).toEqual({ type: "send", text: "/etc/hosts is wrong" })
    const ui = { ...syncUi(initialUi, waiting), other: true }
    expect(onSubmit(ui, waiting, "/reconcile please").action).toEqual({ type: "answer", answer: { other: "/reconcile please" } })
  })

  test("input starting with / is a command, not a message", () => {
    expect(onSubmit(initialUi, running, "/reconcile").action).toEqual({ type: "command", text: "/reconcile" })
    // An unknown command is not sent: it stays in the input with the box's lint.
    expect(onSubmit(initialUi, running, " /nope ").action).toBeUndefined()
  })

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
    expect(statusLine(s, { threadId: "main", driver: "zarg-router:deepseek", mode: "child" })).toBe("core stopped · error · thread main · zarg-router:deepseek")
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

describe("slash commands in the input", () => {
  const idle: SessionState = { thread: { ...initial("main"), status: "idle" }, core: "up" }
  const press = (ui: typeof initialUi, draft: string, name: string) => onKey(ui, idle, { name }, 0, draft)

  test("typing / shows the commands; Tab completes; Esc clears", () => {
    expect(slashBox("/", initialUi)).toMatchObject({ title: "commands", rows: [{ label: "/reconcile", desc: "turn plan and implement on for this session", selected: false }] })
    const tab = press(initialUi, "/re", "tab")
    expect(tab.draft).toBe("/reconcile")
    expect(press(initialUi, "/re", "escape").draft).toBe("")
    expect(slashBox("hello", initialUi)).toBeUndefined()
    expect(slashBox("/api/v2 is slow", initialUi)).toBeUndefined()
  })

  test("arrows highlight a row; Enter runs the highlighted command", () => {
    const down = press(initialUi, "/", "down")
    expect(slashBox("/", down.ui)?.rows[0]?.selected).toBe(true)
    expect(onSubmit(down.ui, idle, "/").action).toEqual({ type: "command", text: "/reconcile" })
  })

  test("while answering Something else…, / is text: no box, no slash keys, Escape closes the answer field", () => {
    const answering = { ...syncUi(initialUi, waiting), other: true }
    expect(onKey(answering, waiting, { name: "tab" }, 0, "/re").draft).toBeUndefined()
    const esc = onKey(answering, waiting, { name: "escape" }, 0, "/nope")
    expect(esc.draft).toBeUndefined()
    expect(esc.ui.other).toBe(false)
    expect(slashActive(answering, waiting)).toBe(false)
  })

  test("a lint error shows in the box and Enter keeps the draft instead of running", () => {
    expect(slashBox("/reconcile now", initialUi)?.lint).toBe("/reconcile takes no arguments")
    expect(slashBox("/nope", initialUi)?.lint).toBe("unknown command /nope")
    expect(onSubmit(initialUi, idle, "/nope")).toEqual({ ui: initialUi })
    expect(onSubmit(initialUi, idle, "/rec").action).toEqual({ type: "command", text: "/reconcile" })
  })
})
