import { rank } from "@zarg/bm25"
import { keyFor } from "./keys"
import { leafAt } from "./layout"
import type { Action as ActionSchema, LayoutLeaf, LayoutSection } from "./schema"
import { printable } from "./input"
import type { ViewState } from "./reducer"

/** What the operator has done in a view: the focused section, each tabs section's tab, each table's cursor and selection. */
export interface ViewUi {
  readonly focus: number
  readonly tabs: Readonly<Record<string, number>>
  readonly rows: Readonly<Record<string, number>>
  readonly selected: Readonly<Record<string, ReadonlyArray<string>>>
  /** Each table's sort: a column and its direction (1 ascending). */
  readonly sort?: Readonly<Record<string, { readonly col: string; readonly dir: 1 | -1; readonly query?: string }>>
  /** The cursor on a table's header row, at a column. */
  readonly header?: { readonly path: string; readonly col: number }
  /** A column's open menu and its highlighted entry. */
  readonly menu?: { readonly path: string; readonly col: number; readonly pick: number; readonly query?: string; readonly range?: readonly [number, number] }
  /** Each searchable table's query. */
  readonly search?: Readonly<Record<string, string>>
  /** The table whose search field has the keys (typing goes there). */
  readonly searching?: string
  /** An action's line of text being typed (it acts on Enter). */
  readonly input?: { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string>; readonly text: string; readonly placeholder: string }
  /** Each board's cursor (a lane, a card in it) and its folded lanes (by id). */
  readonly board?: Readonly<Record<string, BoardUi>>
}
export interface BoardUi { readonly lane: number; readonly card: number; readonly folded: ReadonlyArray<string> }
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
type Filter = "values" | "none" | "search" | { readonly range: readonly [number, number]; readonly step?: number }
type Col = { readonly id: string; readonly label: string; readonly order?: ReadonlyArray<string>; readonly filter?: Filter }
const columnsAt = (view: ViewState, path: string): ReadonlyArray<Col> => leafAt(view.layout, path)?.columns ?? []
const cellsAt = (view: ViewState, path: string) => rowsOf(view, path) as ReadonlyArray<Cells>
const cell = (r: Cells, col: Col) => r.cells?.[col.id] ?? ""
/** Two values of a column in ascending order: its declared order first (unknown values after), else text with numbers as numbers. */
const compare = (col: Col) => (a: string, b: string) => {
  const rank = (v: string) => {
    const i = col.order?.indexOf(v) ?? -1
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })
}
/** A cell's number: the last one in it ("fix 0.83" is 0.83). */
const numberIn = (text: string): number | undefined => {
  const m = text.match(/-?\d+(?:\.\d+)?/g)
  return m === null ? undefined : Number(m.at(-1))
}
/** Each row's match for a query in a column (BM25; 0: none), in the plugin's row order. */
const matches = (view: ViewState, path: string, col: Col, query: string) => rank(cellsAt(view, path).map((r) => cell(r, col)), query)

/** What a column's menu offers: its declared filter, else ticking by value when it has 10 values or fewer, else sorting only. */
export const filterOf = (view: ViewState, path: string, colIndex: number): Filter => {
  const col = columnsAt(view, path)[colIndex]
  if (col === undefined) return "none"
  if (col.filter !== undefined) return col.filter
  return new Set(cellsAt(view, path).map((r) => cell(r, col))).size <= 10 ? "values" : "none"
}

