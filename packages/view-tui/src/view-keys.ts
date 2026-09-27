import { actionFor, afterAction, focusNext, moveRow, nextTab, toggleSelect, type ViewState, type ViewUi } from "@zarg/view"

/** A key in an open agent's view: focus, scroll a table's cursor, switch tabs, select, act. */
export const viewKeys = (view: ViewState, ui: ViewUi, key: { readonly name: string; readonly shift?: boolean }): { readonly ui: ViewUi; readonly act?: { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> } } => {
  if (key.name === "tab") return { ui: focusNext(view, ui, key.shift === true ? -1 : 1) }
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
