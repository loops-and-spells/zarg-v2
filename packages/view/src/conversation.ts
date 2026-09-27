import type { ConversationData } from "./schema"

/** A question as a conversation holds it. */
export type ConversationQuestion = NonNullable<(typeof ConversationData.Type)["question"]>

export const OTHER = "__other"
export const CHAT = "__chat"

/** What the developer is doing with the conversation's question: the highlighted row, typing their own answer, chatting about it, answered. */
export interface ConversationUi {
  readonly pick: number
  readonly other: boolean
  /** The question being chatted about: the message input shows, the options wait. */
  readonly chatting?: string
  /** The question already answered: further Enters wait for the next one. */
  readonly answered?: string
  /** The question `pick` belongs to; a new one resets the selection. */
  readonly questionId?: string
}
export const initialConversationUi: ConversationUi = { pick: 0, other: false }

export interface ConversationRow {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly recommended: boolean
  readonly selected: boolean
}

/** The question's options, "Something else…" when free text is allowed, and "Chat about this"; a grant question offers only its options. */
export const conversationRows = (q: ConversationQuestion, ui: ConversationUi): ReadonlyArray<ConversationRow> => {
  const rows = [
    ...q.options.map((o) => ({ id: o.id, label: o.label, ...(o.why !== undefined ? { why: o.why } : {}), recommended: o.recommended === true })),
    ...(q.allowOther && q.kind !== "grant" ? [{ id: OTHER, label: `${q.otherLabel ?? "Something else"}…`, recommended: false }] : []),
    ...(q.kind !== "grant" ? [{ id: CHAT, label: "Chat about this", recommended: false }] : []),
  ]
  return rows.map((r, i) => ({ ...r, selected: i === ui.pick }))
}

const preselect = (q: ConversationQuestion) => Math.max(0, q.options.findIndex((o) => o.recommended === true))

/** A new question preselects its recommended option (or the first); no question clears the state. */
export const syncConversation = (ui: ConversationUi, q: ConversationQuestion | undefined): ConversationUi => {
  if (q === undefined) return ui.questionId === undefined && !ui.other && ui.chatting === undefined ? ui : initialConversationUi
  if (q.id === ui.questionId) return ui
  return { pick: preselect(q), other: false, questionId: q.id }
}

/** The message input shows when nothing is asked, or while chatting about the question. */
export const inputShown = (ui: ConversationUi, q: ConversationQuestion | undefined) => q === undefined || ui.chatting === q.id

/** A key on the question: arrows move, Enter answers with the option or starts chatting, Escape leaves chatting or the free-text row. */
export const conversationKey = (ui0: ConversationUi, q: ConversationQuestion, key: string): { readonly ui: ConversationUi; readonly answer?: { readonly choice: string } } => {
  const ui = syncConversation(ui0, q)
  if (ui.answered === q.id) return { ui }
  if (ui.chatting === q.id) {
    if (key !== "escape") return { ui }
    const { chatting: _, ...rest } = ui
    return { ui: rest }
  }
  const rows = conversationRows(q, ui)
  const moveTo = (pick: number): ConversationUi => ({ ...ui, pick, other: rows[pick]?.id === OTHER })
  if (key === "up") return { ui: moveTo(Math.max(0, ui.pick - 1)) }
  if (key === "down") return { ui: moveTo(Math.min(rows.length - 1, ui.pick + 1)) }
  if (key === "escape" && ui.other) return { ui: moveTo(preselect(q)) }
  if (key === "return") {
    const row = rows[ui.pick]
    // Something else… answers from its own text (conversationSubmit).
    if (row === undefined || row.id === OTHER) return { ui }
    if (row.id === CHAT) return { ui: { ...ui, other: false, chatting: q.id } }
    return { ui: { ...ui, answered: q.id }, answer: { choice: row.id } }
  }
  return { ui }
}

/** Text submitted: the free-text answer to the question, or a message (sent while nothing is asked, or while chatting about it). */
export const conversationSubmit = (
  ui: ConversationUi,
  q: ConversationQuestion | undefined,
  text: string,
): { readonly ui: ConversationUi; readonly answer?: { readonly other: string }; readonly send?: string } => {
  if (text.trim().length === 0) return { ui }
  if (q !== undefined && ui.other && ui.chatting !== q.id) {
    if (ui.answered === q.id) return { ui }
    return { ui: { ...ui, other: false, answered: q.id }, answer: { other: text } }
  }
  return { ui, send: text }
}
