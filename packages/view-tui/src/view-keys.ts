import { actionFor, afterAction, type ConversationQuestion, conversationKey, focused, focusNext, leafOf, moveRow, nextTab, toggleSelect, type ViewState, type ViewUi } from "@zarg/view"

/** A key in an open agent's view: focus, scroll a table's cursor, switch tabs, select, act. */
export const viewKeys = (view: ViewState, ui: ViewUi, key: { readonly name: string; readonly shift?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }): {
  readonly ui: ViewUi
  readonly act?: { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> }
  readonly scroll?: number
  readonly answer?: { readonly question: string; readonly answer: { readonly choice?: string; readonly other?: string } }
} => {
  // Ctrl and Meta chords are the shell's, never an action's key.
  if (key.ctrl === true || key.meta === true) return { ui }
  if (key.name === "tab") return { ui: focusNext(view, ui, key.shift === true ? -1 : 1) }
  // A conversation with a question: arrows pick an option, Enter answers the agent.
  const at = focused(view, ui)
  const leaf = at === undefined ? undefined : leafOf(view, ui, at.id)
  const q = leaf?.leaf.kind === "conversation" ? (view.data[leaf.path] as { question?: ConversationQuestion } | undefined)?.question : undefined
  if (leaf !== undefined && q !== undefined && ["up", "down", "return"].includes(key.name)) {
    const r = conversationKey({ pick: ui.rows[leaf.path] ?? 0, other: false, questionId: q.id }, q, key.name)
    const next = { ...ui, rows: { ...ui.rows, [leaf.path]: r.ui.pick } }
    return r.answer !== undefined ? { ui: next, answer: { question: q.id, answer: r.answer } } : { ui: next }
  }
  // A log or text has no rows: the keys that move a cursor scroll it instead.
  const step = key.name === "down" ? 1 : key.name === "up" ? -1 : key.name === "pagedown" ? 10 : key.name === "pageup" ? -10 : 0
  const s = focused(view, ui)
  const kind = s === undefined ? undefined : leafOf(view, ui, s.id)?.leaf.kind
  if (step !== 0 && kind !== "table" && kind !== "list") return { ui, scroll: step }
  if (key.name === "]") return { ui: nextTab(view, ui, 1) }
  if (key.name === "[") return { ui: nextTab(view, ui, -1) }
  if (key.name === "down") return { ui: moveRow(view, ui, 1) }
  if (key.name === "up") return { ui: moveRow(view, ui, -1) }
  if (key.name === "pagedown") return { ui: moveRow(view, ui, 10) }
  if (key.name === "pageup") return { ui: moveRow(view, ui, -10) }
  if (key.name === "space") return { ui: toggleSelect(view, ui) }
  const a = actionFor(view, ui, key.name)
  return a === undefined ? { ui } : { ui: afterAction(ui, a.section), act: a }
}
