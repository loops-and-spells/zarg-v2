import type { ViewState } from "@zarg/view"
import type { ThreadState } from "./state"

/** zarg's agent id: the root of the conversation thread's agents tree. */
export const ZARG = "zarg"

/**
 * zarg's conversation as a view: built from what the thread already carries on AG-UI (its messages, the pending
 * interrupt, the run status), so every platform draws it with the same conversation renderer.
 */
export const zargConversation = (t: ThreadState): ViewState => {
  const q = t.pendingInquiry
  return {
    agent: ZARG,
    layout: { name: "zarg", sections: [{ id: "talk", kind: "conversation", role: "primary" }] },
    data: {
      talk: {
        messages: t.messages.map((m) => ({ id: m.id, role: m.role === "user" ? "user" : "agent", text: m.text })),
        ...(q !== undefined
          ? {
              question: {
                id: q.id,
                question: q.question,
                options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.why !== undefined ? { why: o.why } : {}), ...(o.recommended === true ? { recommended: true } : {}) })),
                allowOther: q.allowOther,
                ...(q.otherLabel !== undefined ? { otherLabel: q.otherLabel } : {}),
                ...(q.kind !== undefined ? { kind: q.kind } : {}),
              },
            }
          : {}),
        status: t.status === "running" ? "working" : t.status === "waiting" ? "waiting" : "idle",
      },
    },
  }
}
