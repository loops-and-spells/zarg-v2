import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { CHAT, type ConversationQuestion, conversationRows, cursorRow, enabledActions, pickCard, readOnlyRow, viewActions, filterOf, followedText, keyFor, searchCount, leafOf, menuEntries, shownRows, OTHER, ordered, rowsOf, type LayoutLeaf, type LayoutSection, type SectionKind, type ViewState, type ViewUi } from "@zarg/view"
import { fit, gauge, heading } from "./look"
import { Board } from "./board"
import { RichText } from "./markdown"
import { useColors, useToneFg } from "./theme"
import { spin } from "./view"

/** The shell's clock for animations (a busy row's spinner); it ticks while agents work. */
export const NowContext = createContext(0)

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const STATE_MARK = { busy: "⠼", waiting: "◌", done: "✓", flagged: "⚑" } as const

interface LeafProps { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly leaf: LayoutLeaf; readonly focused: boolean; readonly width: number; readonly onHeight?: (height: number) => void; readonly onPick?: (index: number) => void; readonly onMark?: (index: number) => void; readonly onToggle?: (index: number) => void; readonly onHeader?: (col: number) => void; readonly onSearch?: () => void }
type Leaf = (p: LeafProps) => ReactNode

/** A section's heading: its title (or its tabs, the current one marked), then a faint rule. */
export const Heading = (p: { readonly title: string; readonly width: number; readonly focused: boolean; readonly tabs?: ReadonlyArray<{ readonly label: string; readonly current: boolean; readonly empty?: boolean }>; readonly onTab?: (index: number) => void }) => {
  const C = useColors()
  const colour = p.focused ? C.accent : C.dim
  if (p.tabs === undefined) {
    const h = heading(p.title, p.width)
    return (
      <text wrapMode="none">
        <span fg={colour}>
          <b>{h.title}</b>
        </span>
        <span fg={C.faint}>{h.rule}</span>
      </text>
    )
  }
  // Tabs: each a click away; the current one bold and underlined (▔ on the row under it), an empty one faint.
  const tabs = p.tabs
  const label = tabs.map((t) => t.label).join("   ")
  const h = heading(label, p.width)
  const under = tabs.map((t) => (t.current ? "▔" : " ").repeat(t.label.length)).join("   ")
  return (
    <box style={{ flexDirection: "column", height: 2 }}>
      <box style={{ flexDirection: "row", height: 1 }}>
        {tabs.map((t, i) => [
          i > 0 ? <text key={`gap${i}`}>{"   "}</text> : null,
          <text key={i} wrapMode="none" onMouseDown={() => p.onTab?.(i)} fg={t.current ? (p.focused ? C.accent : C.text) : t.empty === true ? C.faint : C.dim}>
            {t.current ? <b>{t.label}</b> : t.label}
          </text>,
        ])}
        <text wrapMode="none" fg={C.faint}>{h.rule}</text>
      </box>
      <text wrapMode="none" fg={colour}>{under}</text>
    </box>
  )
}

