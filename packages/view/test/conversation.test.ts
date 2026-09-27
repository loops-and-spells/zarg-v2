import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CHAT, conversationKey, conversationRows, conversationSubmit, DATA, inputShown, initialConversationUi, OTHER, syncConversation } from "../src"

const q = {
  id: "inq-1",
  question: "Which card first?",
  options: [{ id: "login", label: "Login" }, { id: "checkout", label: "Checkout", recommended: true, why: "most used" }],
  allowOther: true,
}

describe("the conversation section", () => {
  test("its data round trips: messages, a question, a status", () => {
    const d = { messages: [{ id: "m1", role: "agent", text: "hi" }], question: q, status: "waiting" }
    expect(Schema.decodeUnknownSync(DATA.conversation as Schema.Codec<unknown, unknown>)(d)).toEqual(d)
  })

  test("a new question preselects its recommended option; the rows end with Something else… and Chat about this", () => {
    const ui = syncConversation(initialConversationUi, q)
    expect(ui.pick).toBe(1)
    expect(conversationRows(q, ui).map((r) => [r.label, r.selected])).toEqual([["Login", false], ["Checkout", true], ["Something else…", false], ["Chat about this", false]])
    expect(conversationRows(q, ui)[1]!.why).toBe("most used")
  })

  test("arrows move, Enter answers with the option; Something else… takes typed text; Chat about this shows the input until Escape", () => {
    let ui = syncConversation(initialConversationUi, q)
    expect(conversationKey(ui, q, "return").answer).toEqual({ choice: "checkout" })
    ui = conversationKey(ui, q, "down").ui
    expect(ui.other).toBe(true)
    expect(conversationSubmit(ui, q, "Signup").answer).toEqual({ other: "Signup" })
    ui = conversationKey(ui, q, "down").ui
    expect(conversationRows(q, ui)[ui.pick]!.id).toBe(CHAT)
    ui = conversationKey(ui, q, "return").ui
    expect(inputShown(ui, q)).toBe(true)
    expect(conversationSubmit(ui, q, "why checkout?")).toMatchObject({ send: "why checkout?" })
    ui = conversationKey(ui, q, "escape").ui
    expect(inputShown(ui, q)).toBe(false)
  })

  test("an answered question takes no second answer; with no question the input is shown and text is sent", () => {
    const ui = conversationKey(syncConversation(initialConversationUi, q), q, "return").ui
    expect(conversationKey(ui, q, "return").answer).toBeUndefined()
    expect(inputShown(initialConversationUi, undefined)).toBe(true)
    expect(conversationSubmit(initialConversationUi, undefined, "hello")).toEqual({ ui: initialConversationUi, send: "hello" })
  })

  test("a grant question offers only its answers", () => {
    const g = { id: "inq-g", question: "Plugin rehearse wants to load", options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }], allowOther: false, kind: "grant" as const }
    expect(conversationRows(g, initialConversationUi).map((r) => r.label)).toEqual(["Allow", "Not now"])
    expect(OTHER).toBe("__other")
  })
})
