import { describe, expect, test } from "bun:test"
import { initial, reduce, type ThreadState, type WireEvent } from "../src"

let seq = 0
const ev = (type: string, fields: Record<string, unknown> = {}, threadId = "main"): WireEvent => ({ type, threadId, seq: ++seq, ...fields })
const fold = (events: ReadonlyArray<WireEvent>, s: ThreadState = initial("main")) => events.reduce(reduce, s)
const text = (id: string, role: string, delta: string) => [
  ev("TEXT_MESSAGE_START", { messageId: id, role }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: id, delta }),
  ev("TEXT_MESSAGE_END", { messageId: id }),
]
const inquiry = {
  id: "inq-1",
  reason: "inquiry",
  message: "Which card first?",
  metadata: { options: [{ id: "a", label: "Checkout", recommended: true, why: "most used" }, { id: "b", label: "Login" }], allowOther: true, about: ["UX-0001"] },
}

describe("reduce", () => {
  test("a run that ends in an inquiry: running, then waiting with the inquiry", () => {
    const running = fold([ev("RUN_STARTED", { runId: "r1" })])
    expect(running.status).toBe("running")
    const s = fold([ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupt", interrupts: [inquiry] } })], running)
    expect(s.status).toBe("waiting")
    expect(s.pendingInquiry).toEqual({ id: "inq-1", question: "Which card first?", options: inquiry.metadata.options, allowOther: true, about: ["UX-0001"] })
  })

  test("messages build from START, CONTENT, END; the next run clears the inquiry", () => {
    const s = fold([
      ev("RUN_STARTED", { runId: "r1" }),
      ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupt", interrupts: [inquiry] } }),
      ev("RUN_STARTED", { runId: "r2" }),
      ...text("u1", "user", "Checkout"),
      ...text("a1", "assistant", "Working on checkout."),
      ev("RUN_FINISHED", { runId: "r2" }),
    ])
    expect(s.messages).toEqual([
      { id: "u1", role: "user", text: "Checkout" },
      { id: "a1", role: "assistant", text: "Working on checkout." },
    ])
    expect(s.pendingInquiry).toBeUndefined()
    expect(s.status).toBe("idle")
  })

  test("the run an answer starts clears the inquiry at once; a question still open comes back with the run's interrupt", () => {
    const answered = fold([
      ev("RUN_STARTED", { runId: "r1" }),
      ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupt", interrupts: [inquiry] } }),
      ev("RUN_STARTED", { runId: "r2" }),
    ])
    expect(answered.pendingInquiry).toBeUndefined()
    expect(answered.status).toBe("running")
    const still = fold([ev("RUN_FINISHED", { runId: "r2", outcome: { type: "interrupt", interrupts: [inquiry] } })], answered)
    expect(still.pendingInquiry?.id).toBe("inq-1")
  })

  test("a grant question keeps its kind", () => {
    const s = fold([ev("RUN_STARTED", { runId: "r8" }), ev("RUN_FINISHED", { runId: "r8", outcome: { type: "interrupt", interrupts: [{ ...inquiry, metadata: { ...inquiry.metadata, kind: "grant" } }] } })])
    expect(s.pendingInquiry?.kind).toBe("grant")
  })

  test("an inquiry's own label for its free-text row is kept", () => {
    const s = fold([ev("RUN_STARTED", { runId: "r9" }), ev("RUN_FINISHED", { runId: "r9", outcome: { type: "interrupt", interrupts: [{ ...inquiry, metadata: { ...inquiry.metadata, otherLabel: "Change it" } }] } })])
    expect(s.pendingInquiry?.otherLabel).toBe("Change it")
  })

  test("agents from several activity streams share the pane; one stream's reset leaves the others", () => {
    const node = (id: string) => ({ id, parent: null, preset: "p", depth: 0, turns: 0, budget: 1, status: "running", decisions: [] })
    const s = fold([
      ev("ACTIVITY_SNAPSHOT", { messageId: "main-activity", content: { rlms: { "rlm-1": node("rlm-1") } } }),
      ev("ACTIVITY_SNAPSHOT", { messageId: "main-rehearse-activity", content: { rlms: {} } }),
      ev("ACTIVITY_DELTA", { messageId: "main-rehearse-activity", patch: [{ op: "add", path: "/rlms/tester-1", value: node("tester-1") }] }),
      ev("ACTIVITY_SNAPSHOT", { messageId: "main-activity", content: { rlms: {} } }),
    ])
    expect(Object.keys(s.rlms)).toEqual(["tester-1"])
    // Only the driver's own tree starting over counts as a new tree.
    expect(s.trees).toBe(1)
  })

  test("RUN_ERROR shows the error; the next run clears it", () => {
    const failed = fold([ev("RUN_STARTED"), ev("RUN_ERROR", { message: "model unreachable", code: "model" })])
    expect(failed).toMatchObject({ status: "error", error: { code: "model", message: "model unreachable" } })
    const again = fold([ev("RUN_STARTED")], failed)
    expect(again.status).toBe("running")
    expect(again.error).toBeUndefined()
  })

  test("the RLM tree follows the activity snapshot and deltas", () => {
    const node = (id: string, parent: string | null, status = "running") => ({ id, parent, preset: "driver", depth: 0, turns: 1, budget: 20, status, decisions: [] })
    const s = fold([
      ev("ACTIVITY_SNAPSHOT", { messageId: "m", activityType: "zarg.rlm", content: { rlms: { "rlm-1": node("rlm-1", null) } } }),
      ev("ACTIVITY_DELTA", { messageId: "m", activityType: "zarg.rlm", patch: [{ op: "add", path: "/rlms/rlm-2", value: node("rlm-2", "rlm-1") }] }),
      ev("ACTIVITY_DELTA", { messageId: "m", activityType: "zarg.rlm", patch: [{ op: "replace", path: "/rlms/rlm-1", value: node("rlm-1", null, "done") }] }),
    ])
    expect(Object.keys(s.rlms)).toEqual(["rlm-1", "rlm-2"])
    expect(s.rlms["rlm-1"]!.status).toBe("done")
    expect(s.rlms["rlm-2"]!.parent).toBe("rlm-1")
  })

  test("a stopped run (cancelled) is idle; other threads' events and replayed events are ignored", () => {
    const s = fold([ev("RUN_STARTED"), ev("RUN_FINISHED", { outcome: { type: "cancelled" } })])
    expect(s.status).toBe("idle")
    const other = reduce(s, ev("RUN_STARTED", {}, "checkout"))
    expect(other.status).toBe("idle")
    const replay = reduce(s, { type: "RUN_STARTED", threadId: "main", seq: 1 })
    expect(replay).toBe(s)
  })
})

test("an empty activity snapshot starts a fresh tree; a snapshot with nodes (a reconnect) does not", () => {
  const snap = (seq: number, rlms: object) => ({ type: "ACTIVITY_SNAPSHOT", threadId: "main", seq, messageId: "main-activity", activityType: "rlm", content: { rlms } }) as never
  const node = { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 0, budget: 25, status: "running", decisions: [] }
  let t = reduce(initial("main"), snap(1, {}))
  expect(t.trees).toBe(1)
  t = reduce(t, snap(2, { "rlm-1": node }))
  expect(t.trees).toBe(1)
  t = reduce(t, snap(3, {}))
  expect(t.trees).toBe(2)
})

describe("YOLO", () => {
  test("a zarg.yolo custom event sets whether plugins pass without asking", () => {
    const on = reduce(initial("main"), { type: "CUSTOM", threadId: "main", seq: 1, name: "zarg.yolo", value: { on: true } } as never)
    expect(on.yolo).toBe(true)
    expect(reduce(on, { type: "CUSTOM", threadId: "main", seq: 2, name: "zarg.yolo", value: { on: false } } as never).yolo).toBe(false)
  })
})

test("view activities build the thread's views; they never touch the agents tree", () => {
  const layout = { name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }] }
  let s = initial("main")
  s = reduce(s, { type: "ACTIVITY_SNAPSHOT", threadId: "main", seq: 1, messageId: "main:view:rehearse:t-1", activityType: "zarg.view", content: { agent: "rehearse:t-1", layout, data: {} } } as never)
  s = reduce(s, { type: "ACTIVITY_DELTA", threadId: "main", seq: 2, messageId: "main:view:rehearse:t-1", activityType: "zarg.view", content: { agent: "rehearse:t-1" }, patch: [{ op: "add", path: "/data/steps/lines/-", value: { text: "ok" } }] } as never)
  expect(s.views?.["rehearse:t-1"]?.data).toEqual({ steps: { lines: [{ text: "ok" }] } })
  expect(s.rlms).toEqual({})
})

