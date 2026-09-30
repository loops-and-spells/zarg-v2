import { expect, test } from "bun:test"
import { initial, type SessionState } from "@zarg/client"
import { inboxKey, inboxRows, openTopicUi, unseenBlocking } from "../src/inbox-keys"
import { goHome, goTo, initialUi, queueOf, statusLine, type Ui } from "../src/view"

const topic = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "grant", from: { plugin: "backlog" }, title: `t ${id}`, why: "fs write", about: [], blocking: false, messages: [], state: "open", created: Number(id.slice(2)), updated: 0, answers: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny", reason: "optional" }], ...over })
const s = (...ts: Array<ReturnType<typeof topic>>) => ({ core: "up", thread: { ...initial("main"), inbox: Object.fromEntries(ts.map((t) => [t.id, t])) } }) as unknown as SessionState
const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ctrl: false, meta: false, shift: false, sequence: name.length === 1 ? name : "", ...extra }) as never
const home: Ui = { ...initialUi, main: "inbox", focus: "tile" }

test("rows: open topics, sorted; Enter opens one; a number answers it; t then text then Enter answers with a reason; z sends a snooze", () => {
  const st = s(topic("T-2"), topic("T-1", { blocking: true }))
  expect(inboxRows(home, st).map((t) => t.id)).toEqual(["T-1", "T-2"])
  const opened = inboxKey(home, st, key("return")).ui
  expect(opened.inbox.open).toBe("T-1")
  expect(inboxKey(opened, st, key("2")).action).toEqual({ type: "answer-topic", id: "T-1", answer: "deny" })
  let typing = inboxKey({ ...opened, inbox: { ...opened.inbox, pick: 1 } }, st, key("t")).ui
  expect(typing.inbox.typing).toEqual({ id: "T-1", text: "" })
  for (const c of "no") typing = inboxKey(typing, st, key(c)).ui
  const sent = inboxKey(typing, st, key("return"))
  expect(sent.action).toEqual({ type: "answer-topic", id: "T-1", answer: "deny", text: "no" })
  expect(sent.ui.inbox.typing).toBeUndefined()
  expect(inboxKey(opened, st, key("z")).action).toEqual({ type: "snooze-topic", id: "T-1" })
  expect(inboxKey(opened, st, key("escape")).ui.inbox.open).toBeUndefined()
})
test("batch: space marks topics of one kind (another kind is not marked); a number answers them all", () => {
  const st = s(topic("T-1"), topic("T-2"), topic("T-3", { kind: "drift", answers: [{ id: "card", label: "Reword" }] }))
  let ui = inboxKey(home, st, key("space")).ui
  ui = inboxKey({ ...ui, inbox: { ...ui.inbox, cursor: 1 } }, st, key("space")).ui
  expect(ui.inbox.marked).toEqual(["T-1", "T-2"])
  expect(inboxKey({ ...ui, inbox: { ...ui.inbox, cursor: 2 } }, st, key("space")).ui.inbox.marked).toEqual(["T-1", "T-2"])
  expect(inboxKey(ui, st, key("1")).action).toEqual({ type: "answer-topics", ids: ["T-1", "T-2"], answer: "once" })
})
test("a report opened is read; a shows answered ones too", () => {
  const st = s(topic("T-1", { kind: "report", answers: undefined }), topic("T-2", { state: "answered" }))
  expect(inboxKey(home, st, key("return")).action).toEqual({ type: "read-topic", id: "T-1" })
  expect(inboxRows(inboxKey(home, st, key("a")).ui, st).map((t) => t.id)).toEqual(["T-2", "T-1"])
})

