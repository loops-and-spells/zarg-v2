import type { ScrollBoxRenderable } from "@opentui/core"
import { type ReactNode, useEffect, useRef } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { CHAT, type ConversationQuestion, conversationRows, keyFor, leafOf, OTHER, ordered, rowsOf, THEME, toneColor, type LayoutLeaf, type LayoutSection, type SectionKind, type ViewState, type ViewUi } from "@zarg/view"
import { fit, gauge, heading } from "./look"

/** The terminal's colour for a plugin's tone (the theme's, via `toneColor`). */
const fg = (t: unknown) => toneColor(t)
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const STATE_MARK = { busy: "⠼", waiting: "◌", done: "✓", flagged: "⚑" } as const

interface LeafProps { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly leaf: LayoutLeaf; readonly focused: boolean; readonly width: number; readonly onPick?: (index: number) => void }
type Leaf = (p: LeafProps) => ReactNode

/** A section's heading: its title (or its tabs, the current one marked), then a faint rule. */
export const Heading = (p: { readonly title: string; readonly width: number; readonly focused: boolean; readonly tabs?: ReadonlyArray<{ readonly label: string; readonly current: boolean }> }) => {
  const colour = p.focused ? THEME.accent : THEME.dim
  const label = p.tabs !== undefined ? p.tabs.map((t) => t.label).join("  ") : p.title
  const h = heading(label, p.width)
  return (
    <text wrapMode="none">
      {p.tabs !== undefined ? (
        p.tabs.map((t, i) => (
          <span key={i} fg={t.current ? colour : THEME.faint}>
            {t.current ? <b>{`${i > 0 ? "  " : ""}${t.label}`}</b> : `${i > 0 ? "  " : ""}${t.label}`}
          </span>
        ))
      ) : (
        <span fg={colour}>
          <b>{h.title}</b>
        </span>
      )}
      <span fg={THEME.faint}>{h.rule}</span>
    </text>
  )
}