const Stats: Leaf = ({ view, path, width }) => {
  const C = useColors()
  const fg = useToneFg()
  const d = view.data[path] as { items?: ReadonlyArray<{ label: string; value: string; tone?: string }>; progress?: { done: number; total: number } } | undefined
  const g = d?.progress !== undefined ? gauge(d.progress.done, d.progress.total, 24) : undefined
  return (
    <text wrapMode="none">
      {g !== undefined ? <span fg={C.accent}>{g.done}</span> : null}
      {g !== undefined ? <span fg={C.faint}>{`${g.rest}  `}</span> : null}
      {(d?.items ?? []).map((i, n) => (
        <span key={n}>
          <span fg={i.tone !== undefined ? fg(i.tone) : C.text}>{`${n > 0 ? "   " : ""}${fit(i.value, width)}`}</span>
          <span fg={C.dim}>{` ${i.label}`}</span>
        </span>
      ))}
    </text>
  )
}
/** The gutter: the cursor's ▍ and, in a selectable table, ○ or ●. */
const Gutter = (p: { readonly cursor: boolean; readonly selectable: boolean; readonly selected: boolean; readonly toggle?: boolean; readonly readonly?: boolean }) => {
  const C = useColors()
  return (
    <>
      <span fg={C.accent}>{p.cursor ? "▍" : " "}</span>
      {p.readonly === true ? <span>{p.toggle === true ? "    " : p.selectable ? "  " : " "}</span> : p.toggle === true ? <span fg={p.selected ? C.ok : C.faint}>{p.selected ? "[●] " : "[ ] "}</span> : p.selectable ? <span fg={p.selected ? C.accent : C.dim}>{p.selected ? "● " : "○ "}</span> : <span> </span>}
    </>
  )
}
const List: Leaf = ({ view, ui, path, focused, width }) => {
  const C = useColors()
  const fg = useToneFg()
  const items = (view.data[path] as { items?: ReadonlyArray<{ id: string; text: string; detail?: string; state?: keyof typeof STATE_MARK; tone?: string }> } | undefined)?.items ?? []
  const row = ui.rows[path] ?? 0
  return (
    <>
      {items.length === 0 ? <text fg={C.dim}> nothing yet</text> : null}
      {items.map((it, i) => {
        const cursor = focused && i === row
        const tone = it.state === "waiting" || it.state === "done" ? C.dim : it.state === "flagged" ? C.attention : fg(it.tone)
        const text = fit(it.text, Math.max(8, width - 6 - (it.detail?.length ?? 0)))
        return (
          <text key={it.id} wrapMode="none" {...(cursor ? { bg: C.selection } : {})}>
            <Gutter cursor={cursor} selectable={false} selected={false} />
            <span fg={tone}>{`${it.state !== undefined ? STATE_MARK[it.state] : " "} ${text}`}</span>
            {it.detail !== undefined ? <span fg={C.dim}>{`  ${it.detail}`}</span> : null}
          </text>
        )
      })}
    </>
  )
}
const Log: Leaf = ({ view, path, width }) => {
  const fg = useToneFg()
  return (
    <>
      {((view.data[path] as { lines?: ReadonlyArray<{ text: string; tone?: string }> } | undefined)?.lines ?? []).map((l, i) => (
        <text key={i} fg={fg(l.tone)} wrapMode="none">{fit(l.text, width)}</text>
      ))}
    </>
  )
}
type TableRow = { id: string; cells: Record<string, string>; tone?: string }
type RefLabel = { readonly text: string; readonly tone: string; readonly glyph: string }
/** What a cell shows: a ref column's label (glyph and text) when the core resolved one, else the value. */
const cellText = (v: string, ref: boolean, labels: Readonly<Record<string, RefLabel>> | undefined) => {
  const l = ref ? labels?.[v] : undefined
  return l === undefined ? v : `${l.glyph} ${l.text}`
}
const labelsOf = (view: ViewState, path: string) => (view.data[path] as { labels?: Readonly<Record<string, RefLabel>> } | undefined)?.labels
/** A table's column widths and where each starts (after the gutter): as wide as their widest cell or label with its sort mark (at most 24); the last one takes what is left. */
const tableLayout = (view: ViewState, path: string, leaf: LayoutLeaf, width: number) => {
  const cols = leaf.columns ?? []
  const rows = ((view.data[path] as { rows?: ReadonlyArray<TableRow> } | undefined)?.rows ?? [])
  const gutter = leaf.toggle === true ? 5 : leaf.selectable === true ? 3 : 2
  const labels = labelsOf(view, path)
  const fixedWidths = cols.map((c, ci) => (ci === cols.length - 1 ? 0 : Math.min(24, Math.max(c.label.length + 2, ...rows.map((r) => cellText(r.cells[c.id] ?? "", c.ref === true, labels).replace(/\s*\n\s*/g, " ").length)))))
  const fixed = fixedWidths.reduce((a, w) => a + w + 2, 0)
  const widths = fixedWidths.map((w) => (w === 0 ? Math.max(4, width - gutter - fixed) : w))
  const starts = widths.map((_, i) => gutter + widths.slice(0, i).reduce((a, w) => a + w + 2, 0))
  return { cols, rows, gutter, widths, starts }
}
/** An action's choices, dropped down under its button: the picked one highlighted; a click picks. */
const Choices = (p: { readonly choose: NonNullable<ViewUi["choose"]>; readonly onPick?: (index: number) => void }) => {
  const C = useColors()
  const w = Math.max(...p.choose.choices.map((c) => c.label.length)) + 4
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, border: true, borderStyle: "rounded", borderColor: C.accent, backgroundColor: C.raised, width: w + 2, marginTop: 1 }}>
      {p.choose.choices.map((c, i) => (
        <text key={c.id} wrapMode="none" {...(i === p.choose.pick ? { bg: C.selection } : {})} {...(p.onPick !== undefined ? { onMouseDown: () => p.onPick!(i) } : {})}>
          <span fg={C.accent}>{i === p.choose.pick ? "▍ " : "  "}</span>
          <span fg={C.text}>{c.label.padEnd(w - 2)}</span>
        </text>
      ))}
    </box>
  )
}
/** An action's line of text, while it is typed: ⏎ sends it, esc drops it. */
const InputField = (p: { readonly input: NonNullable<ViewUi["input"]>; readonly width: number }) => {
  const C = useColors()
  const hint = "  ⏎ save  esc cancel"
  const room = Math.max(1, p.width - 4 - hint.length)
  const shown = p.input.text.length > 0 ? p.input.text.slice(-room) : ""
  return (
    <text wrapMode="none" bg={C.selection} style={{ flexShrink: 0, marginTop: 1 }}>
      <span fg={C.accent}>{" ✎ "}</span>
      {shown.length > 0 ? <span fg={C.text}>{shown}</span> : <span fg={C.dim}>{fit(p.input.placeholder, room)}</span>}
      <span fg={C.accent}>▎</span>
      <span fg={C.dim}>{hint}</span>
    </text>
  )
}
/** A searchable table's field: idle, or its query (with the cursor while typing) and how many rows it keeps. */
const SearchField = (p: { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly width: number; readonly onSearch?: () => void }) => {
  const C = useColors()
  const q = p.ui.search?.[p.path]
  const typing = p.ui.searching === p.path
  const n = searchCount(p.view, p.ui, p.path)
  const right = q !== undefined ? `${n.shown} of ${n.all}${typing ? "   esc" : ""}` : "f"
  const left = q !== undefined || typing ? `${q ?? ""}${typing ? "▎" : ""}` : "search"
  return (
    <text wrapMode="none" onMouseDown={() => p.onSearch?.()} bg={typing ? C.selection : C.raised}>
      <span fg={typing ? C.accent : C.dim}>{" ⌕ "}</span>
      <span fg={q !== undefined || typing ? C.text : C.faint}>{fit(left, Math.max(1, p.width - 6 - right.length))}</span>
      <span>{" ".repeat(Math.max(1, p.width - 4 - fit(left, Math.max(1, p.width - 6 - right.length)).length - right.length))}</span>
      <span fg={C.dim}>{right}</span>
    </text>
  )
}
const Table: Leaf = ({ view, ui, path, leaf, focused, width, onPick, onMark, onToggle, onHeader, onSearch }) => {
  const now = useContext(NowContext)
  const C = useColors()
  const fg = useToneFg()
  const { cols, gutter, widths } = tableLayout(view, path, leaf, width)
  const labels = labelsOf(view, path)
  const rows = shownRows(view, ui, path) as ReadonlyArray<TableRow>
  const selectable = leaf.selectable === true
  const cells = (get: (c: { id: string; label: string }) => string) => cols.map((c, ci) => pad(fit(get(c), widths[ci]!), widths[ci]!)).join("  ")
  const cursor = ui.rows[path] ?? 0
  const sel = ui.selected[path] ?? []
  const sort = ui.sort?.[path]
  const onHead = focused && ui.header?.path === path ? ui.header.col : undefined
  if (rows.length === 0) return <text fg={C.dim}>{ui.search?.[path] !== undefined ? " nothing matches" : " nothing yet"}</text>
  return (
    <>
      {/* The header: each column's label, its sort mark, the header cursor; a click opens its menu. */}
      <box style={{ flexDirection: "row", height: 1 }}>
        <text wrapMode="none">{" ".repeat(gutter)}</text>
        {cols.map((c, ci) => {
          const mark = sort?.col === c.id ? (sort.query !== undefined ? " ⌕" : sort.dir === 1 ? " ▲" : " ▼") : ""
          const here = onHead === ci
          return [
            <text key={c.id} wrapMode="none" onMouseDown={() => onHeader?.(ci)} {...(here ? { bg: C.accent } : {})} fg={here ? C.bg : mark !== "" ? C.accent : C.dim}>
              {pad(fit(`${c.label}${mark}`, widths[ci]!), widths[ci]!)}
            </text>,
            ci < cols.length - 1 ? <text key={`${c.id} gap`}>{"  "}</text> : null,
          ]
        })}
      </box>
      {rows.map((r, i) => {
        const on = focused && i === cursor
        const picked = sel.includes(r.id)
        return (
          // A click on the row moves the cursor there; a click on its mark ticks it.
          <box key={r.id} id={`row-${path}-${i}`} style={{ flexDirection: "row", height: 1, ...(on ? { backgroundColor: C.selection } : {}) }}>
            {/* A read-only row only reports: no mark, and its gutter picks the row rather than flipping it. */}
            <text wrapMode="none" onMouseDown={() => (readOnlyRow(r) ? onPick : leaf.toggle === true ? onToggle : selectable ? onMark : onPick)?.(i)}>
              <Gutter cursor={on} selectable={selectable} selected={leaf.toggle === true ? (r as { on?: boolean }).on === true : picked} toggle={leaf.toggle === true} readonly={readOnlyRow(r)} />
            </text>
            {/* Each cell in its colour: the row's tone, else its column's (by value, then the column's own). */}
            <text wrapMode="none" onMouseDown={() => onPick?.(i)}>
              {cols.map((c, ci) => {
                const v = r.cells[c.id] ?? ""
                const col = c as { readonly tone?: string; readonly tones?: Readonly<Record<string, string>>; readonly ref?: true }
                // A ref cell draws its label in the label's tone (the entity's kind), unless the row has its own.
                const label = col.ref === true ? labels?.[v] : undefined
                return (
                  <span key={c.id} fg={leaf.toggle === true && (r as { on?: boolean }).on !== true ? C.faint : fg(r.tone ?? label?.tone ?? col.tones?.[v] ?? col.tone)}>
                    {/* A busy row's first cell spins with the shell's clock (its colour stays its value's). */}
                    {`${pad(fit(ci === 0 && (r as { busy?: boolean }).busy === true ? spin(now) : cellText(v, col.ref === true, labels), widths[ci]!), widths[ci]!)}${ci < cols.length - 1 ? "  " : ""}`}
                  </span>
                )
              })}
            </text>
          </box>
        )
      })}
    </>
  )
}
const KeyValue: Leaf = ({ view, path, width }) => {
  const C = useColors()
  return (
    <>
      {((view.data[path] as { pairs?: ReadonlyArray<{ key: string; value: string }> } | undefined)?.pairs ?? []).map((p) => (
        <text key={p.key} wrapMode="none">
          <span fg={C.dim}>{pad(p.key, 14)}</span>
          <span fg={C.text}>{` ${fit(p.value, Math.max(4, width - 15))}`}</span>
        </text>
      ))}
    </>
  )
}
// @scenario S-0076
// A text that follows a table shows the text for its highlighted row.
const Text: Leaf = ({ view, ui, path, width, onHeight }) => {
  const loading = (view.data[path] as { loading?: string } | undefined)?.loading
  const now = useContext(NowContext)
  const C = useColors()
  // Still being worked out: the line, with a spinner, in the middle of the section.
  if (loading !== undefined)
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center", minHeight: 5 }}>
        <text wrapMode="none"><span fg={C.accent}>{`${spin(now)} `}</span><span fg={C.dim}>{loading}</span></text>
      </box>
    )
  return <RichText content={followedText(view, ui, path)} width={width} {...(onHeight !== undefined ? { onHeight } : {})} />
}

