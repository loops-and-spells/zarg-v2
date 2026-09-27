import { expect, test } from "bun:test"
import { initial, zargConversation } from "../src"

test("zarg's conversation is a conversation section built from the thread: messages, its question, its status", () => {
  const thread = {
    ...initial("main"),
    status: "waiting" as const,
    messages: [{ id: "m1", role: "user" as const, text: "rehearse" }, { id: "m2", role: "assistant" as const, text: "done" }],
    pendingInquiry: { id: "inq-1", question: "Which?", options: [{ id: "a", label: "A", recommended: true }], allowOther: true, about: [], kind: "grant" as const },
  }
  const v = zargConversation(thread)
  expect(v.agent).toBe("zarg")
  expect(v.layout.sections).toEqual([{ id: "talk", kind: "conversation", role: "primary" }])
  expect(v.data.talk).toEqual({
    messages: [{ id: "m1", role: "user", text: "rehearse" }, { id: "m2", role: "agent", text: "done" }],
    question: { id: "inq-1", question: "Which?", options: [{ id: "a", label: "A", recommended: true }], allowOther: true, kind: "grant" },
    status: "waiting",
  })
  expect(zargConversation(initial("main")).data.talk).toEqual({ messages: [], status: "idle" })
})