const Stats: Leaf = ({ view, path, width }) => {
  const d = view.data[path] as { items?: ReadonlyArray<{ label: string; value: string; tone?: string }>; progress?: { done: number; total: number } } | undefined
  const g = d?.progress !== undefined ? gauge(d.progress.done, d.progress.total, 24) : undefined
  return (
    <text wrapMode="none">
      {g !== undefined ? <span fg={THEME.accent}>{g.done}</span> : null}
      {g !== undefined ? <span fg={THEME.faint}>{`${g.rest}  `}</span> : null}
      {(d?.items ?? []).map((i, n) => (
        <span key={n}>
          <span fg={i.tone !== undefined ? fg(i.tone) : THEME.text}>{`${n > 0 ? "   " : ""}${fit(i.value, width)}`}</span>
          <span fg={THEME.dim}>{` ${i.label}`}</span>
        </span>
      ))}
    </text>
  )
}
/** The gutter: the cursor's ▍ and, in a selectable table, ○ or ●. */
const Gutter = (p: { readonly cursor: boolean; readonly selectable: boolean; readonly selected: boolean }) => (
  <>
    <span fg={THEME.accent}>{p.cursor ? "▍" : " "}</span>
    {p.selectable ? <span fg={p.selected ? THEME.accent : THEME.dim}>{p.selected ? "● " : "○ "}</span> : <span> </span>}
  </>
)
const List: Leaf = ({ view, ui, path, focused, width }) => {
  const items = (view.data[path] as { items?: ReadonlyArray<{ id: string; text: string; detail?: string; state?: keyof typeof STATE_MARK; tone?: string }> } | undefined)?.items ?? []
  const row = ui.rows[path] ?? 0
  return (
    <>
      {items.length === 0 ? <text fg={THEME.dim}> nothing yet</text> : null}
      {items.map((it, i) => {
        const cursor = focused && i === row
        const tone = it.state === "waiting" || it.state === "done" ? THEME.dim : it.state === "flagged" ? THEME.attention : fg(it.tone)
        const text = fit(it.text, Math.max(8, width - 6 - (it.detail?.length ?? 0)))
        return (
          <text key={it.id} wrapMode="none" {...(cursor ? { bg: THEME.selection } : {})}>
            <Gutter cursor={cursor} selectable={false} selected={false} />
            <span fg={tone}>{`${it.state !== undefined ? STATE_MARK[it.state] : " "} ${text}`}</span>
            {it.detail !== undefined ? <span fg={THEME.dim}>{`  ${it.detail}`}</span> : null}
          </text>
        )
      })}
    </>
  )
}
const Log: Leaf = ({ view, path, width }) => (
  <>
    {((view.data[path] as { lines?: ReadonlyArray<{ text: string; tone?: string }> } | undefined)?.lines ?? []).map((l, i) => (
      <text key={i} fg={fg(l.tone)} wrapMode="none">{fit(l.text, width)}</text>
    ))}
  </>
)
const Table: Leaf = ({ view, ui, path, leaf, focused, width, onPick }) => {
  const cols = leaf.columns ?? []
  const rows = ((view.data[path] as { rows?: ReadonlyArray<{ id: string; cells: Record<string, string>; tone?: string }> } | undefined)?.rows ?? [])
  const selectable = leaf.selectable === true
  const gutter = selectable ? 3 : 2
  // Columns as wide as their widest cell (at most 24); the last one takes what is left and is cut there.
  const widths = cols.map((c, ci) => (ci === cols.length - 1 ? 0 : Math.min(24, Math.max(c.label.length, ...rows.map((r) => (r.cells[c.id] ?? "").replace(/\s*\n\s*/g, " ").length)))))
  const fixed = widths.reduce((a, w) => a + w + 2, 0)
  const cells = (get: (c: { id: string; label: string }) => string) =>
    cols.map((c, ci) => (widths[ci] === 0 ? fit(get(c), Math.max(4, width - gutter - fixed)) : pad(fit(get(c), widths[ci]!), widths[ci]!))).join("  ")
  const cursor = ui.rows[path] ?? 0
  const sel = ui.selected[path] ?? []
  if (rows.length === 0) return <text fg={THEME.dim}> nothing yet</text>
  return (
    <>
      <text fg={THEME.dim} wrapMode="none">{`${" ".repeat(gutter)}${cells((c) => c.label)}`}</text>
      {rows.map((r, i) => {
        const on = focused && i === cursor
        const picked = sel.includes(r.id)
        return (
          <text key={r.id} id={`row-${path}-${i}`} onMouseDown={() => onPick?.(i)} wrapMode="none" {...(on ? { bg: THEME.selection } : {})}>
            <Gutter cursor={on} selectable={selectable} selected={picked} />
            <span fg={picked || on ? THEME.text : fg(r.tone)}>{cells((c) => r.cells[c.id] ?? "")}</span>
          </text>
        )
      })}
    </>
  )
}
const KeyValue: Leaf = ({ view, path, width }) => (
  <>
    {((view.data[path] as { pairs?: ReadonlyArray<{ key: string; value: string }> } | undefined)?.pairs ?? []).map((p) => (
      <text key={p.key} wrapMode="none">
        <span fg={THEME.dim}>{pad(p.key, 14)}</span>
        <span fg={THEME.text}>{` ${fit(p.value, Math.max(4, width - 15))}`}</span>
      </text>
    ))}
  </>
)
// The one kind that wraps: prose.
const Text: Leaf = ({ view, path }) => <text fg={THEME.text}>{(view.data[path] as { markdown?: string } | undefined)?.markdown ?? ""}</text>

