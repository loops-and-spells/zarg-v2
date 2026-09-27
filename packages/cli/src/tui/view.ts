import type { Answer, Inquiry, RlmNode, SessionState } from "@zarg/client"
import { lintSlashInput, parseSlashInput, SLASH_COMMANDS, type SlashCycle, type SlashInputState, stepCompletion } from "./commands"

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
  /** The slash-command box: the highlighted row and the Tab cycle. */
  readonly slash?: { readonly sel: number | null; readonly cycle: SlashCycle | null }
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
  | { readonly type: "command"; readonly text: string }
  | { readonly type: "stop" }
  | { readonly type: "exit" }

/** What a key press does: the next UI state and, maybe, an action for the session. */
export interface SlashBox {
  readonly title: string
  readonly rows: ReadonlyArray<{ readonly label: string; readonly desc: string; readonly selected: boolean }>
  /** The argument's ghost hint (or the params still accepted) when there is nothing to list. */
  readonly hint?: string
  readonly lint?: string
}

const slashRows = (state: SlashInputState) =>
  state.mode === "command" ? state.matches.map((c) => ({ label: c.cmd, desc: c.desc })) : state.candidates.map((c) => ({ label: c, desc: "" }))

/** The suggestions box for the draft, or undefined when the draft is not a slash command. */
export const slashBox = (draft: string, ui: Ui): SlashBox | undefined => {
  const state = parseSlashInput(draft)
  const lint = lintSlashInput(draft)
  if (state === null && lint === null) return undefined
  const rows = state ? slashRows(state).map((r, i) => ({ ...r, selected: i === ui.slash?.sel })) : []
  return {
    title: state === null || state.mode === "command" ? "commands" : `args for ${state.command.cmd}`,
    rows,
    ...(state !== null && state.mode !== "command" && rows.length === 0 ? { hint: state.hint } : {}),
    ...(lint ? { lint: lint.message } : {}),
  }
}

/** Tab, arrows and Escape while the draft is a slash command. Returns undefined when the keys are not the box's. */
const onSlashKey = (ui: Ui, key: Key, draft: string): { readonly ui: Ui; readonly draft?: string } | undefined => {
  const state = parseSlashInput(draft)
  if (state === null && lintSlashInput(draft) === null) return undefined
  if (key.name === "escape") return { ui: withoutSlash(ui), draft: "" }
  if (state === null) return undefined
  if (key.name === "tab") {
    const step = stepCompletion(draft, state, ui.slash?.cycle ?? null)
    return step ? { ui: { ...ui, slash: { sel: null, cycle: step.cycle } }, draft: step.text } : { ui }
  }
  const n = slashRows(state).length
  if (n > 0 && (key.name === "down" || key.name === "up")) {
    const sel = ui.slash?.sel
    const next = key.name === "down" ? (sel === null || sel === undefined ? 0 : (sel + 1) % n) : sel === null || sel === undefined ? n - 1 : (sel - 1 + n) % n
    return { ui: { ...ui, slash: { sel: next, cycle: null } } }
  }
  return undefined
}

const withoutSlash = (ui: Ui): Ui => {
  const { slash: _, ...rest } = ui
  return rest
}

export const onKey = (ui: Ui, s: SessionState, key: Key, now: number, draft?: string): { readonly ui: Ui; readonly action?: Action; readonly draft?: string } => {
  if (key.ctrl && key.name === "d") return { ui, action: { type: "exit" } }
  if (key.ctrl && key.name === "c") {
    if (ui.lastCtrlC !== undefined && now - ui.lastCtrlC < EXIT_WINDOW_MS) return { ui, action: { type: "exit" } }
    return { ui: { ...ui, lastCtrlC: now }, action: { type: "stop" } }
  }
  if (draft !== undefined && inputFocused(ui, s)) {
    const slash = onSlashKey(ui, key, draft)
    if (slash !== undefined) return slash
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

const COMMAND = /^\/[a-z][a-z0-9-]*(\s|$)/

/** Enter in the text field: the "Something else…" answer, or a message (an interjection while the driver works). */
export const onSubmit = (ui: Ui, s: SessionState, text: string): { readonly ui: Ui; readonly action?: Action; readonly draft?: string } => {
  if (text.trim().length === 0) return { ui }
  const inquiry = s.thread.pendingInquiry
  // A command is "/name" as the first word (or a bare "/" with a row highlighted); a path ("/api/v2 …")
  // or an answer to "Something else…" is text.
  const t = text.trim()
  if (!(ui.other && inquiry !== undefined) && (COMMAND.test(t) || t === "/")) {
    // An invalid command stays in the input; the box shows why.
    if (lintSlashInput(t) !== null) return { ui }
    const state = parseSlashInput(t)
    const sel = ui.slash?.sel ?? null
    // The highlighted row, else the command the next Tab would pick, else what was typed.
    const chosen =
      state?.mode === "command"
        ? (state.matches[sel ?? 0]?.cmd ?? t)
        : state?.mode === "arg" && sel !== null && state.candidates[sel] !== undefined
          ? `${state.command.cmd} ${state.candidates[sel]}`
          : t
    const command = SLASH_COMMANDS.find((c) => c.cmd === chosen.split(/\s+/)[0])
    if (command?.arg.required && chosen === command.cmd) return { ui: withoutSlash(ui), draft: `${command.cmd} ` }
    if (t === "/" && state === null) return { ui }
    return { ui: withoutSlash(ui), action: { type: "command", text: chosen } }
  }
  if (ui.other && inquiry !== undefined) {
    if (ui.answered === inquiry.id) return { ui }
    return { ui: { ...ui, other: false, answered: inquiry.id }, action: { type: "answer", answer: { other: text } } }
  }
  return { ui, action: { type: "send", text } }
}

/** The text field takes keys unless the picker is choosing. */
export const inputFocused = (ui: Ui, s: SessionState) => ui.focus === "conversation" && (s.thread.pendingInquiry === undefined || ui.other)
