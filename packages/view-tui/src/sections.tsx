import type { ScrollBoxRenderable } from "@opentui/core"
import { type ReactNode, useEffect, useRef } from "react"
import { CHAT, type ConversationQuestion, conversationRows, leafOf, OTHER, ordered, rowsOf, type LayoutLeaf, type LayoutSection, type SectionKind, type ViewState, type ViewUi } from "@zarg/view"

/** The terminal's colour for each tone. */
export const TONES = { normal: "#e8eaed", ok: "#81c995", warn: "#fdd663", error: "#f28b82", dim: "#9aa0a6", accent: "#81c995" } as const
const SELECT_BG = "#3c4043"
type Tone = keyof typeof TONES
const fg = (t: unknown) => TONES[(t as Tone) ?? "normal"] ?? TONES.normal
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const bar = (done: number, total: number, w = 24) => "█".repeat(total > 0 ? Math.round((done / total) * w) : 0).padEnd(w, "░")
const STATE_MARK = { busy: "●", waiting: "◌", done: "✓", flagged: "⚑" } as const

interface LeafProps { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly leaf: LayoutLeaf; readonly focused: boolean; readonly onPick?: (index: number) => void }
type Leaf = (p: LeafProps) => ReactNode

const Stats: Leaf = ({ view, path }) => {
  const d = view.data[path] as { items?: ReadonlyArray<{ label: string; value: string; tone?: string }>; progress?: { done: number; total: number } } | undefined
  const items = (d?.items ?? []).map((i) => `${i.value} ${i.label}`).join("   ")
  return <text fg={TONES.normal} wrapMode="none">{`${d?.progress !== undefined ? `${bar(d.progress.done, d.progress.total)}  ` : ""}${items}`}</text>
}
const List: Leaf = ({ view, ui, path, focused }) => {
  const items = (view.data[path] as { items?: ReadonlyArray<{ id: string; text: string; detail?: string; state?: keyof typeof STATE_MARK; tone?: string }> } | undefined)?.items ?? []
  const row = ui.rows[path] ?? 0
  return (
    <>
      {items.map((it, i) => (
        <text key={it.id} wrapMode="none" fg={it.state === "waiting" || it.state === "done" ? TONES.dim : it.state === "flagged" ? TONES.warn : fg(it.tone)} {...(focused && i === row ? { bg: SELECT_BG } : {})}>
          {`${it.state !== undefined ? STATE_MARK[it.state] : " "} ${pad(it.text, 56)} ${it.detail ?? ""}`}
        </text>
      ))}
    </>
  )
}
const Log: Leaf = ({ view, path }) => (
  <>
    {((view.data[path] as { lines?: ReadonlyArray<{ text: string; tone?: string }> } | undefined)?.lines ?? []).map((l, i) => (
      <text key={i} fg={fg(l.tone)} wrapMode="none">{l.text}</text>
    ))}
  </>
)
const Table: Leaf = ({ view, ui, path, leaf, focused, onPick }) => {
  const cols = leaf.columns ?? []
  // A cell is one line: breaks in it (a pasted report) become spaces.
  const rows = ((view.data[path] as { rows?: ReadonlyArray<{ id: string; cells: Record<string, string>; tone?: string }> } | undefined)?.rows ?? []).map((r) => ({
    ...r,
    cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, v.replace(/\s*\n\s*/g, " ")])),
  }))
  const widths = cols.map((c, ci) => (ci === cols.length - 1 ? 0 : Math.min(24, Math.max(c.label.length, ...rows.map((r) => (r.cells[c.id] ?? "").length)))))
  const cells = (get: (c: { id: string; label: string }) => string) => cols.map((c, ci) => (widths[ci] === 0 ? get(c) : pad(get(c), widths[ci]!))).join("  ")
  const cursor = ui.rows[path] ?? 0
  const sel = ui.selected[path] ?? []
  const box = leaf.selectable === true ? 4 : 0
  return (
    <>
      <text fg={TONES.dim} wrapMode="none">{`  ${" ".repeat(box)}${cells((c) => c.label)}`}</text>
      {rows.length === 0 ? <text fg={TONES.dim}>  (none)</text> : null}
      {rows.map((r, i) => (
        <text key={r.id} id={`row-${path}-${i}`} onMouseDown={() => onPick?.(i)} wrapMode="none" fg={focused && i === cursor ? TONES.accent : fg(r.tone)} {...(focused && i === cursor ? { bg: SELECT_BG } : {})}>
          {`${focused && i === cursor ? "▸" : " "} ${leaf.selectable === true ? `[${sel.includes(r.id) ? "x" : " "}] ` : ""}${cells((c) => r.cells[c.id] ?? "")}`}
        </text>
      ))}
      {(leaf.actions ?? []).length > 0 ? (
        <text fg={TONES.dim} wrapMode="none">{["↑↓ move", ...(leaf.selectable === true ? ["space select"] : []), ...(leaf.actions ?? []).map((a) => `${a.key ?? "?"} ${a.label}`)].join(" · ")}</text>
      ) : null}
    </>
  )
}
const KeyValue: Leaf = ({ view, path }) => (
  <>
    {((view.data[path] as { pairs?: ReadonlyArray<{ key: string; value: string }> } | undefined)?.pairs ?? []).map((p) => (
      <text key={p.key} wrapMode="none">{`${pad(p.key, 14)} ${p.value}`}</text>
    ))}
  </>
)
const Text: Leaf = ({ view, path }) => <text fg={TONES.normal}>{(view.data[path] as { markdown?: string } | undefined)?.markdown ?? ""}</text>