// A plugin agent's conversation: its messages, then its question with the options (arrows and Enter answer it).
const Conversation: Leaf = ({ view, ui, path, width, onHeight }) => {
  const C = useColors()
  const d = view.data[path] as { messages?: ReadonlyArray<{ id: string; role: string; text: string }>; question?: ConversationQuestion; status?: string } | undefined
  const q = d?.question
  return (
    <box flexDirection="column" flexShrink={0} onSizeChange={function () { onHeight?.(this.height) }}>
      {(d?.messages ?? []).map((m, i) => (
        <box key={m.id} flexDirection="row" flexShrink={0}>
          <text width={6} fg={m.role === "user" ? C.dim : C.accent}>{m.role === "user" ? "you   " : "agent "}</text>
          {m.role === "user" ? <text fg={C.text} width={Math.max(1, width - 6)}>{m.text}</text> : <RichText content={m.text} width={width - 6} streaming={d?.status === "working" && i === (d.messages?.length ?? 0) - 1} />}
        </box>
      ))}
      {q === undefined ? null : (
        <text fg={C.attention}>
          <b>{q.question}</b>
        </text>
      )}
      {q === undefined
        ? null
        : conversationRows(q, { pick: ui.rows[path] ?? 0, other: false })
            .filter((r) => r.id !== OTHER && r.id !== CHAT)
            .map((r) => (
              <text key={r.id} wrapMode="none">
                <span fg={C.accent}>{r.selected ? "› " : "  "}</span>
                <span fg={C.text}>{r.label}</span>
                {r.recommended ? <span fg={C.dim}>{"   recommended"}</span> : null}
              </text>
            ))}
    </box>
  )
}