test("replaying a view's events gives the view the core holds", () => {
  const layout = { name: "tester", sections: [{ id: "steps", kind: "log", role: "log" }, { id: "progress", kind: "stats", role: "summary" }] }
  const events = [
    { type: "ACTIVITY_SNAPSHOT", threadId: "main", seq: 1, messageId: "m", activityType: "zarg.view", content: { agent: "a", layout, data: {} } },
    ...Array.from({ length: 300 }, (_, i) => ({ type: "ACTIVITY_DELTA", threadId: "main", seq: i + 2, messageId: "m", activityType: "zarg.view", content: { agent: "a" }, patch: [{ op: "add", path: "/data/steps/lines/-", value: { text: String(i) } }, { op: "replace", path: "/data/progress", value: { items: [{ label: "n", value: String(i) }] } }] })),
  ]
  const live = events.reduce((s, e) => reduce(s, e as never), initial("main"))
  // A client attaching late gets the same events again (seq order); a reconnect replays some twice.
  const late = [...events, ...events.slice(100)].reduce((s, e) => reduce(s, e as never), initial("main"))
  expect(late.views).toEqual(live.views)
  expect((live.views!.a!.data.steps as { lines: unknown[] }).lines).toHaveLength(300)
})

describe("prompts", () => {
  const asked = (id: string, threadId = "main") => ev("CUSTOM", { name: "zarg.prompt", value: { id, question: `q ${id}`, options: [{ id: "once", label: "Allow once" }], kind: "grant" } }, threadId)
  test("prompts queue in the order asked; done takes one out", () => {
    const s = fold([asked("p1"), asked("p2"), ev("CUSTOM", { name: "zarg.prompt.done", value: { id: "p1" } })])
    expect(s.prompts?.map((p) => p.id)).toEqual(["p2"])
  })
  test("a prompt answered anywhere leaves every client's queue, whatever thread the client follows", () => {
    const s = fold([asked("p1"), ev("CUSTOM", { name: "zarg.prompt.done", value: { id: "p1", withdrawn: true } })], initial("other"))
    expect(s.prompts ?? []).toEqual([])
    expect(fold([asked("p1")], initial("other")).prompts?.map((p) => p.id)).toEqual(["p1"])
  })
  test("a replayed prompt is not queued twice", () => {
    const e = asked("p1")
    expect([e, e].reduce(reduce, initial("main")).prompts).toHaveLength(1)
  })
})