// A plugin agent's conversation: its messages, then its question with the options (arrows and Enter answer it).
const Conversation: Leaf = ({ view, ui, path }) => {
  const d = view.data[path] as { messages?: ReadonlyArray<{ id: string; role: string; text: string }>; question?: ConversationQuestion } | undefined
  const q = d?.question
  return (
    <>
      {(d?.messages ?? []).map((m) => (
        <text key={m.id} fg={m.role === "user" ? TONES.accent : TONES.normal}>{`${m.role === "user" ? "you " : "    "}  ${m.text}`}</text>
      ))}
      {q === undefined ? null : <text fg={TONES.warn}>{q.question}</text>}
      {q === undefined
        ? null
        : conversationRows(q, { pick: ui.rows[path] ?? 0, other: false })
            .filter((r) => r.id !== OTHER && r.id !== CHAT)
            .map((r) => <text key={r.id} fg={r.selected ? TONES.accent : TONES.normal}>{`${r.selected ? "›" : " "} ${r.label}${r.recommended ? " (recommended)" : ""}`}</text>)}
    </>
  )
}

/** How the terminal draws each leaf kind; tabs draw their current leaf. Every kind must be here. */
export const renderers: Record<Exclude<SectionKind, "tabs">, Leaf> = { stats: Stats, list: List, log: Log, table: Table, keyvalue: KeyValue, text: Text, conversation: Conversation }

const count = (view: ViewState, path: string) => rowsOf(view, path).length
const titleOf = (view: ViewState, ui: ViewUi, s: LayoutSection) =>
  s.kind === "tabs"
    ? s.tabs.map((t, i) => { const label = `${t.title ?? t.id} (${count(view, `${s.id}.${t.id}`)})`; return i === (ui.tabs[s.id] ?? 0) ? `[${label}]` : label }).join("  ")
    : s.title ?? ""

/** How tall a section would like to be: its content plus its frame (text counts its lines). */
const wantedOf = (view: ViewState, ui: ViewUi, s: LayoutSection): number => {
  const leaf = leafOf(view, ui, s.id)
  if (leaf === undefined) return 3
  const k = leaf.leaf.kind
  const content =
    k === "stats" ? 1
    : k === "text" ? ((view.data[leaf.path] as { markdown?: string } | undefined)?.markdown ?? "").split("\n").length
    : k === "keyvalue" ? ((view.data[leaf.path] as { pairs?: ReadonlyArray<unknown> } | undefined)?.pairs ?? []).length
    : rowsOf(view, leaf.path).length + (k === "table" ? 2 + ((leaf.leaf.actions ?? []).length > 0 ? 1 : 0) : 0)
  return Math.max(1, content) + 2
}
/** The largest share of the view each role may take; the log takes what is left. */
const SHARE = { primary: "33%", pinned: "40%", aside: "25%" } as const

/** Scrolls the focused section by lines (the shell calls it for keys in a log or text). */
export type Scroller = (delta: number) => void

/** An agent's view in the terminal: its sections stacked by role, each in its own scrollbox. */
export const AgentView = (props: { readonly view: ViewState; readonly ui: ViewUi; readonly height: number; readonly scroller?: { current?: Scroller | undefined }; readonly onPick?: (sectionId: string, index: number) => void }) => {
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
            <box key={s.id} style={{ flexShrink: 0, height: 1, paddingLeft: 1 }}>
              <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} />
            </box>
          )
        return (
          <scrollbox
            key={s.id}
            ref={(r: ScrollBoxRenderable | null) => void (r === null ? boxes.current.delete(s.id) : boxes.current.set(s.id, r))}
            title={titleOf(props.view, props.ui, s)}
            // Sections fit their content, capped by role, and shrink to their titled frame when the window is short.
            style={{
              border: true,
              borderColor: focused ? TONES.accent : TONES.dim,
              paddingLeft: 1,
              minHeight: 2,
              flexShrink: 1,
              ...(s.role === "log" ? { flexGrow: 1 } : { height: wantedOf(props.view, props.ui, s), maxHeight: s.role === "summary" ? 6 : SHARE[s.role as keyof typeof SHARE] }),
            }}
            {...(leaf.leaf.kind === "log" ? { stickyScroll: true, stickyStart: "bottom" as const } : {})}
          >
            <Draw view={props.view} ui={props.ui} path={leaf.path} leaf={leaf.leaf} focused={focused} {...(props.onPick !== undefined ? { onPick: (i: number) => props.onPick!(s.id, i) } : {})} />
          </scrollbox>
        )
      })}
    </box>
  )
}