/** How the terminal draws each leaf kind; tabs draw their current leaf. Every kind must be here. */
const BoardLeaf: Leaf = ({ view, ui, path, focused, width }) => <Board view={view} ui={ui} path={path} focused={focused} width={width} />
export const renderers: Record<Exclude<SectionKind, "tabs">, Leaf> = { stats: Stats, list: List, log: Log, table: Table, keyvalue: KeyValue, text: Text, conversation: Conversation, board: BoardLeaf }

const count = (view: ViewState, path: string) => rowsOf(view, path).length
/** A tabs section's tabs for its heading: each with its row count, the current one marked. */
const tabsOf = (view: ViewState, ui: ViewUi, s: LayoutSection) =>
  s.kind === "tabs" ? s.tabs.map((t, i) => ({ label: `${t.title ?? t.id} ${count(view, `${s.id}.${t.id}`)}`, current: i === (ui.tabs[s.id] ?? 0), empty: count(view, `${s.id}.${t.id}`) === 0 })) : undefined

/** A section's heading rows: tabs take two (labels and underline), an untitled one (title "") none, the rest one. */
const headRowsOfSection = (s: LayoutSection) => (s.kind === "tabs" ? 2 : s.title === "" ? 0 : 1)
/** How tall a section would like to be: its content plus its frame (text counts its lines). */
const wantedOf = (view: ViewState, ui: ViewUi, s: LayoutSection, width: number, measured?: number): number => {
  const leaf = leafOf(view, ui, s.id)
  if (leaf === undefined) return 3
  const k = leaf.leaf.kind
  if ((k === "text" || k === "conversation") && measured !== undefined) return Math.max(1, measured) + headRowsOfSection(s)
  const content =
    k === "stats" ? 1
    // Prose wraps: each paragraph line takes as many rows as its length needs.
    // A text still loading takes all the room it may have: its line sits in the middle of it.
    : k === "text" && (view.data[leaf.path] as { loading?: string } | undefined)?.loading !== undefined ? 999
    : k === "text" ? ((view.data[leaf.path] as { markdown?: string } | undefined)?.markdown ?? "").split("\n").reduce((a, l) => a + Math.max(1, Math.ceil(l.length / Math.max(1, width))), 0)
    : k === "keyvalue" ? ((view.data[leaf.path] as { pairs?: ReadonlyArray<unknown> } | undefined)?.pairs ?? []).length
    : k === "log" ? ((view.data[leaf.path] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []).length
    : rowsOf(view, leaf.path).length + (k === "table" ? 1 + (leaf.leaf.search === true ? 1 : 0) : 0)
  // Its content and its heading (tabs take a second line, their underline).
  return Math.max(1, content) + headRowsOfSection(s)
}
type ButtonSpec = { readonly id: string; readonly label: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>> }
/** A selection's actions as buttons: the first filled with the accent (with the count), the rest quiet; each shows its key and runs on a click. */
export const Buttons = (p: { readonly actions: ReadonlyArray<ButtonSpec>; readonly count: number; readonly onPress: (id: string) => void; readonly onClear?: () => void }) => {
  const C = useColors()
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      {p.actions.map((a, i) => {
        const fill = i === 0 ? C.accent : C.line
        const key = keyFor(a, "terminal")
        return (
          <text key={a.id} wrapMode="none" onMouseDown={() => p.onPress(a.id)} style={{ marginRight: 2 }}>
            <span fg={fill}>▐</span>
            <span fg={i === 0 ? C.bg : C.text} bg={fill}>{i === 0 && p.count > 0 ? ` ${a.label} · ${p.count} ` : ` ${a.label} `}</span>
            {key !== undefined ? <span fg={i === 0 ? C.raised : C.dim} bg={fill}>{` ${key} `}</span> : null}
            <span fg={fill}>▌</span>
          </text>
        )
      })}
      {p.onClear !== undefined ? (
        <text wrapMode="none" onMouseDown={p.onClear}>
          <span fg={C.dim}>{" Clear "}</span>
        </text>
      ) : null}
    </box>
  )
}
/**
 * A table's buttons: all its actions, always there (the status line carries no view keys). The ticked rows it still
 * shows are counted; an action takes them, or the highlighted row when none are ticked (a row action: always it).
 */
