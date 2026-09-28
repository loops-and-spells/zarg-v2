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
  /** Each table's sort: a column and its direction (1 ascending). */
  readonly sort?: Readonly<Record<string, { readonly col: string; readonly dir: 1 | -1 }>>
  /** The cursor on a table's header row, at a column. */
  readonly header?: { readonly path: string; readonly col: number }
  /** A column's open menu and its highlighted entry. */
  readonly menu?: { readonly path: string; readonly col: number; readonly pick: number }
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

type Cells = { readonly id: string; readonly cells?: Readonly<Record<string, string>> }
type Col = { readonly id: string; readonly label: string; readonly order?: ReadonlyArray<string> }
const columnsAt = (view: ViewState, path: string): ReadonlyArray<Col> => leafAt(view.layout, path)?.columns ?? []
/** Two values of a column in ascending order: its declared order first (unknown values after), else text with numbers as numbers. */
const compare = (col: Col) => (a: string, b: string) => {
  const rank = (v: string) => {
    const i = col.order?.indexOf(v) ?? -1
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })
}
/** A table's rows in the order they show: its sort's, else the plugin's. */
export const shownRows = (view: ViewState, ui: ViewUi, path: string): ReadonlyArray<{ readonly id: string }> => {
  const rows = rowsOf(view, path) as ReadonlyArray<Cells>
  const by = ui.sort?.[path]
  const col = by === undefined ? undefined : columnsAt(view, path).find((c) => c.id === by.col)
  if (by === undefined || col === undefined) return rows
  const cmp = compare(col)
  return [...rows].sort((x, y) => by.dir * cmp(x.cells?.[col.id] ?? "", y.cells?.[col.id] ?? ""))
}

export type MenuEntry =
  | { readonly kind: "sort"; readonly dir: 1 | -1; readonly active: boolean }
  | { readonly kind: "value"; readonly value: string; readonly selected: number; readonly total: number }
/** The open menu's entries: the two sorts, then each value of its column with how many of its rows are selected. */
export const menuEntries = (view: ViewState, ui: ViewUi): ReadonlyArray<MenuEntry> => {
  const m = ui.menu
  const col = m === undefined ? undefined : columnsAt(view, m.path)[m.col]
  if (m === undefined || col === undefined) return []
  const rows = rowsOf(view, m.path) as ReadonlyArray<Cells>
  const sel = ui.selected[m.path] ?? []
  const values = [...new Set(rows.map((r) => r.cells?.[col.id] ?? ""))].sort(compare(col))
  const by = ui.sort?.[m.path]
  return [
    ...([1, -1] as const).map((dir) => ({ kind: "sort" as const, dir, active: by?.col === col.id && by.dir === dir })),
    ...values.map((value) => {
      const of = rows.filter((r) => (r.cells?.[col.id] ?? "") === value)
      return { kind: "value" as const, value, selected: of.filter((r) => sel.includes(r.id)).length, total: of.length }
    }),
  ]
}
export const openMenu = (_view: ViewState, ui: ViewUi, path: string, col: number): ViewUi => ({ ...ui, header: { path, col }, menu: { path, col, pick: 0 } })
export const closeMenu = (ui: ViewUi): ViewUi => {
  const { menu: _, ...rest } = ui
  return rest
}
export const menuMove = (view: ViewState, ui: ViewUi, delta: number): ViewUi =>
  ui.menu === undefined ? ui : { ...ui, menu: { ...ui.menu, pick: Math.max(0, Math.min(menuEntries(view, ui).length - 1, ui.menu.pick + delta)) } }
/** An entry of the open menu (the highlighted one by default): a sort sets it (again: off), a value ticks all its rows (all ticked: unticks them). */
export const applyMenu = (view: ViewState, ui: ViewUi, index?: number): ViewUi => {
  const m = ui.menu
  const e = menuEntries(view, ui)[index ?? m?.pick ?? 0]
  const col = m === undefined ? undefined : columnsAt(view, m.path)[m.col]
  if (m === undefined || e === undefined || col === undefined) return ui
  const at = { ...ui, menu: { ...m, pick: index ?? m.pick } }
  if (e.kind === "sort") {
    const { [m.path]: _, ...others } = ui.sort ?? {}
    return { ...at, sort: e.active ? others : { ...others, [m.path]: { col: col.id, dir: e.dir } } }
  }
  const ids = (rowsOf(view, m.path) as ReadonlyArray<Cells>).filter((r) => (r.cells?.[col.id] ?? "") === e.value).map((r) => r.id)
  const sel = ui.selected[m.path] ?? []
  const next = e.selected === e.total ? sel.filter((id) => !ids.includes(id)) : [...sel, ...ids.filter((id) => !sel.includes(id))]
  return { ...at, selected: { ...ui.selected, [m.path]: next } }
}
/** On a header: ←→ move between its columns. */
export const moveColumn = (view: ViewState, ui: ViewUi, dir: number): ViewUi =>
  ui.header === undefined ? ui : { ...ui, header: { ...ui.header, col: Math.max(0, Math.min(columnsAt(view, ui.header.path).length - 1, ui.header.col + dir)) } }
/** A click on a column's header: its table takes focus and the column's menu opens. */
export const pickHeader = (view: ViewState, ui: ViewUi, sectionId: string, col: number): ViewUi => {
  const focus = ordered(view.layout).findIndex((s) => s.id === sectionId)
  const c = focus < 0 ? undefined : leafOf(view, { ...ui, focus }, sectionId)
  return c === undefined ? ui : openMenu(view, { ...ui, focus }, c.path, col)
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
  // The header row sits above the first row: ↑ there reaches it, ↓ leaves it.
  if (ui.header?.path === c.path) {
    if (delta <= 0) return ui
    const { header: _, ...rest } = ui
    return rest
  }
  if (c.leaf.kind === "table" && (c.leaf.columns ?? []).length > 0 && delta < 0 && (ui.rows[c.path] ?? 0) === 0) return { ...ui, header: { path: c.path, col: 0 } }
  return { ...ui, rows: { ...ui.rows, [c.path]: Math.max(0, Math.min(last, (ui.rows[c.path] ?? 0) + delta)) } }
}

export const toggleSelect = (view: ViewState, ui: ViewUi): ViewUi => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table" || c.leaf.selectable !== true) return ui
  const row = shownRows(view, ui, c.path)[ui.rows[c.path] ?? 0]
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
  const all = shownRows(view, ui, c.path)
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
  const { header: _h, menu: _m, ...off } = at
  const moved = { ...off, rows: { ...at.rows, [c.path]: index } }
  return c.leaf.kind === "table" && c.leaf.selectable === true ? toggleSelect(view, moved) : moved
}

/** After an action ran: that table's selection clears. */
export const afterAction = (ui: ViewUi, section: string | undefined): ViewUi => (section === undefined ? ui : { ...ui, selected: { ...ui.selected, [section]: [] } })