// A plugin agent's conversation: its messages, then its question with the options (arrows and Enter answer it).
const Conversation: Leaf = ({ view, ui, path }) => {
  const d = view.data[path] as { messages?: ReadonlyArray<{ id: string; role: string; text: string }>; question?: ConversationQuestion } | undefined
  const q = d?.question
  return (
    <>
      {(d?.messages ?? []).map((m) => (
        <text key={m.id}>
          <span fg={m.role === "user" ? THEME.dim : THEME.accent}>{m.role === "user" ? "you   " : "agent "}</span>
          <span fg={THEME.text}>{m.text}</span>
        </text>
      ))}
      {q === undefined ? null : (
        <text fg={THEME.attention}>
          <b>{q.question}</b>
        </text>
      )}
      {q === undefined
        ? null
        : conversationRows(q, { pick: ui.rows[path] ?? 0, other: false })
            .filter((r) => r.id !== OTHER && r.id !== CHAT)
            .map((r) => (
              <text key={r.id} wrapMode="none">
                <span fg={THEME.accent}>{r.selected ? "› " : "  "}</span>
                <span fg={THEME.text}>{r.label}</span>
                {r.recommended ? <span fg={THEME.dim}>{"   recommended"}</span> : null}
              </text>
            ))}
    </>
  )
}

/** How the terminal draws each leaf kind; tabs draw their current leaf. Every kind must be here. */
export const renderers: Record<Exclude<SectionKind, "tabs">, Leaf> = { stats: Stats, list: List, log: Log, table: Table, keyvalue: KeyValue, text: Text, conversation: Conversation }

const count = (view: ViewState, path: string) => rowsOf(view, path).length
/** A tabs section's tabs for its heading: each with its row count, the current one marked. */
const tabsOf = (view: ViewState, ui: ViewUi, s: LayoutSection) =>
  s.kind === "tabs" ? s.tabs.map((t, i) => ({ label: `${t.title ?? t.id} ${count(view, `${s.id}.${t.id}`)}`, current: i === (ui.tabs[s.id] ?? 0) })) : undefined

/** How tall a section would like to be: its content plus its frame (text counts its lines). */
const wantedOf = (view: ViewState, ui: ViewUi, s: LayoutSection, width: number): number => {
  const leaf = leafOf(view, ui, s.id)
  if (leaf === undefined) return 3
  const k = leaf.leaf.kind
  const content =
    k === "stats" ? 1
    // Prose wraps: each paragraph line takes as many rows as its length needs.
    : k === "text" ? ((view.data[leaf.path] as { markdown?: string } | undefined)?.markdown ?? "").split("\n").reduce((a, l) => a + Math.max(1, Math.ceil(l.length / Math.max(1, width))), 0)
    : k === "keyvalue" ? ((view.data[leaf.path] as { pairs?: ReadonlyArray<unknown> } | undefined)?.pairs ?? []).length
    : k === "log" ? ((view.data[leaf.path] as { lines?: ReadonlyArray<unknown> } | undefined)?.lines ?? []).length
    : rowsOf(view, leaf.path).length + (k === "table" ? 1 : 0)
  // Its content and its heading line.
  return Math.max(1, content) + 1
}
type ButtonSpec = { readonly id: string; readonly label: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>> }
/** A selection's actions as buttons: the first filled with the accent (with the count), the rest quiet; each shows its key and runs on a click. */
export const Buttons = (p: { readonly actions: ReadonlyArray<ButtonSpec>; readonly count: number; readonly onPress: (id: string) => void; readonly onClear?: () => void }) => (
  <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
    {p.actions.map((a, i) => {
      const fill = i === 0 ? THEME.accent : THEME.line
      const key = keyFor(a, "terminal")
      return (
        <text key={a.id} wrapMode="none" onMouseDown={() => p.onPress(a.id)} style={{ marginRight: 2 }}>
          <span fg={fill}>▐</span>
          <span fg={i === 0 ? THEME.bg : THEME.text} bg={fill}>{i === 0 ? ` ${a.label} · ${p.count} ` : ` ${a.label} `}</span>
          {key !== undefined ? <span fg={i === 0 ? THEME.raised : THEME.dim} bg={fill}>{` ${key} `}</span> : null}
          <span fg={fill}>▌</span>
        </text>
      )
    })}
    {p.onClear !== undefined ? (
      <text wrapMode="none" onMouseDown={p.onClear}>
        <span fg={THEME.dim}>{" Clear "}</span>
      </text>
    ) : null}
  </box>
)
/** A selectable table's buttons: its `selection` actions, once rows it still shows are selected. */
const buttonsOf = (view: ViewState, ui: ViewUi, leaf: { readonly path: string; readonly leaf: LayoutLeaf }) => {
  if (leaf.leaf.kind !== "table" || leaf.leaf.selectable !== true) return undefined
  const all = rowsOf(view, leaf.path)
  const rows = (ui.selected[leaf.path] ?? []).filter((id) => all.some((r) => r.id === id))
  const actions = (leaf.leaf.actions ?? []).filter((a) => a.on === "selection")
  return rows.length > 0 && actions.length > 0 ? { rows, actions } : undefined
}