/** A table's rows in the order they show: by match to its search, by its sort, else the plugin's. */
export const shownRows = (view: ViewState, ui: ViewUi, path: string): ReadonlyArray<{ readonly id: string }> => {
  const rows = cellsAt(view, path)
  // A search keeps the rows it matches, best first (whatever the sort).
  const q = ui.search?.[path]
  if (q !== undefined && q.trim() !== "") {
    const score = rank(rows.map((r) => [...Object.values(r.cells ?? {}), (r as { search?: string }).search ?? ""].join(" ")), q)
    return rows.map((r, i) => ({ r, s: score[i] ?? 0 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r)
  }
  const by = ui.sort?.[path]
  const col = by === undefined ? undefined : columnsAt(view, path).find((c) => c.id === by.col)
  if (by === undefined || col === undefined) return rows
  if (by.query !== undefined) {
    const score = matches(view, path, col, by.query)
    return rows.map((r, i) => ({ r, s: score[i] ?? 0 })).sort((x, y) => y.s - x.s).map((x) => x.r)
  }
  const cmp = compare(col)
  return [...rows].sort((x, y) => by.dir * cmp(cell(x, col), cell(y, col)))
}

export type MenuEntry =
  | { readonly kind: "sort"; readonly dir: 1 | -1; readonly active: boolean }
  | { readonly kind: "value"; readonly value: string; readonly selected: number; readonly total: number }
  | { readonly kind: "from" | "to"; readonly value: number }
  | { readonly kind: "tick-range" | "tick-matches"; readonly count: number; readonly selected: number }
  | { readonly kind: "query"; readonly text: string }
  | { readonly kind: "match"; readonly active: boolean }
const menuCol = (view: ViewState, ui: ViewUi) => (ui.menu === undefined ? undefined : columnsAt(view, ui.menu.path)[ui.menu.col])
const rangeOf = (view: ViewState, ui: ViewUi): readonly [number, number] => {
  const f = ui.menu === undefined ? "none" : filterOf(view, ui.menu.path, ui.menu.col)
  return ui.menu?.range ?? (typeof f === "object" ? f.range : [0, 1])
}
/** The rows a menu's tick entry would tick: inside the range, or matching the query. */
const tickable = (view: ViewState, ui: ViewUi): ReadonlyArray<string> => {
  const m = ui.menu
  const col = menuCol(view, ui)
  if (m === undefined || col === undefined) return []
  const rows = cellsAt(view, m.path)
  if (filterOf(view, m.path, m.col) === "search") {
    const score = matches(view, m.path, col, m.query ?? "")
    return rows.filter((_, i) => (score[i] ?? 0) > 0).map((r) => r.id)
  }
  const [lo, hi] = rangeOf(view, ui)
  return rows.filter((r) => {
    const n = numberIn(cell(r, col))
    return n !== undefined && n >= lo - 1e-9 && n <= hi + 1e-9
  }).map((r) => r.id)
}
/** The open menu's entries, by the column's filter: its sorts, then its values, its range or its search. */
export const menuEntries = (view: ViewState, ui: ViewUi): ReadonlyArray<MenuEntry> => {
  const m = ui.menu
  const col = menuCol(view, ui)
  if (m === undefined || col === undefined) return []
  const rows = cellsAt(view, m.path)
  const sel = ui.selected[m.path] ?? []
  const by = ui.sort?.[m.path]
  const sorts = ([1, -1] as const).map((dir) => ({ kind: "sort" as const, dir, active: by?.col === col.id && by.query === undefined && by.dir === dir }))
  const ticks = (kind: "tick-range" | "tick-matches") => {
    const ids = tickable(view, ui)
    return { kind, count: ids.length, selected: ids.filter((id) => sel.includes(id)).length }
  }
  const f = filterOf(view, m.path, m.col)
  if (f === "none") return sorts
  if (f === "search") return [{ kind: "query", text: m.query ?? "" }, ...sorts, { kind: "match", active: by?.col === col.id && by.query !== undefined }, ticks("tick-matches")]
  if (typeof f === "object") {
    const [lo, hi] = rangeOf(view, ui)
    return [...sorts, { kind: "from", value: lo }, { kind: "to", value: hi }, ticks("tick-range")]
  }
  const values = [...new Set(rows.map((r) => cell(r, col)))].sort(compare(col))
  return [
    ...sorts,
    ...values.map((value) => {
      const of = rows.filter((r) => cell(r, col) === value)
      return { kind: "value" as const, value, selected: of.filter((r) => sel.includes(r.id)).length, total: of.length }
    }),
  ]
}
export const openMenu = (_view: ViewState, ui: ViewUi, path: string, col: number): ViewUi => {
  const by = ui.sort?.[path]
  const query = by?.query !== undefined && ui.menu === undefined ? { query: by.query } : {}
  return { ...ui, header: { path, col }, menu: { path, col, pick: 0, ...query } }
}
export const closeMenu = (ui: ViewUi): ViewUi => {
  const { menu: _, ...rest } = ui
  return rest
}
export const menuMove = (view: ViewState, ui: ViewUi, delta: number): ViewUi =>
  ui.menu === undefined ? ui : { ...ui, menu: { ...ui.menu, pick: Math.max(0, Math.min(menuEntries(view, ui).length - 1, ui.menu.pick + delta)) } }
/** ←→ on a range's bound: one step, inside the column's range, from never past to. */
export const menuAdjust = (view: ViewState, ui: ViewUi, dir: number): ViewUi => {
  const m = ui.menu
  const e = menuEntries(view, ui)[m?.pick ?? -1]
  const f = m === undefined ? "none" : filterOf(view, m.path, m.col)
  if (m === undefined || typeof f !== "object" || e === undefined || (e.kind !== "from" && e.kind !== "to")) return ui
  const step = f.step ?? (f.range[1] - f.range[0]) / 20
  const [lo, hi] = rangeOf(view, ui)
  const round = (n: number) => Math.round(n / step) * step
  const next: readonly [number, number] =
    e.kind === "from" ? [Math.max(f.range[0], Math.min(hi, round(lo + dir * step))), hi] : [lo, Math.min(f.range[1], Math.max(lo, round(hi + dir * step)))]
  return { ...ui, menu: { ...m, range: next } }
}
/** A search menu's query: the rows sort by match as it changes; a blank one ends the match sort. */
export const menuQuery = (view: ViewState, ui: ViewUi, query: string): ViewUi => {
  const m = ui.menu
  const col = menuCol(view, ui)
  if (m === undefined || col === undefined) return ui
  const { [m.path]: _, ...others } = ui.sort ?? {}
  return { ...ui, menu: { ...m, query }, sort: query.trim() === "" ? others : { ...others, [m.path]: { col: col.id, dir: -1, query } } }
}
/** Tick every id (all ticked already: untick them). */
const tickAll = (ui: ViewUi, path: string, ids: ReadonlyArray<string>): ViewUi => {
  const sel = ui.selected[path] ?? []
  const all = ids.length > 0 && ids.every((id) => sel.includes(id))
  return { ...ui, selected: { ...ui.selected, [path]: all ? sel.filter((id) => !ids.includes(id)) : [...sel, ...ids.filter((id) => !sel.includes(id))] } }
}
/** An entry of the open menu (the highlighted one by default): a sort sets it (again: off), a value, a range or the matches tick their rows (all ticked: untick). */
export const applyMenu = (view: ViewState, ui: ViewUi, index?: number): ViewUi => {
  const m = ui.menu
  const e = menuEntries(view, ui)[index ?? m?.pick ?? 0]
  const col = menuCol(view, ui)
  if (m === undefined || e === undefined || col === undefined) return ui
  const at = { ...ui, menu: { ...m, pick: index ?? m.pick } }
  const { [m.path]: _, ...others } = ui.sort ?? {}
  if (e.kind === "sort") return { ...at, sort: e.active ? others : { ...others, [m.path]: { col: col.id, dir: e.dir } } }
  if (e.kind === "match") return (m.query ?? "").trim() === "" ? at : { ...at, sort: e.active ? others : { ...others, [m.path]: { col: col.id, dir: -1, query: m.query! } } }
  if (e.kind === "value") return tickAll(at, m.path, cellsAt(view, m.path).filter((r) => cell(r, col) === e.value).map((r) => r.id))
  if (e.kind === "tick-range" || e.kind === "tick-matches") return tickAll(at, m.path, tickable(view, ui))
  return at
}
/** On a header: ←→ move between its columns; past the first or last column, to the previous or next tab's header. */
export const moveColumn = (view: ViewState, ui: ViewUi, dir: number): ViewUi => {
  const h = ui.header
  if (h === undefined) return ui
  const last = columnsAt(view, h.path).length - 1
  const col = h.col + dir
  const s = focused(view, ui)
  if ((col < 0 || col > last) && s?.kind === "tabs") {
    const at = ui.tabs[s.id] ?? 0
    const to = at + (col < 0 ? -1 : 1)
    const tab = s.tabs[to]
    if (tab === undefined) return ui
    const path = `${s.id}.${tab.id}`
    return { ...closeMenu(ui), tabs: { ...ui.tabs, [s.id]: to }, header: { path, col: col < 0 ? Math.max(0, columnsAt(view, path).length - 1) : 0 } }
  }
  return { ...ui, header: { ...h, col: Math.max(0, Math.min(last, col)) } }
}
/** A click on a tab: its section takes focus and shows it. */
export const pickTab = (view: ViewState, ui: ViewUi, sectionId: string, index: number): ViewUi => {
  const focus = ordered(view.layout).findIndex((s) => s.id === sectionId)
  if (focus < 0) return ui
  const { header: _h, menu: _m, ...rest } = ui
  return { ...rest, focus, tabs: { ...ui.tabs, [sectionId]: index } }
}
/** A click on a column's header: its table takes focus and the column's menu opens. */
export const pickHeader = (view: ViewState, ui: ViewUi, sectionId: string, col: number): ViewUi => {
  const focus = ordered(view.layout).findIndex((s) => s.id === sectionId)
  const c = focus < 0 ? undefined : leafOf(view, { ...ui, focus }, sectionId)
  return c === undefined ? ui : openMenu(view, { ...closeMenu(ui), focus }, c.path, col)
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
  if (row === undefined || readOnlyRow(row)) return ui
  const sel = ui.selected[c.path] ?? []
  return { ...ui, selected: { ...ui.selected, [c.path]: sel.includes(row.id) ? sel.filter((x) => x !== row.id) : [...sel, row.id] } }
}

/** On a toggle table, the flip of the highlighted row (the plugin keeps whether it is on). */
/** A row that only reports now: it neither toggles nor ticks. */
export const readOnlyRow = (row: unknown) => (row as { readonly?: boolean } | undefined)?.readonly === true
export const toggleAct = (view: ViewState, ui: ViewUi): { readonly section: string; readonly action: "toggle"; readonly rows: ReadonlyArray<string> } | undefined => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table" || c.leaf.toggle !== true) return undefined
  const row = shownRows(view, ui, c.path)[ui.rows[c.path] ?? 0]
  return row === undefined || readOnlyRow(row) ? undefined : { section: c.path, action: "toggle", rows: [row.id] }
}

/** For each table with a `highlight` action, that action on its highlighted row: the platform runs it when the row changes. */
export const highlightActs = (view: ViewState, ui: ViewUi): ReadonlyArray<{ readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> }> =>
  ordered(view.layout).flatMap((s) => {
    const c = leafOf(view, ui, s.id)
    const a = c !== undefined && c.leaf.kind === "table" ? (c.leaf.actions ?? []).find((x) => x.highlight === true) : undefined
    const row = a === undefined ? undefined : shownRows(view, ui, c!.path)[ui.rows[c!.path] ?? 0]
    return row === undefined ? [] : [{ section: c!.path, action: a!.id, rows: [row.id] }]
  })

/** A board's cursor and folds (clamped to its lanes and cards when read). */
export const boardUi = (view: ViewState, ui: ViewUi, path: string): BoardUi => {
  const lanes = (view.data[path] as { lanes?: ReadonlyArray<{ id: string; cards: ReadonlyArray<{ id: string }> }> } | undefined)?.lanes ?? []
  const b = ui.board?.[path] ?? { lane: 0, card: 0, folded: [] }
  const lane = Math.max(0, Math.min(lanes.length - 1, b.lane))
  const card = Math.max(0, Math.min((lanes[lane]?.cards.length ?? 1) - 1, b.card))
  return { lane, card, folded: b.folded.filter((id) => lanes.some((l) => l.id === id)) }
}

/**
 * Keys on a focused board: ←→ lanes (a folded one too), ↑↓ cards, z folds or unfolds the lane under the cursor,
 * Z folds every other lane (again: unfolds all), ⏎ opens the card (`act "item"`) or unfolds a folded lane,
 * ⇧←/⇧→ move the card through the plugin (`act "move-left"` / `"move-right"`). Undefined: not a board.
 */
export const boardKey = (view: ViewState, ui: ViewUi, key: { readonly name: string; readonly shift?: boolean }): { readonly ui: ViewUi; readonly act?: { readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> } } | undefined => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "board") return undefined
  const lanes = (view.data[c.path] as { lanes?: ReadonlyArray<{ id: string; cards: ReadonlyArray<{ id: string }> }> } | undefined)?.lanes ?? []
  const b = boardUi(view, ui, c.path)
  const set = (next: BoardUi) => ({ ui: { ...ui, board: { ...ui.board, [c.path]: next } } })
  const lane = lanes[b.lane]
  if (lane === undefined) return { ui }
  const folded = b.folded.includes(lane.id)
  const card = folded ? undefined : lane.cards[b.card]
  const act = (action: string) => (card === undefined ? { ui } : { ui, act: { section: c.path, action, rows: [card.id] } })
  if (key.shift === true && key.name === "right") return act("move-right")
  if (key.shift === true && key.name === "left") return act("move-left")
  if (key.name === "right" || key.name === "left") {
    const to = Math.max(0, Math.min(lanes.length - 1, b.lane + (key.name === "right" ? 1 : -1)))
    return set({ ...b, lane: to, card: Math.max(0, Math.min((lanes[to]?.cards.length ?? 1) - 1, b.card)) })
  }
  if ((key.name === "down" || key.name === "up") && !folded) return set({ ...b, card: Math.max(0, Math.min(lane.cards.length - 1, b.card + (key.name === "down" ? 1 : -1))) })
  if (key.name === "Z" || (key.name === "z" && key.shift === true)) {
    const others = lanes.filter((l) => l.id !== lane.id).map((l) => l.id)
    return set({ ...b, folded: others.every((id) => b.folded.includes(id)) ? [] : others })
  }
  if (key.name === "z") return set({ ...b, folded: folded ? b.folded.filter((id) => id !== lane.id) : [...b.folded, lane.id] })
  if (key.name === "return") return folded ? set({ ...b, folded: b.folded.filter((id) => id !== lane.id) }) : act("item")
  return undefined
}

