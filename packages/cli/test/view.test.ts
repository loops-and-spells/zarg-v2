import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { conversation, EXIT_WINDOW_MS, initialUi, inputFocused, OTHER, onKey, onSubmit, pickerRows, agentDetail, agentRows, slashActive, slashBox, statusLine, syncUi, type Ui } from "../src/tui/view"

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
    expect(syncUi(ui, running)).toEqual({ focus: "conversation", pick: 1, other: false, agents: { toggled: {}, tree: 0 } })
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
})

describe("the agents pane", () => {
  const node = (id: string, parent: string | null, preset: string, extra = {}) => ({ id, parent, preset, depth: 0, turns: 2, budget: 10, status: "running" as const, decisions: [], ...extra })
  const rlms = {
    "rlm-10": node("rlm-10", "rlm-1", "research", { status: "failed", error: "budget" }),
    "rlm-1": node("rlm-1", null, "driver", { tokens: 4120, task: "Resolve the agenda item\nsecond line", decisions: [{ kind: "atomize", atomic: false, criteria: [{ name: "single", answer: false, confidence: 0.82 }] }] }),
    "rlm-2": node("rlm-2", "rlm-1", "research", { status: "done", turns: 10 }),
    "rlm-3": node("rlm-3", "rlm-2", "research"),
    "rlm-4": node("rlm-4", "rlm-3", "research", { status: "failed" }),
  }
  const agents = (extra = {}) => ({ ...initialUi.agents, ...extra })
  const text = (rows: ReturnType<typeof agentRows>) => rows.map((r) => r.text)
  const running: SessionState = { thread: { ...initial("main"), status: "running", rlms }, core: "up" }
  const press = (ui: typeof initialUi, name: string) => onKey(ui, running, { name }, 0)

  test("roots start open, children collapsed with a count of what they hide; ids sort numerically", () => {
    expect(text(agentRows(rlms, agents()))).toEqual([
      "▾ ● driver rlm-1       ▰▱▱▱▱▱  2/10",
      "  ▸ ✓ research rlm-2   ▰▰▰▰▰▰ 10/10  +2",
      "  └ ✗ research rlm-10  ▰▱▱▱▱▱  2/10",
    ])
  })

  test("a collapsed node that hides a failure is red; the cursor row is selected (the root when none)", () => {
    const rows = agentRows(rlms, agents())
    expect(rows.map((r) => [r.id, r.tone, r.selected])).toEqual([
      ["rlm-1", "running", true],
      ["rlm-2", "failed", false],
      ["rlm-10", "failed", false],
    ])
  })

  test("expanding draws the tree lines through open levels", () => {
    expect(text(agentRows(rlms, agents({ toggled: { "rlm-2": true, "rlm-3": true } })))).toEqual([
      "▾ ● driver rlm-1          ▰▱▱▱▱▱  2/10",
      "  ▾ ✓ research rlm-2      ▰▰▰▰▰▰ 10/10",
      "  │ ▾ ● research rlm-3    ▰▱▱▱▱▱  2/10",
      "  │   └ ✗ research rlm-4  ▰▱▱▱▱▱  2/10",
      "  └ ✗ research rlm-10     ▰▱▱▱▱▱  2/10",
    ])
  })

  test("keys on the agents pane: down/up move, right and Enter expand, left collapses then jumps to the parent", () => {
    let ui: Ui = { ...initialUi, focus: "agents" }
    ui = press(ui, "down").ui
    expect(ui.agents.cursor).toBe("rlm-2")
    ui = press(ui, "right").ui
    expect(text(agentRows(rlms, ui.agents))[2]).toContain("rlm-3")
    ui = press(ui, "down").ui
    expect(ui.agents.cursor).toBe("rlm-3")
    ui = press(ui, "return").ui
    expect(text(agentRows(rlms, ui.agents))[3]).toContain("rlm-4")
    ui = press(ui, "left").ui
    expect(text(agentRows(rlms, ui.agents))).toHaveLength(4)
    ui = press(ui, "left").ui
    expect(ui.agents.cursor).toBe("rlm-2")
    ui = press(ui, "left").ui
    expect(ui.agents.cursor).toBe("rlm-2")
    expect(text(agentRows(rlms, ui.agents))).toHaveLength(3)
    ui = press(ui, "up").ui
    ui = press(ui, "up").ui
    expect(ui.agents.cursor).toBe("rlm-1")
    ui = press(ui, "left").ui
    expect(text(agentRows(rlms, ui.agents))).toEqual(["▸ ● driver rlm-1  ▰▱▱▱▱▱  2/10  +4"])
  })

  test("expansion and the cursor survive live updates; a cursor whose RLM is gone falls back to the root", () => {
    const ui = { ...initialUi, agents: agents({ cursor: "rlm-2", toggled: { "rlm-2": true } }) }
    const more = { ...rlms, "rlm-5": node("rlm-5", "rlm-2", "research") }
    expect(agentRows(more, ui.agents).find((r) => r.selected)?.id).toBe("rlm-2")
    expect(text(agentRows(more, ui.agents))).toHaveLength(5)
    const next = { "rlm-20": node("rlm-20", null, "driver") }
    expect(agentRows(next, ui.agents).map((r) => [r.id, r.selected])).toEqual([["rlm-20", true]])
  })

  test("rows fit the pane: long ids are cut with an ellipsis and the bar column stays", () => {
    const long = {
      "S-0058:rlm-1": node("S-0058:rlm-1", null, "implementer", { turns: 40, budget: 0 }),
      "S-0058:rlm-2": node("S-0058:rlm-2", "S-0058:rlm-1", "implementer"),
      "S-0058:rlm-3": node("S-0058:rlm-3", "S-0058:rlm-2", "implementer"),
      "S-0058:rlm-4": node("S-0058:rlm-4", "S-0058:rlm-3", "implementer"),
      "S-0058:rlm-5": node("S-0058:rlm-5", "S-0058:rlm-4", "implementer"),
    }
    const toggled = { "S-0058:rlm-2": true, "S-0058:rlm-3": true }
    const rows = text(agentRows(long, agents({ toggled })))
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(46)
    expect(rows[3]).toMatch(/…  ▰▱▱▱▱▱  2\/10  \+1$/)
    expect(rows[0]).toMatch(/^▾ ● implementer S-0058:rlm-1 +▰▰▰▰▰▰  40\/0$/)
  })

  test("a fresh tree (a new driver item or pass) forgets the folds and the cursor", () => {
    const ui = { ...initialUi, agents: { cursor: "rlm-2", toggled: { "rlm-1": false }, tree: 1 } }
    const same: SessionState = { ...running, thread: { ...running.thread, trees: 1 } }
    expect(syncUi(ui, same).agents).toBe(ui.agents)
    const fresh: SessionState = { ...running, thread: { ...running.thread, trees: 2 } }
    expect(syncUi(ui, fresh).agents).toEqual({ toggled: {}, tree: 2 })
  })

  test("the detail card: status, the task's first line, turns and tokens, the verdict per criterion, the error", () => {
    expect(agentDetail(rlms, undefined)).toEqual([
      "driver rlm-1 · running",
      "task  Resolve the agenda item",
      "turn 2 of 10 · 4,120 tokens",
      "plan (splits into children)",
      "  single          no   0.82",
    ])
    expect(agentDetail(rlms, "rlm-10")).toEqual(["research rlm-10 · failed", "turn 2 of 10", "error  budget"])
    expect(agentDetail({}, undefined)).toEqual([])
  })

  test("arrows on the agents pane never move the picker", () => {
    const waiting: SessionState = { thread: { ...running.thread, status: "waiting", pendingInquiry: inquiry }, core: "up" }
    const ui = syncUi({ ...initialUi, focus: "agents" }, waiting)
    expect(onKey(ui, waiting, { name: "up" }, 0).ui.pick).toBe(ui.pick)
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