describe("surfaces", () => {
  const panel = { id: "rehearse:status:rehearse:run", plugin: "rehearse", agent: "rehearse:run", view: "rehearse:run@status", name: "status", scope: "shell", edge: "bottom", size: 1, input: "none" } as const
  test("a panels snapshot sets the panels; a later one replaces them, from any thread", () => {
    const s = fold([ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.panels", messageId: "main:panels", content: { panels: [panel] } }), ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.panels", messageId: "main:panels", content: { panels: [] } })])
    expect(s.panels).toEqual([])
    expect(fold([ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.panels", messageId: "main:panels", content: { panels: [panel] } }, "main")], initial("other")).panels).toEqual([panel])
  })
  test("a nav snapshot sets the plugins' nav items; a later one replaces them", () => {
    const item = { id: "gherkin:journeys", plugin: "gherkin", name: "journeys", label: "Journeys", view: "gherkin:journeys@journeys" }
    const s = fold([ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.nav", messageId: "main:nav", content: { items: [item] } })])
    expect(s.nav).toEqual([item])
    expect(fold([ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.nav", messageId: "main:nav", content: { items: [item] } }), ev("ACTIVITY_SNAPSHOT", { activityType: "zarg.nav", messageId: "main:nav", content: { items: [] } })]).nav).toEqual([])
  })
  test("a navigation request keeps its seq and time", () => {
    const e = ev("CUSTOM", { name: "zarg.navigate", value: { kind: "tile", view: "rehearse:t1", at: 123 } })
    expect(fold([e]).navigate).toEqual({ seq: e.seq, kind: "tile", view: "rehearse:t1", at: 123 })
  })
  test("a plugin's popover queues with its view and agent and no options", () => {
    const s = fold([ev("CUSTOM", { name: "zarg.prompt", value: { id: "p1", kind: "surface", question: "rehearse ask", options: [], view: "rehearse:t1", agent: "rehearse:t1" } })])
    expect(s.prompts).toEqual([{ id: "p1", kind: "surface", question: "rehearse ask", options: [], view: "rehearse:t1", agent: "rehearse:t1" }])
  })
})

describe("archive", () => {
  test("archived agents keep their reason and time; restore brings them back; delete is for good", () => {
    const s = fold([
      ev("CUSTOM", { name: "zarg.archive", value: { archive: ["rehearse:t1", "rehearse:t2"], reason: "archived by you", at: 5 } }),
      ev("CUSTOM", { name: "zarg.archive", value: { restore: ["rehearse:t2"] } }),
      ev("CUSTOM", { name: "zarg.archive", value: { delete: ["rehearse:t1"] } }),
    ])
    expect(s.archived).toEqual({ "rehearse:t1": { reason: "archived by you", at: 5 } })
    expect(s.deleted).toEqual(["rehearse:t1"])
  })
  test("a fresh driver tree forgets archived RLMs (their ids start over), never plugin agents", () => {
    const s = fold([
      ev("CUSTOM", { name: "zarg.archive", value: { archive: ["rlm-1", "rehearse:t1"], reason: "ttl (24h)", at: 5 } }),
      ev("ACTIVITY_SNAPSHOT", { messageId: "main-activity", content: { rlms: {} } }),
    ])
    expect(Object.keys(s.archived ?? {})).toEqual(["rehearse:t1"])
  })
})