/** A table's actions it offers now: those its data names (`actions`), else all. */
export const enabledActions = (view: ViewState, path: string): ReadonlyArray<typeof ActionSchema.Type> => {
  const leaf = leafAt(view.layout, path)
  const all = leaf !== undefined && leaf.kind === "table" ? (leaf.actions ?? []) : []
  const on = (view.data[path] as { actions?: ReadonlyArray<string> } | undefined)?.actions
  return on === undefined ? all : all.filter((a) => on.includes(a.id))
}
type Act = { readonly section: string | undefined; readonly action: string; readonly rows: ReadonlyArray<string>; readonly text?: string }
/** Pressing an action (its key or its button): one that asks for text opens its input (from the first row's `text`), the rest act. */
export const pressAction = (view: ViewState, ui: ViewUi, section: string, action: string, rows: ReadonlyArray<string>): { readonly ui: ViewUi; readonly act?: Act } => {
  const a = enabledActions(view, section).find((x) => x.id === action)
  if (a?.input === undefined) return { ui, act: { section, action, rows } }
  const row = (view.data[section] as { rows?: ReadonlyArray<{ id: string; text?: string }> } | undefined)?.rows?.find((r) => r.id === rows[0])
  return { ui: { ...ui, input: { section, action, rows, text: row?.text ?? "", placeholder: a.input } } }
}
/** A key while an input is open: typing edits it, Enter acts with the text, Esc closes it; undefined when none is open. */
export const inputKey = (ui: ViewUi, key: { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean }): { readonly ui: ViewUi; readonly act?: Act } | undefined => {
  if (ui.input === undefined) return undefined
  const { input: i, ...off } = ui
  if (key.name === "escape") return { ui: off }
  if (key.name === "return") return { ui: off, act: { section: i.section, action: i.action, rows: i.rows, text: i.text } }
  if (printable({ name: key.name, ...(key.ctrl !== undefined ? { ctrl: key.ctrl } : {}), ...(key.meta !== undefined ? { meta: key.meta } : {}) }))
    return { ui: { ...ui, input: { ...i, text: key.name === "backspace" ? i.text.slice(0, -1) : `${i.text}${key.name === "space" ? " " : key.name}` } } }
  return { ui }
}

