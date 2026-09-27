import { keyFor } from "./keys"
import { leafAt } from "./layout"
import type { LayoutLeaf, LayoutSection } from "./schema"
import type { ViewState } from "./reducer"

/** What the developer has done in a view: the focused section, each tabs section's tab, each table's cursor and selection. */
export interface ViewUi {
  readonly focus: number
  readonly tabs: Readonly<Record<string, number>>
  readonly rows: Readonly<Record<string, number>>
  readonly selected: Readonly<Record<string, ReadonlyArray<string>>>
}
export const initialViewUi: ViewUi = { focus: 0, tabs: {}, rows: {}, selected: {} }

const ROLE_ORDER = ["summary", "primary", "log", "aside", "pinned"] as const
/** Sections in the order platforms read them: by role, declared order within a role. */
export const ordered = (layout: ViewState["layout"]): ReadonlyArray<LayoutSection> =>
  ROLE_ORDER.flatMap((role) => layout.sections.filter((s) => s.role === role))

/** How a view opens: its first table with actions focused (rows can be picked at once), else its first section. */
export const startUi = (view: ViewState): ViewUi => {
  const at = ordered(view.layout).findIndex((s) =>
    s.kind === "tabs" ? s.tabs.some((t) => t.kind === "table" && (t.actions ?? []).length > 0) : s.kind === "table" && (s.actions ?? []).length > 0,
  )
  return { ...initialViewUi, focus: Math.max(0, at) }
}

export const focused = (view: ViewState, ui: ViewUi): LayoutSection | undefined => {
  const all = ordered(view.layout)
  return all[Math.min(ui.focus, all.length - 1)]
}

/** The leaf a section shows now (its current tab for tabs). */
export const leafOf = (view: ViewState, ui: ViewUi, sectionId: string): { readonly path: string; readonly leaf: LayoutLeaf } | undefined => {
  const s = view.layout.sections.find((x) => x.id === sectionId)
  if (s === undefined) return undefined
  if (s.kind !== "tabs") return { path: s.id, leaf: s }
  const t = s.tabs[Math.min(ui.tabs[s.id] ?? 0, s.tabs.length - 1)]
  return t === undefined ? undefined : { path: `${s.id}.${t.id}`, leaf: leafAt(view.layout, `${s.id}.${t.id}`)! }
}

export const rowsOf = (view: ViewState, path: string): ReadonlyArray<{ readonly id: string }> => {
  const d = view.data[path] as { rows?: ReadonlyArray<{ id: string }>; items?: ReadonlyArray<{ id: string }> } | undefined
  return d?.rows ?? d?.items ?? []
}

const current = (view: ViewState, ui: ViewUi) => {
  const s = focused(view, ui)
  return s === undefined ? undefined : leafOf(view, ui, s.id)
}

export const focusNext = (view: ViewState, ui: ViewUi, dir: 1 | -1): ViewUi => {
  const n = view.layout.sections.length
  return n === 0 ? ui : { ...ui, focus: (((ui.focus + dir) % n) + n) % n }
}

export const nextTab = (view: ViewState, ui: ViewUi, dir: 1 | -1): ViewUi => {
  const s = focused(view, ui)
  if (s === undefined || s.kind !== "tabs") return ui
  const n = s.tabs.length
  return { ...ui, tabs: { ...ui.tabs, [s.id]: ((((ui.tabs[s.id] ?? 0) + dir) % n) + n) % n } }
}

export const moveRow = (view: ViewState, ui: ViewUi, delta: number): ViewUi => {
  const c = current(view, ui)
  if (c === undefined || (c.leaf.kind !== "table" && c.leaf.kind !== "list")) return ui
  const last = Math.max(0, rowsOf(view, c.path).length - 1)
  return { ...ui, rows: { ...ui.rows, [c.path]: Math.max(0, Math.min(last, (ui.rows[c.path] ?? 0) + delta)) } }
}

export const toggleSelect = (view: ViewState, ui: ViewUi): ViewUi => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table" || c.leaf.selectable !== true) return ui
  const row = rowsOf(view, c.path)[ui.rows[c.path] ?? 0]
  if (row === undefined) return ui
  const sel = ui.selected[c.path] ?? []
  return { ...ui, selected: { ...ui.selected, [c.path]: sel.includes(row.id) ? sel.filter((x) => x !== row.id) : [...sel, row.id] } }
}

/** The action a key triggers on a platform: the focused table's, else the view's own; undefined when none. */
export const actionFor = (view: ViewState, ui: ViewUi, key: string, platform = "terminal"): { readonly section: string | undefined; readonly action: string; readonly rows: ReadonlyArray<string> } | undefined => {
  const c = current(view, ui)
  const a = c !== undefined && c.leaf.kind === "table" ? (c.leaf.actions ?? []).find((x) => keyFor(x, platform) === key) : undefined
  if (c === undefined || a === undefined) {
    const own = (view.layout.actions ?? []).find((x) => keyFor(x, platform) === key)
    return own === undefined ? undefined : { section: undefined, action: own.id, rows: [] }
  }
  const all = rowsOf(view, c.path)
  const row = all[ui.rows[c.path] ?? 0]
  // Rows can be replaced under a selection: only ids the table still shows are sent.
  const sel = (ui.selected[c.path] ?? []).filter((id) => all.some((r) => r.id === id))
  const rows = a.on === "none" ? [] : a.on === "row" ? (row !== undefined ? [row.id] : []) : sel.length > 0 ? sel : row !== undefined ? [row.id] : []
  return a.on !== "none" && rows.length === 0 ? undefined : { section: c.path, action: a.id, rows }
}

/** A click or tap on a row: its section takes focus, the cursor moves there, and a selectable row toggles. */
export const pickRow = (view: ViewState, ui: ViewUi, sectionId: string, index: number): ViewUi => {
  const focus = ordered(view.layout).findIndex((s) => s.id === sectionId)
  if (focus < 0) return ui
  const at = { ...ui, focus }
  const c = leafOf(view, at, sectionId)
  if (c === undefined) return at
  const moved = { ...at, rows: { ...at.rows, [c.path]: index } }
  return c.leaf.kind === "table" && c.leaf.selectable === true ? toggleSelect(view, moved) : moved
}

/** After an action ran: that table's selection clears. */
export const afterAction = (ui: ViewUi, section: string | undefined): ViewUi => (section === undefined ? ui : { ...ui, selected: { ...ui.selected, [section]: [] } })
