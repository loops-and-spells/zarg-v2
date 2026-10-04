import { typed, actionFor, boardKey, chooseKey, inputKey, pressAction, viewActions, afterAction, applyMenu, closeMenu, menuAdjust, menuEntries, menuMove, menuQuery, printable, setSearch, moveColumn, openMenu, type ConversationQuestion, conversationKey, focused, focusNext, leafOf, moveRow, nextTab, toggleAct, toggleSelect, type ViewState, type ViewUi } from "@zarg/view"

/** A key in an open agent's view: focus, scroll a table's cursor, switch tabs, select, act. */
export const viewKeys = (view: ViewState, ui: ViewUi, key: { readonly name: string; readonly shift?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }): {
  readonly ui: ViewUi
  readonly act?: { readonly section: string | undefined; readonly action: string; readonly rows: ReadonlyArray<string>; readonly text?: string }
  readonly scroll?: number
  readonly answer?: { readonly question: string; readonly answer: { readonly choice?: string; readonly other?: string } }
} => {
  // Ctrl and Meta chords are the shell's, never an action's key.
  if (key.ctrl === true || key.meta === true) return { ui }
  // Dropped-down choices have the keys until one is picked or Esc closes them.
  const choosing = chooseKey(ui, key)
  if (choosing !== undefined) return choosing
  // An action's line of text has the keys until Enter sends it or Esc drops it.
  const typing = inputKey(ui, key)
  if (typing !== undefined) return typing
  // A focused board has its own keys (lanes, cards, folds, moves).
  const board = boardKey(view, ui, key)
  if (board !== undefined) return board
  // A table's search field has the keys: typing edits the query; Enter or an arrow leaves it (the search stays); Esc clears it.
  if (ui.searching !== undefined) {
    const path = ui.searching
    const q = ui.search?.[path] ?? ""
    const { searching: _, ...off } = ui
    if (key.name === "escape") return { ui: setSearch(view, off, path, "") }
    if (key.name === "return" || key.name === "down" || key.name === "up") return { ui: off }
    if (printable(key)) return { ui: setSearch(view, ui, path, key.name === "backspace" ? q.slice(0, -1) : `${q}${typed(key)}`) }
    return { ui }
  }
  {
    const here = focused(view, ui)
    const t = here === undefined ? undefined : leafOf(view, ui, here.id)
    if (key.name === "f" && t !== undefined && t.leaf.kind === "table" && t.leaf.search === true && ui.menu === undefined) return { ui: { ...ui, searching: t.path } }
  }
  // A column's menu: ↑↓ move, Enter or Space apply, Esc closes it.
  if (ui.menu !== undefined) {
    if (key.name === "up" || key.name === "down") return { ui: menuMove(view, ui, key.name === "up" ? -1 : 1) }
    if (key.name === "escape") return { ui: closeMenu(ui) }
    if (key.name === "left" || key.name === "right") return { ui: menuAdjust(view, ui, key.name === "left" ? -1 : 1) }
    // A search menu owns the typing (space too); Enter still applies the highlighted entry.
    const search = menuEntries(view, ui)[0]?.kind === "query"
    if (key.name === "return" || (key.name === "space" && !search)) return { ui: applyMenu(view, ui) }
    if (search && printable(key)) {
      const q = ui.menu.query ?? ""
      return { ui: menuQuery(view, ui, key.name === "backspace" ? q.slice(0, -1) : `${q}${typed(key)}`) }
    }
    return { ui }
  }
  // On a table's header: ←→ columns, Enter or Space opens the column's menu (↓ goes back to the rows, below).
  if (ui.header !== undefined) {
    if (key.name === "left" || key.name === "right") return { ui: moveColumn(view, ui, key.name === "left" ? -1 : 1) }
    if (key.name === "return" || key.name === "space") return { ui: openMenu(view, ui, ui.header.path, ui.header.col) }
  }
  // ] [ move between sections, } { between a section's tabs (Tab is the shell's: back).
  if (key.name === "]") return { ui: focusNext(view, ui, 1) }
  if (key.name === "[") return { ui: focusNext(view, ui, -1) }
  if (key.name === "}") return { ui: nextTab(view, ui, 1) }
  if (key.name === "{") return { ui: nextTab(view, ui, -1) }
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
  if (key.name === "down") return { ui: moveRow(view, ui, 1) }
  if (key.name === "up") return { ui: moveRow(view, ui, -1) }
  if (key.name === "pagedown") return { ui: moveRow(view, ui, 10) }
  if (key.name === "pageup") return { ui: moveRow(view, ui, -10) }
  if (key.name === "space") {
    const flip = toggleAct(view, ui)
    return flip !== undefined ? { ui, act: flip } : { ui: toggleSelect(view, ui) }
  }
  // A capital arrives as its letter with Shift: the action keyed with the capital.
  const a = actionFor(view, ui, typed(key))
  if (a === undefined) return { ui }
  // One that asks for text opens its input first; one with choices drops them down.
  const pressed = pressAction(view, ui, a.section, a.action, a.rows)
  return pressed.act === undefined ? { ui: pressed.ui } : { ui: afterAction(pressed.ui, a.section), act: pressed.act }
}
