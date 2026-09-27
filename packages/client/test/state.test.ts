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

  test("messages build from START, CONTENT, END; the next run clears the inquiry once it finishes", () => {
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
  const snap = (seq: number, rlms: object) => ({ type: "ACTIVITY_SNAPSHOT", threadId: "main", seq, messageId: "a", activityType: "rlm", content: { rlms } }) as never
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

