import type { Answer, Inquiry, RlmNode, SessionState } from "@zarg/client"

/** UI-only state: what is focused and selected. Everything else comes from the session. */
export interface Ui {
  readonly focus: "conversation" | "agents"
  /** The selected picker row. */
  readonly pick: number
  /** The inquiry `pick` belongs to; a new inquiry resets the selection. */
  readonly inquiryId?: string
  /** True while the "Something else…" text field is open. */
  readonly other: boolean
  /** The inquiry already answered: further Enters wait for the core to move on. */
  readonly answered?: string
  /** When Ctrl-C was last pressed (ms); a second press within `EXIT_WINDOW_MS` exits. */
  readonly lastCtrlC?: number
}

export const EXIT_WINDOW_MS = 2000
export const OTHER = "__other"

export const initialUi: Ui = { focus: "conversation", pick: 0, other: false }

export interface PickerRow {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly recommended: boolean
  readonly selected: boolean
}

/** The inquiry's options, then "Something else…" when free text is allowed. */
export const pickerRows = (inquiry: Inquiry, pick: number): ReadonlyArray<PickerRow> => {
  const rows = [
    ...inquiry.options.map((o) => ({ id: o.id, label: o.label, ...(o.why !== undefined ? { why: o.why } : {}), recommended: o.recommended === true })),
    ...(inquiry.allowOther ? [{ id: OTHER, label: "Something else…", recommended: false }] : []),
  ]
  return rows.map((r, i) => ({ ...r, selected: i === pick }))
}

/** A new inquiry preselects its recommended option (or the first). */
export const syncUi = (ui: Ui, s: SessionState): Ui => {
  const inquiry = s.thread.pendingInquiry
  if (inquiry === undefined) {
    if (ui.inquiryId === undefined && !ui.other) return ui
    const { inquiryId: _, ...rest } = ui
    return { ...rest, other: false }
  }
  if (inquiry.id === ui.inquiryId) return ui
  const recommended = inquiry.options.findIndex((o) => o.recommended === true)
  return { ...ui, inquiryId: inquiry.id, pick: recommended >= 0 ? recommended : 0, other: false }
}

export interface Line {
  readonly kind: "you" | "zarg" | "error" | "notice"
  readonly text: string
}

/** The conversation: messages, then the run error and any transport notice. */
export const conversation = (s: SessionState): ReadonlyArray<Line> => [
  ...s.thread.messages.map((m): Line => ({ kind: m.role === "user" ? "you" : "zarg", text: m.text })),
  ...(s.thread.error !== undefined ? [{ kind: "error" as const, text: `${s.thread.error.code ?? "error"}: ${s.thread.error.message}` }] : []),
  ...(s.notice !== undefined ? [{ kind: "notice" as const, text: s.notice }] : []),
]

export interface TreeLine {
  readonly depth: number
  readonly kind: "rlm" | "decision"
  readonly text: string
}

const idNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0)

/** The RLM tree, parents before children, each RLM followed by its decisions. */
export const tree = (rlms: Readonly<Record<string, RlmNode>>): ReadonlyArray<TreeLine> => {
  const nodes = Object.values(rlms).sort((a, b) => idNumber(a.id) - idNumber(b.id))
  const children = (parent: string | null) => nodes.filter((n) => (parent === null ? n.parent === null || rlms[n.parent] === undefined : n.parent === parent))
  const out: Array<TreeLine> = []
  const visit = (n: RlmNode, depth: number) => {
    const tokens = n.tokens !== undefined ? ` ${n.tokens} tok` : ""
    out.push({ depth, kind: "rlm", text: `${n.preset} ${n.id}  ${n.turns}/${n.budget}${tokens}  ${n.status}${n.error !== undefined ? `: ${n.error}` : ""}` })
    for (const d of n.decisions ?? []) {
      const criteria = d.criteria.map((c) => `${c.name} ${c.answer ? "yes" : "no"} ${c.confidence.toFixed(2)}`).join(" · ")
      out.push({ depth: depth + 1, kind: "decision", text: `${d.atomic ? "atomic" : "plan"}${criteria ? `  ${criteria}` : ""}` })
    }
    for (const c of children(n.id)) visit(c, depth + 1)
  }
  for (const r of children(null)) visit(r, 0)
  return out
}

export interface Meta {
  readonly threadId: string
  readonly driver?: string
  readonly mode: "child" | "headless"
}

/** Most important first, so a narrow terminal cuts the driver model, never the core state. */
export const statusLine = (s: SessionState, meta: Meta) =>
  [s.core === "down" ? "core stopped" : `core ${meta.mode}`, s.thread.status, `thread ${meta.threadId}`, meta.driver ?? "driver model unknown"].join(" · ")

export interface Key {
  readonly name: string
  readonly ctrl?: boolean
}

export type Action =
  | { readonly type: "answer"; readonly answer: Answer }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "stop" }
  | { readonly type: "exit" }

/** What a key press does: the next UI state and, maybe, an action for the session. */
export const onKey = (ui: Ui, s: SessionState, key: Key, now: number): { readonly ui: Ui; readonly action?: Action } => {
  if (key.ctrl && key.name === "d") return { ui, action: { type: "exit" } }
  if (key.ctrl && key.name === "c") {
    if (ui.lastCtrlC !== undefined && now - ui.lastCtrlC < EXIT_WINDOW_MS) return { ui, action: { type: "exit" } }
    return { ui: { ...ui, lastCtrlC: now }, action: { type: "stop" } }
  }
  if (key.name === "tab") return { ui: { ...ui, focus: ui.focus === "conversation" ? "agents" : "conversation" } }
  const inquiry = s.thread.pendingInquiry
  // The picker takes keys only while the conversation side has focus; on the agents pane arrows scroll.
  if (inquiry === undefined || ui.focus !== "conversation" || ui.answered === inquiry.id) return { ui }
  if (ui.other) return key.name === "escape" ? { ui: { ...ui, other: false } } : { ui }
  const rows = pickerRows(inquiry, ui.pick)
  if (key.name === "up") return { ui: { ...ui, pick: Math.max(0, ui.pick - 1) } }
  if (key.name === "down") return { ui: { ...ui, pick: Math.min(rows.length - 1, ui.pick + 1) } }
  if (key.name === "return") {
    const row = rows[ui.pick]
    if (row === undefined) return { ui }
    if (row.id === OTHER) return { ui: { ...ui, other: true } }
    return { ui: { ...ui, answered: inquiry.id }, action: { type: "answer", answer: { choice: row.id } } }
  }
  return { ui }
}

/** Enter in the text field: the "Something else…" answer, or a message (an interjection while the driver works). */
export const onSubmit = (ui: Ui, s: SessionState, text: string): { readonly ui: Ui; readonly action?: Action } => {
  if (text.trim().length === 0) return { ui }
  const inquiry = s.thread.pendingInquiry
  if (ui.other && inquiry !== undefined) {
    if (ui.answered === inquiry.id) return { ui }
    return { ui: { ...ui, other: false, answered: inquiry.id }, action: { type: "answer", answer: { other: text } } }
  }
  return { ui, action: { type: "send", text } }
}

/** The text field takes keys unless the picker is choosing. */
export const inputFocused = (ui: Ui, s: SessionState) => ui.focus === "conversation" && (s.thread.pendingInquiry === undefined || ui.other)