test("opening a topic by click: the recommended answer highlighted (not the last topic's), the keys to the inbox; a report is read", () => {
  const st = s(topic("T-1", { answers: [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true }] }), topic("T-2", { kind: "report", answers: undefined }))
  const r = openTopicUi({ ...home, focus: "bar", inbox: { ...home.inbox, pick: 5 } }, st.thread.inbox!["T-1"]!)
  expect([r.ui.inbox.open, r.ui.inbox.pick, r.ui.focus]).toEqual(["T-1", 1, "tile"])
  expect(openTopicUi(home, st.thread.inbox!["T-2"]!).action).toEqual({ type: "read-topic", id: "T-2" })
})
test("home on arrival: zarg's sheet stays closed while topics wait, so the inbox shows", () => {
  const st = s(topic("T-1", { kind: "drift" }))
  expect(goHome(initialUi, st)).toMatchObject({ main: "inbox", sheet: false })
  expect(goHome(initialUi, s())).toMatchObject({ main: "inbox", sheet: true })
  // Grants show as popovers and zarg's own questions in its sheet: neither keeps the sheet closed.
  expect(goHome(initialUi, s(topic("T-2", { blocking: true }), topic("T-3", { kind: "question", from: { plugin: "zarg", agent: "zarg" } })))).toMatchObject({ sheet: true })
})

test("a reason sent closes the topic; leaving the inbox drops a half-typed reason; t only where there is something to answer", () => {
  const st = s(topic("T-1"), topic("T-2", { kind: "report", answers: undefined }))
  const opened = inboxKey(home, st, key("return")).ui
  let typing = inboxKey(opened, st, key("t")).ui
  typing = inboxKey(typing, st, key("x")).ui
  expect(inboxKey(typing, st, key("return")).ui.inbox.open).toBeUndefined()
  expect(goTo(typing, "grid").inbox.typing).toBeUndefined()
  const report = openTopicUi(home, st.thread.inbox!["T-2"]!).ui
  expect(inboxKey(report, st, key("t")).ui.inbox.typing).toBeUndefined()
})
test("o opens the topic's origin view", () => {
  const st = s(topic("T-1", { origin: { view: "backlog:board" } }))
  const opened = inboxKey(home, st, key("return")).ui
  expect(inboxKey(opened, st, key("o")).ui).toMatchObject({ main: "agent", viewing: "backlog:board" })
})
test("a blocking topic not yet opened is unseen (its ◆ blinks); opening it sees it", () => {
  const st = s(topic("T-1", { blocking: true }))
  expect(unseenBlocking(home, st)).toBe(1)
  expect(unseenBlocking(openTopicUi(home, st.thread.inbox!["T-1"]!).ui, st)).toBe(0)
})

test("the popover queue shows open grant topics, first raised first; an answered one leaves it", () => {
  const st = s(topic("T-2", { blocking: true, created: 2, title: "b wants x" }), topic("T-1", { blocking: true, created: 1, title: "a wants y" }), topic("T-3", { blocking: true, state: "answered" }), topic("T-4", { kind: "drift" }))
  expect(queueOf(home, st).map((p) => [p.id, p.question, p.kind])).toEqual([["T-1", "a wants y", "grant"], ["T-2", "b wants x", "grant"]])
})

test("r in an open topic types a reply: Enter sends it and the topic stays open", () => {
  const st = s(topic("T-1", { kind: "question", from: { plugin: "zarg", agent: "zarg" } }))
  const opened = inboxKey(home, st, key("return")).ui
  let ui = inboxKey(opened, st, key("r")).ui
  expect(ui.inbox.typing).toEqual({ id: "T-1", text: "", reply: true })
  for (const c of "why") ui = inboxKey(ui, st, key(c)).ui
  const sent = inboxKey(ui, st, key("return"))
  expect(sent.action).toEqual({ type: "reply-topic", id: "T-1", text: "why" })
  expect(sent.ui.inbox.open).toBe("T-1")
  expect(sent.ui.inbox.typing).toBeUndefined()
})

test("the status line keeps the core state first; the inbox count follows it (and YOLO)", () => {
  const st = { ...s(topic("T-1", { blocking: true })), core: "up" } as SessionState
  expect(statusLine(st, { threadId: "main", mode: "child" })).toStartWith("core child · ◆ 1 blocking · 1 open")
})

test("r replies only where someone hears it (zarg's questions); a plugin's topic takes no reply", () => {
  const st = s(topic("T-1", { kind: "plan", from: { plugin: "backlog" } }))
  const opened = inboxKey(home, st, key("return")).ui
  expect(inboxKey(opened, st, key("r")).ui.inbox.typing).toBeUndefined()
})