/** The action a key triggers on a platform: the focused table's, else the view's own; undefined when none. */
export const actionFor = (view: ViewState, ui: ViewUi, key: string, platform = "terminal"): { readonly section: string | undefined; readonly action: string; readonly rows: ReadonlyArray<string> } | undefined => {
  const c = current(view, ui)
  const a = c !== undefined && c.leaf.kind === "table" ? enabledActions(view, c.path).find((x) => keyFor(x, platform) === key || (key === "return" && x.default === true)) : undefined
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

/** A click or tap on a row: its section takes focus and the cursor moves there (its mark ticks it: `pickMark`). */
export const pickRow = (view: ViewState, ui: ViewUi, sectionId: string, index: number): ViewUi => {
  const focus = ordered(view.layout).findIndex((s) => s.id === sectionId)
  if (focus < 0) return ui
  const at = { ...ui, focus }
  const c = leafOf(view, at, sectionId)
  if (c === undefined) return at
  const { header: _h, menu: _m, ...off } = at
  return { ...off, rows: { ...at.rows, [c.path]: index } }
}
/** A click or tap on a row's mark: the cursor moves there and a selectable row toggles. */
export const pickMark = (view: ViewState, ui: ViewUi, sectionId: string, index: number): ViewUi => {
  const moved = pickRow(view, ui, sectionId, index)
  const c = leafOf(view, moved, sectionId)
  return c !== undefined && c.leaf.kind === "table" && c.leaf.selectable === true ? toggleSelect(view, moved) : moved
}

/** The row under a focused table's cursor (not on its header), for a platform's row card. */
export const cursorRow = (view: ViewState, ui: ViewUi) => {
  const c = current(view, ui)
  if (c === undefined || c.leaf.kind !== "table" || ui.header?.path === c.path) return undefined
  const row = shownRows(view, ui, c.path)[ui.rows[c.path] ?? 0] as Cells & { readonly tone?: string } | undefined
  return row === undefined ? undefined : { path: c.path, leaf: c.leaf, row, selected: (ui.selected[c.path] ?? []).includes(row.id) }
}

/** After an action ran: that table's selection clears. */
export const afterAction = (ui: ViewUi, section: string | undefined): ViewUi => (section === undefined ? ui : { ...ui, selected: { ...ui.selected, [section]: [] } })

/** A text section's words: for one that follows a table, the text for that table's highlighted row (else its own). */
export const followedText = (view: ViewState, ui: ViewUi, path: string): string => {
  const d = view.data[path] as { readonly markdown?: string; readonly rows?: Readonly<Record<string, string>> } | undefined
  const leaf = leafAt(view.layout, path)
  const table = leaf?.follows === undefined ? undefined : leafOf(view, ui, leaf.follows)
  const row = table === undefined ? undefined : shownRows(view, ui, table.path)[ui.rows[table.path] ?? 0]
  return (row !== undefined ? d?.rows?.[row.id] : undefined) ?? d?.markdown ?? ""
}

/** A table's search: the query (a blank one ends it); the cursor goes to the best match. */
export const setSearch = (_view: ViewState, ui: ViewUi, path: string, query: string): ViewUi => {
  const { [path]: _, ...others } = ui.search ?? {}
  return { ...ui, search: query.trim() === "" ? others : { ...others, [path]: query }, rows: { ...ui.rows, [path]: 0 } }
}
/** How many rows a search shows, of all. */
export const searchCount = (view: ViewState, ui: ViewUi, path: string) => ({ shown: shownRows(view, ui, path).length, all: rowsOf(view, path).length })
