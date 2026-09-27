import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { defineView, layoutOf } from "@zarg/view"
import { activate, answeringOther, attentionOf, attentionLine, CHAT, conversation, openAgent, EXIT_WINDOW_MS, initialUi, inputFocused, typing, OTHER, onSubmit, pickerRows, agentDetail, agentRows, animating, SPINNER, slashActive, working, slashBox, statusLine, syncUi, type Ui } from "../src/view"
import { onKey } from "../src/layers"

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
  test("a new inquiry preselects the recommended option; its why is shown; the rows end with Something else… and Chat about this", () => {
    const ui = syncUi(initialUi, waiting)
    expect(ui.pick).toBe(1)
    const rows = pickerRows(inquiry, ui.pick)
    expect(rows.map((r) => [r.label, r.selected])).toEqual([["Login", false], ["Checkout", true], ["Something else…", false], ["Chat about this", false]])
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
    expect(pickerRows(inquiry, ui.pick)[ui.pick]!.id).toBe(CHAT)
  })

  test("a grant question offers only its answers: no Something else, no Chat about this", () => {
    const q = { id: "inq-g", question: "Plugin rehearse wants to load", options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }], allowOther: false, about: [], kind: "grant" as const }
    expect(pickerRows(q, 0).map((r) => r.label)).toEqual(["Allow", "Not now"])
  })

  test("a question can name its free-text row (Change it… on a proposed change)", () => {
    const q = { id: "inq-c", question: "Add this?", options: [{ id: "add", label: "Add it", recommended: true }, { id: "skip", label: "Skip" }], allowOther: true, otherLabel: "Change it", about: [] }
    expect(pickerRows(q, 0).map((r) => r.label)).toEqual(["Add it", "Skip", "Change it…", "Chat about this"])
  })

  test("Something else…: highlighting it moves the typing to the bar; Enter answers with the text", () => {
    let ui = onKey(syncUi(initialUi, waiting), waiting, { name: "down" }, 0).ui
    expect(pickerRows(inquiry, ui.pick)[ui.pick]!.id).toBe(OTHER)
    expect(ui.other).toBe(true)
    expect(answeringOther(ui, waiting)).toBe(true)
    expect(inputFocused(ui, waiting)).toBe(true)
    expect(onSubmit(ui, waiting, "do payments first")).toEqual({ ui: { ...ui, other: false, answered: "inq-1" }, action: { type: "answer", answer: { other: "do payments first" } } })
    ui = onKey(ui, waiting, { name: "up" }, 0).ui
    expect(ui.other).toBe(false)
    expect(onKey({ ...ui, pick: 2, other: true }, waiting, { name: "escape" }, 0).ui).toMatchObject({ other: false, pick: 1 })
  })

  test("Chat about this: the bar takes the typing, a message there discusses the question, Escape goes back to the picker", () => {
    let ui = { ...syncUi(initialUi, waiting), pick: 3 }
    expect(typing(ui, waiting)).toBe(false)
    ui = onKey(ui, waiting, { name: "return" }, 0).ui
    expect(ui.chatting).toBe("inq-1")
    expect(typing(ui, waiting)).toBe(true)
    expect(inputFocused(ui, waiting)).toBe(true)
    expect(onSubmit(ui, waiting, "why is Checkout recommended?").action).toEqual({ type: "send", text: "why is Checkout recommended?" })
    expect(onKey(ui, waiting, { name: "escape" }, 0).ui.chatting).toBeUndefined()
  })

  test("the bar types only when no question is up, or while chatting about it or answering in words", () => {
    expect(typing(initialUi, running)).toBe(true)
    expect(typing(syncUi(initialUi, waiting), waiting)).toBe(false)
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
    const ui = { ...syncUi(initialUi, waiting), other: true, chatting: "inq-1" }
    expect(syncUi(ui, running, 0)).toEqual({ ...initialUi, pick: 1, runningSince: 0 })
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

  test("Ctrl-C once stops; twice within the window exits; Ctrl-D exits", () => {
    const first = onKey(initialUi, running, { name: "c", ctrl: true }, 1000)
    expect(first.action).toEqual({ type: "stop" })
    expect(onKey(first.ui, running, { name: "c", ctrl: true }, 1000 + EXIT_WINDOW_MS - 1).action).toEqual({ type: "exit" })
    expect(onKey(first.ui, running, { name: "c", ctrl: true }, 1000 + EXIT_WINDOW_MS + 1).action).toEqual({ type: "stop" })
    expect(onKey(initialUi, running, { name: "d", ctrl: true }, 0).action).toEqual({ type: "exit" })
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

  test("an agent that draws its own row: its progress fills the bar and its text replaces the turns", () => {
    const tester = { id: "tester-1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], row: { progress: { done: 29, total: 58 }, text: "29/58 steps · 2 flagged" } }
    expect(text(agentRows({ "tester-1": tester }, agents()))).toEqual(["└ ● tester tester-1  ▰▰▰▱▱▱ 29/58 steps · 2 flagged"])
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

  test("keys on the agents pane: down/up move, right expands, left collapses then jumps to the parent", () => {
    let ui: Ui = { ...initialUi, focus: "agents" }
    ui = press(ui, "down").ui
    expect(ui.agents.cursor).toBe("rlm-2")
    ui = press(ui, "right").ui
    expect(text(agentRows(rlms, ui.agents))[2]).toContain("rlm-3")
    ui = press(ui, "down").ui
    expect(ui.agents.cursor).toBe("rlm-3")
    ui = press(ui, "right").ui
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

  test("Enter (or a click) opens an agent's hidden children first, then its view; Escape closes it and zarg's sheet shows", () => {
    let ui: Ui = { ...initialUi, focus: "agents" }
    ui = press(ui, "down").ui
    ui = press(ui, "return").ui
    expect(ui.viewing).toBeUndefined()
    expect(text(agentRows(rlms, ui.agents)).some((r) => r.includes("▾ ✓ research rlm-2"))).toBe(true)
    ui = press(ui, "return").ui
    expect(ui.viewing).toBe("rlm-2")
    // A click does the same: a collapsed parent opens, a leaf shows its history.
    expect(activate({ ...initialUi }, running, "rlm-2").agents.toggled["rlm-2"]).toBe(true)
    expect(activate({ ...initialUi }, running, "rlm-10").viewing).toBe("rlm-10")
    ui = press(ui, "escape").ui
    expect(ui.viewing).toBeUndefined()
    expect(ui.focus).toBe("tile")
  })

  test("with an agent's view open, its keys are the view's even while a question waits; Escape closes it and the sheet takes the question", () => {
    const layout = layoutOf(defineView("t", { review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] } } } }))
    const views = { "rehearse:t-1": { agent: "rehearse:t-1", layout, data: { "review.findings": { rows: [{ id: "R-1", cells: {} }, { id: "R-2", cells: {} }] } } } }
    const asking: SessionState = { thread: { ...running.thread, status: "waiting", views, pendingInquiry: { id: "inq-9", question: "What next?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowOther: false, about: [] } }, core: "up" }
    let ui: Ui = syncUi(openAgent({ ...initialUi }, asking, "rehearse:t-1"), asking)
    const down = onKey(ui, asking, { name: "down" }, 0)
    expect(down.ui.pick).toBe(0)
    expect(down.ui.view?.rows["review.findings"]).toBe(1)
    expect(onKey(down.ui, asking, { name: "return" }, 0).action).toBeUndefined()
    ui = onKey(down.ui, asking, { name: "escape" }, 0).ui
    expect(ui.viewing).toBeUndefined()
    expect(onKey(ui, asking, { name: "down" }, 0).ui.pick).toBe(1)
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

  test("the detail card shows budget extensions and wrap-ups with their confidence", () => {
    const n = { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 30, budget: 35, status: "running" as const, decisions: [
      { kind: "extend" as const, extended: true, turns: 35, confidence: 0.82, reason: "typecheck failed 0/5" },
      { kind: "extend" as const, extended: false, turns: 35, confidence: 0.7, reason: "repeated calls 6/6" },
    ] }
    expect(agentDetail({ "rlm-1": n }, undefined).slice(2)).toEqual([
      "extended to 35 turns  0.82  typecheck failed 0/5",
      "told to wrap up       0.70  repeated calls 6/6",
    ])
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
    expect(slashBox("/", initialUi)).toMatchObject({ title: "commands", rows: [{ label: "/reconcile", desc: "turn plan and implement on for this session", selected: false }, { label: "/yolo" }] })
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

describe("the working indicator", () => {
  const root = { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 4, budget: 25, status: "running" as const, decisions: [] }
  const running: SessionState = { thread: { ...initial("main"), status: "running", rlms: { "rlm-1": root } }, core: "up" }
  const waiting: SessionState = { thread: { ...running.thread, status: "waiting", pendingInquiry: inquiry }, core: "up" }
  const idle: SessionState = { thread: { ...initial("main"), status: "idle" }, core: "up" }

  test("the run's start time is noted when the thread starts running and cleared when it stops", () => {
    const started = syncUi(initialUi, running, 1_000)
    expect(started.runningSince).toBe(1_000)
    expect(syncUi(started, running, 5_000).runningSince).toBe(1_000)
    expect(syncUi(started, waiting, 5_000).runningSince).toBeUndefined()
    expect(syncUi(started, idle, 5_000).runningSince).toBeUndefined()
  })

  test("while the driver works: a spinner, the elapsed time and the driver's turn", () => {
    const ui = syncUi(initialUi, running, 1_000)
    expect(working(ui, running, 73_000)).toBe(`${SPINNER[(73_000 / 100) % SPINNER.length]} zarg is preparing a reply · 1:12 · turn 4/25`)
    expect(working(ui, running, 73_100)!.at(0)).not.toBe(working(ui, running, 73_000)!.at(0))
  })

  test("no line and no clock once the core is down, even if the thread last said running", () => {
    const down: SessionState = { ...running, core: "down" }
    const ui = syncUi(syncUi(initialUi, running, 0), down, 1_000)
    expect(ui.runningSince).toBeUndefined()
    expect(working(ui, down, 2_000)).toBeUndefined()
    expect(animating(ui, down)).toBe(false)
  })

  test("the clock animates while the driver works or agents run, not while a question waits", () => {
    const ui = syncUi(initialUi, running, 0)
    expect(animating(ui, running)).toBe(true)
    expect(animating(syncUi(ui, waiting, 0), { ...waiting, thread: { ...waiting.thread, rlms: { "rlm-1": root } } })).toBe(false)
    expect(animating(syncUi(ui, idle, 0), idle)).toBe(false)
  })

  test("no line while a question waits or the thread is idle", () => {
    expect(working(syncUi(initialUi, waiting, 0), waiting, 1_000)).toBeUndefined()
    expect(working(syncUi(initialUi, idle, 0), idle, 1_000)).toBeUndefined()
  })

  test("running agents spin in the tree when a time is given; finished ones keep their icon", () => {
    const rlms = { "rlm-1": root, "rlm-2": { ...root, id: "rlm-2", parent: "rlm-1", preset: "research", status: "done" as const } }
    const rows = agentRows(rlms, { toggled: {} }, 46, 300).map((r) => r.text)
    expect(rows[0]!.startsWith(`▾ ${SPINNER[3]} driver rlm-1`)).toBe(true)
    expect(rows[1]).toContain("✓ research rlm-2")
  })
})

describe("YOLO on the status line", () => {
  test("the status line shows YOLO right after the core state while plugins pass without asking", () => {
    const s: SessionState = { thread: { ...initial("main"), status: "idle", yolo: true }, core: "up" }
    expect(statusLine(s, { threadId: "main", mode: "child" })).toBe("core child · YOLO · idle · thread main · driver model unknown")
    expect(statusLine({ ...s, thread: { ...s.thread, yolo: false } }, { threadId: "main", mode: "child" })).not.toContain("YOLO")
  })
})

describe("keys in an agent's view", () => {
  const layout = layoutOf(defineView("t", { steps: { kind: "log", role: "log" }, review: { kind: "tabs", role: "pinned", tabs: { findings: { kind: "table", columns: [{ id: "id", label: "id" }], selectable: true, actions: [{ id: "apply", label: "Apply", key: "a", on: "selection" }] }, likes: { kind: "table", columns: [] } } } }))
  const views = { "rehearse:t-1": { agent: "rehearse:t-1", layout, data: { "review.findings": { rows: [{ id: "R-1", cells: {} }, { id: "R-2", cells: {} }] } } } }
  const s = { ...running, thread: { ...running.thread, views } } as SessionState
  const open = { ...initialUi, viewing: "rehearse:t-1", focus: "tile" as const }
  test("the view opens on its table: space and a apply the selected rows, [ and ] switch tabs, Tab moves to the log", () => {
    let ui = onKey(open, s, { name: "down" }, 0).ui
    expect(ui.view?.focus).toBe(1)
    ui = onKey(ui, s, { name: "space" }, 0).ui
    const r = onKey(ui, s, { name: "a" }, 0)
    expect(r.action).toEqual({ type: "act", section: "review.findings", action: "apply", rows: ["R-2"] })
    expect(r.ui.view?.selected["review.findings"]).toEqual([])
    expect(onKey(ui, s, { name: "]" }, 0).ui.view?.tabs.review).toBe(1)
    expect(onKey(ui, s, { name: "tab" }, 0).ui.view?.focus).toBe(0)
  })
  test("Escape closes the view", () => {
    expect(onKey(open, s, { name: "escape" }, 0).ui.viewing).toBeUndefined()
  })
  test("an open view takes the keys: the message box is not focused, and ctrl letters never trigger actions", () => {
    const ui = openAgent({ ...initialUi }, s, "rehearse:t-1")
    expect(inputFocused(ui, s)).toBe(false)
    let u = ui
    expect(onKey(u, s, { name: "a", ctrl: true }, 0).action).toBeUndefined()
    u = onKey(u, s, { name: "a" }, 0).ui
  })
  test("in a focused log, arrows and page keys scroll it", () => {
    const log = onKey(open, s, { name: "tab" }, 0).ui
    expect(onKey(log, s, { name: "up" }, 0).action).toEqual({ type: "scroll", delta: -1 })
    expect(onKey(log, s, { name: "pagedown" }, 0).action).toEqual({ type: "scroll", delta: 10 })
  })
})

describe("attention", () => {
  const node = (id: string, parent: string | null, attention?: string) => ({ id, parent, preset: id === "zarg" ? "zarg" : "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], ...(attention !== undefined ? { attention: { reason: attention, since: 1 } } : {}) })
  const rlms = { zarg: node("zarg", null, "asks: What next?"), "rlm-1": node("rlm-1", "zarg"), "rehearse:run": node("rehearse:run", null), "rehearse:tester-1": node("rehearse:tester-1", "rehearse:run", "2 findings to review") }

  test("a row that asks for attention shows ◆ and its reason", () => {
    const rows = agentRows(rlms, { toggled: { "rehearse:run": true } }, 60)
    const tester = rows.find((r) => r.id === "rehearse:tester-1")!
    expect(tester.text).toContain("◆ tester rehearse:tester-1")
    expect(tester.text).toContain("2 findings to review")
    expect(tester.attention).toBe(true)
  })

  test("the agents needing the developer, zarg first; the status line names the first two", () => {
    expect(attentionOf(rlms).map((a) => a.id)).toEqual(["zarg", "rehearse:tester-1"])
    expect(attentionLine(rlms)).toBe("◆ zarg: asks: What next?   ◆ rehearse:tester-1: 2 findings to review")
  })

  test("g opens the next agent that needs the developer, zarg by opening its sheet", () => {
    const s = { ...running, thread: { ...running.thread, rlms } } as SessionState
    let ui = onKey({ ...initialUi, focus: "agents" }, s, { name: "g" }, 0).ui
    expect(ui).toMatchObject({ focus: "tile", sheet: true })
    ui = onKey({ ...ui, focus: "agents" }, s, { name: "g" }, 0).ui
    expect(ui.viewing).toBe("rehearse:tester-1")
    expect(ui).toMatchObject({ focus: "tile", sheet: false })
  })
})

describe("a plugin agent's conversation in its view", () => {
  const layout = layoutOf(defineView("talker", { talk: { kind: "conversation", role: "primary" } }))
  const views = { "p:a": { agent: "p:a", layout, data: { talk: { messages: [], question: { id: "q1", question: "Go on?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }], allowOther: false } } } } }
  const s = { ...running, thread: { ...running.thread, views } } as SessionState
  test("arrows pick an option and Enter answers the agent", () => {
    const open = openAgent({ ...initialUi }, s, "p:a")
    const down = onKey(open, s, { name: "down" }, 0)
    expect(onKey(down.ui, s, { name: "return" }, 0).action).toEqual({ type: "answer-agent", question: "q1", answer: { choice: "n" } })
  })
})

describe("zarg's row", () => {
  const zarg = { id: "zarg", parent: null, preset: "zarg", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [] }
  const driver = { id: "rlm-1", parent: "zarg", preset: "driver", depth: 1, turns: 3, budget: 25, status: "running" as const, decisions: [] }
  test("the busy line and the detail card talk about the driver, not zarg's own row", () => {
    const s = { ...running, thread: { ...running.thread, status: "running", rlms: { zarg, "rlm-1": driver } } } as SessionState
    expect(working({ ...initialUi, runningSince: 0 }, s, 1000)).toContain("turn 3/25")
    expect(agentDetail(s.thread.rlms, undefined)[0]).toBe("driver rlm-1 · running")
  })
  test("zarg's row alone does not keep the screen redrawing", () => {
    const s = { ...running, thread: { ...running.thread, status: "idle", rlms: { zarg } } } as SessionState
    expect(animating(initialUi, s)).toBe(false)
  })
})

test("an attention reason is cut to the room its row has", () => {
  const rlms = { "p:t": { id: "p:t", parent: null, preset: "tester", depth: 0, turns: 0, budget: 1, status: "running" as const, decisions: [], attention: { reason: "a very long reason that would never fit on one row of the tree", since: 1 } } }
  const rows = agentRows(rlms, { toggled: {} }, 46)
  expect(rows[0]!.text.length).toBeLessThanOrEqual(46)
  expect(rows[0]!.text).toEndWith("…")
})
