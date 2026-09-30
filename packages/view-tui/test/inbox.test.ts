import { expect, test } from "bun:test"
import { initial, type SessionState } from "@zarg/client"
import { inboxKey, inboxRows, openTopicUi } from "../src/inbox-keys"
import { goHome, initialUi, type Ui } from "../src/view"

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
  const st = s(topic("T-1"))
  expect(goHome(initialUi, st)).toMatchObject({ main: "inbox", sheet: false })
  expect(goHome(initialUi, s())).toMatchObject({ main: "inbox", sheet: true })
})