/** The largest share of the view each role may take; the log takes what is left. */
const SHARE = { primary: "33%", pinned: "40%", aside: "25%" } as const

/** Scrolls the focused section by lines (the shell calls it for keys in a log or text). */
export type Scroller = (delta: number) => void

/** An agent's view in the terminal: its sections stacked by role, each a heading over its own scrollbox. */
export const AgentView = (props: { readonly view: ViewState; readonly ui: ViewUi; readonly height: number; readonly width?: number; readonly scroller?: { current?: Scroller | undefined }; readonly onPick?: (sectionId: string, index: number) => void; readonly onAct?: (section: string, action: string, rows: ReadonlyArray<string>) => void; readonly onClear?: (section: string) => void }) => {
  const dims = useTerminalDimensions()
  const width = Math.max(10, (props.width ?? dims.width) - 2)
  const all = ordered(props.view.layout)
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
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
      {all.map((s, i) => {
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
        const tabs = tabsOf(props.view, props.ui, s)
        const buttons = props.onAct === undefined ? undefined : buttonsOf(props.view, props.ui, leaf)
        // The buttons and the blank line above them.
        const extra = buttons === undefined ? 0 : 2
        return (
          <box
            key={s.id}
            // Sections fit their content, capped by role, and shrink to their heading when the window is short.
            style={{
              flexDirection: "column",
              minHeight: 2,
              flexShrink: 1,
              ...(s.role === "log" || s.role === "pinned"
                ? { flexGrow: 1, flexBasis: 0, maxHeight: wantedOf(props.view, props.ui, s, width) + extra }
                : { height: wantedOf(props.view, props.ui, s, width) + extra, maxHeight: s.role === "summary" ? 6 : SHARE[s.role as keyof typeof SHARE] }),
            }}
          >
            <box style={{ height: 1, flexShrink: 0 }}>
              <Heading title={s.title ?? s.id} width={width} focused={focused} {...(tabs !== undefined ? { tabs } : {})} />
            </box>
            <scrollbox
              focusable={false}
              ref={(r: ScrollBoxRenderable | null) => void (r === null ? boxes.current.delete(s.id) : boxes.current.set(s.id, r))}
              style={{ flexGrow: 1, flexShrink: 1, minHeight: 1 }}
              {...(leaf.leaf.kind === "log" ? { stickyScroll: true, stickyStart: "bottom" as const } : {})}
            >
              <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} width={width} {...(props.onPick !== undefined ? { onPick: (i: number) => props.onPick!(s.id, i) } : {})} />
            </scrollbox>
            {buttons !== undefined ? (
              <box style={{ flexShrink: 0, marginTop: 1, paddingLeft: 1 }}>
                <Buttons actions={buttons.actions} count={buttons.rows.length} onPress={(id) => props.onAct!(leaf.path, id, buttons.rows)} {...(props.onClear !== undefined ? { onClear: () => props.onClear!(leaf.path) } : {})} />
              </box>
            ) : null}
          </box>
        )
      })}
    </box>
  )
}