const buttonsOf = (view: ViewState, ui: ViewUi, leaf: { readonly path: string; readonly leaf: LayoutLeaf }) => {
  // A highlight action runs as the cursor moves: it needs no button.
  const actions = leaf.leaf.kind === "table" ? enabledActions(view, leaf.path).filter((a) => a.highlight !== true) : []
  if (leaf.leaf.kind !== "table" || actions.length === 0) return undefined
  const all = rowsOf(view, leaf.path)
  const rows = (ui.selected[leaf.path] ?? []).filter((id) => all.some((r) => r.id === id))
  const here = shownRows(view, ui, leaf.path)[ui.rows[leaf.path] ?? 0]?.id
  const rowsFor = (id: string): ReadonlyArray<string> | undefined => {
    const a = actions.find((x) => x.id === id)
    if (a === undefined) return undefined
    if (a.on === "none") return []
    const picked = a.on === "selection" && rows.length > 0 ? rows : here !== undefined ? [here] : []
    return picked.length > 0 ? picked : undefined
  }
  return { rows, actions, rowsFor }
}

/** How tall a row card would be: its line, then each cut column's label and wrapped text; at most `cap`. */
const cardHeight = (card: NonNullable<ReturnType<typeof cursorRow>>, view: ViewState, width: number, cap: number) => {
  const { cols, widths } = tableLayout(view, card.path, card.leaf, width)
  const lines = cols.reduce((a, c, i) => {
    const v = cellText(card.row.cells?.[c.id] ?? "", c.ref === true, labelsOf(view, card.path))
    return i > 0 && v.replace(/\s*\n\s*/g, " ").length > widths[i]! ? a + 1 + v.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(1, width - 4))), 0) : a
  }, 1)
  return Math.max(1, Math.min(cap, lines))
}
/** The row under a table's cursor, in full: its mark and first column, the short columns on one dim line, then each column its cell cuts, wrapped under its label. */
const RowCard = (p: { readonly card: NonNullable<ReturnType<typeof cursorRow>>; readonly view: ViewState; readonly width: number; readonly height: number }) => {
  const C = useColors()
  const fg = useToneFg()
  const { cols, widths } = tableLayout(p.view, p.card.path, p.card.leaf, p.width)
  const labels = labelsOf(p.view, p.card.path)
  const cell = (i: number) => cellText(p.card.row.cells?.[cols[i]!.id] ?? "", cols[i]!.ref === true, labels)
  const text = (i: number) => cell(i).replace(/\s*\n\s*/g, " ")
  const long = cols.flatMap((c, i) => (i > 0 && text(i).length > widths[i]! ? [{ label: c.label, value: cell(i) }] : []))
  const short = cols.flatMap((c, i) => (i > 0 && text(i) !== "" && text(i).length <= widths[i]! ? [`${c.label} ${text(i)}`] : []))
  return (
    // A shaded panel with an accent bar, so it never reads as another row; as tall as the row needs (`cardHeight`), a blank row above it; past its cap it scrolls.
    <box style={{ flexShrink: 0, height: p.height, marginTop: 1, marginBottom: 1, border: ["left"], borderStyle: "heavy", borderColor: C.accent, backgroundColor: C.shade, paddingLeft: 1, paddingRight: 1 }}>
      <scrollbox focusable={false} style={{ flexGrow: 1 }}>
        <text wrapMode="none">
          <span fg={p.card.row.tone !== undefined ? fg(p.card.row.tone) : C.accent}>
            <b>{cols.length > 0 ? text(0) : p.card.row.id}</b>
          </span>
          {p.card.selected ? <span fg={C.accent}>{"  ● ticked"}</span> : null}
          <span fg={C.dim}>{fit(`  ${short.join(" · ")}`, Math.max(0, p.width - 6 - (cols.length > 0 ? text(0) : p.card.row.id).length - (p.card.selected ? 10 : 0)))}</span>
        </text>
        {long.map((l) => (
          <box key={l.label} style={{ flexDirection: "column", flexShrink: 0 }}>
            <text fg={C.dim}>{l.label}</text>
            <text fg={C.text}>{l.value}</text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
}

/** The most entries a column menu shows before it scrolls. */
const MENU_ROWS = 8
/** A column's menu, dropped down under its header: its entries (at most `room`, scrolled to the highlighted one; ▴▾ when more), each a click away. */
const ColumnMenu = (p: { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly leaf: LayoutLeaf; readonly width: number; readonly room: number; readonly top: number; readonly onPick?: (index: number) => void; readonly onAdjust?: (index: number, dir: number) => void }) => {
  const C = useColors()
  const m = p.ui.menu!
  const { cols, starts } = tableLayout(p.view, p.path, p.leaf, p.width)
  const col = cols[m.col]
  if (col === undefined) return null
  const entries = menuEntries(p.view, p.ui)
  const first = col.order?.[0]
  const last = col.order?.at(-1)
  // Bounds in one width, so ◂ and ▸ stay put as they change.
  const f = filterOf(p.view, p.path, m.col)
  const whole = typeof f === "object" && [f.range[0], f.range[1], f.step ?? 1].every(Number.isInteger)
  const num = (n: number) => (whole ? String(n) : n.toFixed(2)).padStart(typeof f === "object" ? Math.max(...f.range.map((b) => (whole ? String(b) : b.toFixed(2)).length)) : 0)
  const lines = entries.map((e) => {
    switch (e.kind) {
      case "sort":
        return { mark: e.active ? "✓ " : "  ", text: e.dir === 1 ? `▲ ${first !== undefined ? `${first} first` : "ascending"}` : `▼ ${last !== undefined ? `${last} first` : "descending"}`, count: "" }
      case "value":
        return { mark: e.selected === 0 ? "○ " : e.selected === e.total ? "● " : "◐ ", text: e.value === "" ? "(empty)" : e.value, count: `${e.selected}/${e.total}` }
      case "from":
      case "to":
        return { mark: "  ", text: `${e.kind === "from" ? "from" : "to  "}  ◂ ${num(e.value)} ▸`, count: "" }
      case "tick-range":
      case "tick-matches":
        return { mark: e.count > 0 && e.selected === e.count ? "● " : e.selected > 0 ? "◐ " : "○ ", text: e.kind === "tick-range" ? "tick those in range" : "tick the matches", count: `${e.selected}/${e.count}` }
      case "query":
        return { mark: "⌕ ", text: e.text === "" ? "type to search" : `${e.text}▎`, count: "", dim: e.text === "" }
      case "match":
        return { mark: e.active ? "✓ " : "  ", text: "sort by match", count: "" }
    }
  })
  const inner = Math.min(p.width - 4, Math.max(col.label.length + 4, 18, ...lines.map((l) => l.mark.length + l.text.length + l.count.length + 3)))
  const shown = Math.max(1, Math.min(entries.length, MENU_ROWS, p.room - 2))
  const start = Math.max(0, Math.min(entries.length - shown, m.pick - Math.floor(shown / 2)))
  const left = Math.max(0, Math.min(p.width - inner - 4, starts[m.col]! - 2))
  const more = { up: start > 0, down: start + shown < entries.length }
  return (
    <box
      zIndex={10}
      style={{ position: "absolute", left, top: p.top, width: inner + 4, height: shown + 2, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, backgroundColor: C.raised, paddingLeft: 1, paddingRight: 1 }}
      title={` ${col.label} ${more.up ? "▴" : ""}`}
      {...(more.down ? { bottomTitle: " ▾ " } : {})}
    >
      {lines.slice(start, start + shown).map((l, k) => {
        const i = start + k
        const on = i === m.pick
        const e = entries[i]!
        const room = Math.max(1, inner - 1 - l.mark.length - l.count.length)
        if (e.kind === "from" || e.kind === "to")
          return (
            <box key={i} style={{ flexDirection: "row", height: 1, ...(on ? { backgroundColor: C.selection } : {}) }}>
              <text wrapMode="none" fg={C.accent}>{on ? "▍" : " "}</text>
              <text wrapMode="none" fg={C.dim}>{`  ${e.kind === "from" ? "from" : "to  "}  `}</text>
              <text wrapMode="none" fg={C.accent} onMouseDown={() => p.onAdjust?.(i, -1)}>{"◂"}</text>
              <text wrapMode="none" fg={C.text}>{` ${num(e.value)} `}</text>
              <text wrapMode="none" fg={C.accent} onMouseDown={() => p.onAdjust?.(i, 1)}>{"▸"}</text>
            </box>
          )
        return (
          <text key={i} wrapMode="none" onMouseDown={() => p.onPick?.(i)} {...(on ? { bg: C.selection } : {})}>
            <span fg={C.accent}>{on ? "▍" : " "}</span>
            <span fg={l.mark === "○ " || l.mark === "  " ? C.dim : C.accent}>{l.mark}</span>
            <span fg={"dim" in l && l.dim === true ? C.dim : C.text}>{fit(l.text, room).padEnd(room)}</span>
            <span fg={C.dim}>{l.count}</span>
          </text>
        )
      })}
    </box>
  )
}

/** The largest share of the view each role may take; the log takes what is left. */
const SHARE = { primary: "33%", pinned: "40%", aside: "25%" } as const

/** Scrolls the focused section by lines (the shell calls it for keys in a log or text). */
export type Scroller = (delta: number) => void

/** An agent's view in the terminal: its sections stacked by role, each a heading over its own scrollbox. */
export const AgentView = (props: { readonly view: ViewState; readonly ui: ViewUi; readonly height: number; readonly width?: number; readonly scroller?: { current?: Scroller | undefined }; readonly onPick?: (sectionId: string, index: number) => void; readonly onAct?: (section: string | undefined, action: string, rows: ReadonlyArray<string>) => void; readonly onClear?: (section: string) => void; readonly onHeader?: (sectionId: string, col: number) => void; readonly onMenuPick?: (index: number) => void; readonly onMark?: (sectionId: string, index: number) => void; readonly onMenuAdjust?: (index: number, dir: number) => void; readonly onTab?: (sectionId: string, index: number) => void; readonly onSearch?: (sectionId: string, path: string) => void; readonly onBoardPick?: (path: string, lane: number, card: number) => void; readonly onChoose?: (index: number) => void }) => {
  const C = useColors()
  const dims = useTerminalDimensions()
  const width = Math.max(10, (props.width ?? dims.width) - 2)
  const all = ordered(props.view.layout)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const boxes = useRef(new Map<string, ScrollBoxRenderable>())
  if (props.scroller !== undefined) props.scroller.current = (delta) => boxes.current.get(all[props.ui.focus]?.id ?? "")?.scrollBy(delta)
  // The focused table's highlighted row stays on screen as the cursor moves.
  const focusedSection = all[props.ui.focus]
  const current = focusedSection === undefined ? undefined : leafOf(props.view, props.ui, focusedSection.id)
  const cursor = current === undefined ? undefined : props.ui.rows[current.path] ?? 0
  useEffect(() => {
    if (focusedSection === undefined || current === undefined || cursor === undefined) return
    // After this frame's layout: the row has no position before it.
    const t = setTimeout(() => boxes.current.get(focusedSection.id)?.scrollChildIntoView(`row-${current.path}-${cursor}`), 0)
    return () => clearTimeout(t)
  }, [focusedSection?.id, current?.path, cursor])
  // Where each section and the view sit, as last laid out: a column menu drops down only as far as the view goes.
  const root = useRef<BoxRenderable | null>(null)
  const sectionBoxes = useRef(new Map<string, BoxRenderable>())
  const headRowsOf = (id: string) => { const sec = props.view.layout.sections.find((x) => x.id === id); return sec === undefined ? 1 : headRowsOfSection(sec) }
  const roomBelow = (id: string) => {
    const box = sectionBoxes.current.get(id)
    return root.current === null || box === undefined ? MENU_ROWS + 2 : root.current.y + root.current.height - (box.y + headRowsOf(id) + 1)
  }
  // The focused table's cursor row, in full, in place of the summary.
  // The cursor row's card, unless a text follows that table: the text is its detail then.
  const cursor0 = cursorRow(props.view, props.ui)
  const followed = cursor0 !== undefined && props.view.layout.sections.some((x) => x.kind !== "tabs" && x.follows !== undefined && leafOf(props.view, props.ui, x.follows)?.path === cursor0.path)
  const card = followed ? undefined : cursor0
  let seen = 0
  /** One section at a width: its heading, its content, its menu, buttons and row card; `style` replaces its own box style (a side of a pair). */
  const drawSection = (s: LayoutSection, i: number, width: number, style?: Record<string, unknown>) => {
        const leaf = leafOf(props.view, props.ui, s.id)
        if (leaf === undefined) return null
        const Draw = renderers[leaf.leaf.kind]
        const focused = props.ui.focus === i
        if (s.role === "summary" && s.kind === "stats")
          return (
            <box key={s.id} style={{ flexShrink: 0, height: 1, marginBottom: 1 }}>
              <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} width={width} />
            </box>
          )
        // A board takes the room left and scrolls each lane itself: no section scroll box around it.
        if (leaf.leaf.kind === "board") {
          const after = seen++ > 0
          return (
            <box key={s.id} style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minHeight: 4, ...(after ? { marginTop: 1 } : {}) }}>
              {headRowsOfSection(s) > 0 ? <Heading title={s.title ?? s.id} width={width} focused={focused} /> : null}
              <Board view={props.view} ui={props.ui} path={leaf.path} focused={focused} width={width} {...(props.onBoardPick !== undefined || props.onAct !== undefined ? { onPick: (lane: number, card: number) => {
                // The shell moves the cursor and opens the card; without it, the card opens through the plugin.
                if (props.onBoardPick !== undefined) return props.onBoardPick(leaf.path, lane, card)
                const r = pickCard(props.view, props.ui, leaf.path, lane, card)
                if (r.act !== undefined) props.onAct!(r.act.section, r.act.action, r.act.rows)
              } } : {})} />
            </box>
          )
        }
        const tabs = tabsOf(props.view, props.ui, s)
        const headRows = headRowsOfSection(s)
        // A blank row between one section and the one before it.
        const after = seen++ > 0
        const buttons = props.onAct === undefined ? undefined : buttonsOf(props.view, props.ui, leaf)
        // The buttons and the blank line above them.
        // Its cursor row's card under it, a blank row above and below.
        const cardRows = card !== undefined && card.path === leaf.path ? cardHeight(card, props.view, width, Math.max(3, Math.floor(props.height / 3))) : 0
        const extra = (buttons === undefined ? 0 : 2) + (cardRows > 0 ? cardRows + 2 : 0)
        return (
          <box
            key={s.id}
            ref={(b: BoxRenderable | null) => void (b === null ? sectionBoxes.current.delete(s.id) : sectionBoxes.current.set(s.id, b))}
            // A column menu drops over the sections below: its section draws above them while it is open.
            {...(props.ui.menu?.path === leaf.path ? { zIndex: 5 } : {})}
            // Sections fit their content, capped by role, and shrink to their heading when the window is short.
            style={style ?? {
              flexDirection: "column",
              minHeight: headRows + 1,
              flexShrink: 1,
              ...(after ? { marginTop: 1 } : {}),
              // A log or pinned section grows; so does a view's only section (a drawer's text), whatever its role.
              ...(s.role === "log" || s.role === "pinned" || props.view.layout.sections.length === 1
                ? { flexGrow: 1, flexBasis: 0, maxHeight: wantedOf(props.view, props.ui, s, width, heights[leaf.path]) + extra }
                : { height: wantedOf(props.view, props.ui, s, width, heights[leaf.path]) + extra, maxHeight: s.role === "summary" ? 6 : SHARE[s.role as keyof typeof SHARE] }),
            }}
          >
            <box style={{ height: headRows, flexShrink: 0, ...(headRows === 0 ? { visible: false } : {}) }}>
              <Heading title={s.title ?? s.id} width={width} focused={focused} {...(tabs !== undefined ? { tabs } : {})} {...(props.onTab !== undefined ? { onTab: (k: number) => props.onTab!(s.id, k) } : {})} />
            </box>
            {/* A searchable table's field sits above its scroll area: it stays while the rows scroll. */}
            {leaf.leaf.kind === "table" && leaf.leaf.search === true ? (
              <box style={{ height: 1, flexShrink: 0 }}>
                <SearchField view={props.view} ui={props.ui} path={leaf.path} width={width} {...(props.onSearch !== undefined ? { onSearch: () => props.onSearch!(s.id, leaf.path) } : {})} />
              </box>
            ) : null}
            <scrollbox
              focusable={false}
              ref={(r: ScrollBoxRenderable | null) => void (r === null ? boxes.current.delete(s.id) : boxes.current.set(s.id, r))}
              style={{ flexGrow: 1, flexShrink: 1, minHeight: 1 }}
              {...(leaf.leaf.kind === "log" ? { stickyScroll: true, stickyStart: "bottom" as const } : {})}
            >
              <Draw
                view={props.view}
                ui={props.ui}
                path={leaf.path}
                leaf={leaf.leaf}
                focused={focused}
                width={width}
                onHeight={(height) => setHeights((prev) => prev[leaf.path] === height ? prev : { ...prev, [leaf.path]: height })}
                {...(props.onPick !== undefined ? { onPick: (i: number) => props.onPick!(s.id, i) } : {})}
                {...(props.onHeader !== undefined ? { onHeader: (c: number) => props.onHeader!(s.id, c) } : {})}
                {...(props.onMark !== undefined ? { onMark: (k: number) => props.onMark!(s.id, k) } : {})}
                {...(props.onAct !== undefined
                  ? {
                      // A click on a toggle row's mark flips it, as space does.
                      onToggle: (k: number) => {
                        const row = shownRows(props.view, props.ui, leaf.path)[k]
                        if (row !== undefined) props.onAct!(leaf.path, "toggle", [row.id])
                      },
                    }
                  : {})}
                {...(props.onSearch !== undefined ? { onSearch: () => props.onSearch!(s.id, leaf.path) } : {})}
              />
            </scrollbox>
            {props.ui.menu?.path === leaf.path && leaf.leaf.kind === "table" ? (
              <ColumnMenu
                view={props.view}
                ui={props.ui}
                path={leaf.path}
                leaf={leaf.leaf}
                width={width}
                room={roomBelow(s.id)}
                top={headRows + 1}
                {...(props.onMenuPick !== undefined ? { onPick: props.onMenuPick } : {})}
                {...(props.onMenuAdjust !== undefined ? { onAdjust: props.onMenuAdjust } : {})}
              />
            ) : null}
            {props.ui.input?.section === leaf.path ? <InputField input={props.ui.input} width={width} /> : null}
            {buttons !== undefined ? (
              <box style={{ flexShrink: 0, marginTop: 1, paddingLeft: 1 }}>
                <Buttons
                  actions={buttons.actions}
                  count={buttons.rows.length}
                  onPress={(id) => {
                    const rows = buttons.rowsFor(id)
                    if (rows !== undefined) props.onAct!(leaf.path, id, rows)
                  }}
                  {...(props.onClear !== undefined && buttons.rows.length > 0 ? { onClear: () => props.onClear!(leaf.path) } : {})}
                />
              </box>
            ) : null}
            {cardRows > 0 ? <RowCard card={card!} view={props.view} width={width} height={cardRows} /> : null}
          </box>
        )
  }
  return (
    <box ref={root} style={{ flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
      {/* The view's own actions it offers now (not a table's): buttons at its top; a click runs one (or drops its choices down). */}
      {viewActions(props.view).length > 0 && props.onAct !== undefined ? (
        <box style={{ flexShrink: 0, marginBottom: 1, paddingLeft: 1, flexDirection: "column" }}>
          <Buttons actions={viewActions(props.view)} count={0} onPress={(id) => props.onAct!(undefined, id, [])} />
          {props.ui.choose !== undefined && props.ui.choose.section === undefined ? <Choices choose={props.ui.choose} {...(props.onChoose !== undefined ? { onPick: props.onChoose } : {})} /> : null}
        </box>
      ) : null}
      {all.map((s, i) => {
        // A section drawn beside another is drawn with it.
        const beside = s.kind !== "tabs" ? s.beside : undefined
        if (beside !== undefined && all.some((x) => x.id === beside)) return null
        const partner = all.findIndex((x) => x.kind !== "tabs" && x.beside === s.id)
        if (partner < 0) return drawSection(s, i, width)
        // A list and its detail side by side: the list takes 55% (46 to 64 columns: its columns and its buttons), the detail the rest.
        const left = Math.max(46, Math.min(Math.floor(width * 0.55), 64))
        const right = Math.max(10, width - left - 3)
        const leaf = leafOf(props.view, props.ui, s.id)
        const after = seen++ > 0
        return (
          <box key={`${s.id}+${all[partner]!.id}`} style={{ flexDirection: "row", flexGrow: 1, flexBasis: 0, flexShrink: 1, minHeight: 3, ...(after ? { marginTop: 1 } : {}), ...(leaf !== undefined ? { maxHeight: Math.max(wantedOf(props.view, props.ui, s, width, heights[leaf.path]) + 4, wantedOf(props.view, props.ui, all[partner]!, right, heights[leafOf(props.view, props.ui, all[partner]!.id)?.path ?? ""]) + 1) } : {}) }}>
            {drawSection(s, i, left, { flexDirection: "column", width: left, flexShrink: 0 })}
            {drawSection(all[partner]!, partner, right, { flexDirection: "column", flexGrow: 1, border: ["left"], borderColor: C.line, paddingLeft: 1 })}
          </box>
        )
      })}
    </box>
  )
}
