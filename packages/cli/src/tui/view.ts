import type { Answer, Inquiry, RlmNode, SessionState } from "@zarg/client"
import { lintSlashInput, parseSlashInput, SLASH_COMMANDS, type SlashCycle, type SlashInputState, stepCompletion } from "./commands"

/** UI-only state: what is focused and selected. Everything else comes from the session. */
export interface Ui {
  readonly focus: "conversation" | "agents"
  /** The selected picker row. */
  readonly pick: number
  /** The inquiry `pick` belongs to; a new inquiry resets the selection. */
  readonly inquiryId?: string
  /** True while "Something else…" is highlighted: its input line in the picker takes the typing. */
  readonly other: boolean
  /** The inquiry the developer is chatting about (Chat about this): the Message box is back, the picker hidden. */
  readonly chatting?: string
  /** The inquiry already answered: further Enters wait for the core to move on. */
  readonly answered?: string
  /** The slash-command box: the highlighted row and the Tab cycle. */
  readonly slash?: { readonly sel: number | null; readonly cycle: SlashCycle | null }
  /** When Ctrl-C was last pressed (ms); a second press within `EXIT_WINDOW_MS` exits. */
  readonly lastCtrlC?: number
  /** When the thread started running (ms), for the working indicator; unset while it waits or idles. */
  readonly runningSince?: number
  /** The agents pane: the highlighted RLM and the nodes opened or closed against their default. */
  readonly agents: Agents
  /** The agent whose history replaces the conversation (Enter or a click on it); Escape closes it. */
  readonly viewing?: string
}

export interface Agents {
  readonly cursor?: string
  readonly toggled: Readonly<Record<string, boolean>>
  /** The tree these belong to (`ThreadState.trees`); a fresh tree starts over, since RLM ids repeat. */
  readonly tree?: number
}

export const EXIT_WINDOW_MS = 2000
export const OTHER = "__other"
export const CHAT = "__chat"

export const initialUi: Ui = { focus: "conversation", pick: 0, other: false, agents: { toggled: {}, tree: 0 } }

export interface PickerRow {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly recommended: boolean
  readonly selected: boolean
}

/** The inquiry's options, "Something else…" when free text is allowed, and "Chat about this". */
export const pickerRows = (inquiry: Inquiry, pick: number): ReadonlyArray<PickerRow> => {
  const rows = [
    ...inquiry.options.map((o) => ({ id: o.id, label: o.label, ...(o.why !== undefined ? { why: o.why } : {}), recommended: o.recommended === true })),
    ...(inquiry.allowOther ? [{ id: OTHER, label: `${inquiry.otherLabel ?? "Something else"}…`, recommended: false }] : []),
    { id: CHAT, label: "Chat about this", recommended: false },
  ]
  return rows.map((r, i) => ({ ...r, selected: i === pick }))
}

const preselect = (inquiry: Inquiry) => Math.max(0, inquiry.options.findIndex((o) => o.recommended === true))

/** A new inquiry preselects its recommended option (or the first). */
export const syncUi = (ui0: Ui, s: SessionState, now = Date.now()): Ui => {
  const ui = withRunClock(ui0.agents.tree === s.thread.trees ? ui0 : { ...ui0, agents: { toggled: {}, tree: s.thread.trees } }, s, now)
  const inquiry = s.thread.pendingInquiry
  if (inquiry === undefined) {
    if (ui.inquiryId === undefined && !ui.other && ui.chatting === undefined) return ui
    const { inquiryId: _, chatting: __, ...rest } = ui
    return { ...rest, other: false }
  }
  if (inquiry.id === ui.inquiryId) return ui
  const { chatting: _, ...rest } = ui
  return { ...rest, inquiryId: inquiry.id, pick: preselect(inquiry), other: false }
}

// The thread's status is stale once the core is down: nothing is working then.
const busy = (s: SessionState) => s.core === "up" && s.thread.status === "running" && s.thread.pendingInquiry === undefined

/** Whether anything on screen animates: the driver working, or agents running while no question waits. */
export const animating = (ui: Ui, s: SessionState) =>
  ui.runningSince !== undefined ||
  (s.core === "up" && s.thread.pendingInquiry === undefined && Object.values(s.thread.rlms).some((r) => r.status === "running"))

const withRunClock = (ui: Ui, s: SessionState, now: number): Ui => {
  if (busy(s)) return ui.runningSince === undefined ? { ...ui, runningSince: now } : ui
  if (ui.runningSince === undefined) return ui
  const { runningSince: _, ...rest } = ui
  return rest
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const spin = (now: number) => SPINNER[Math.floor(now / 100) % SPINNER.length]!

/** The line under the conversation while zarg works on a reply or a question: spinner, elapsed time, driver turn. */
export const working = (ui: Ui, s: SessionState, now: number): string | undefined => {
  if (!busy(s) || ui.runningSince === undefined) return undefined
  const secs = Math.max(0, Math.floor((now - ui.runningSince) / 1000))
  const root = childrenOf(s.thread.rlms)(null)[0]
  const turn = root !== undefined ? ` · turn ${root.turns}/${root.budget}` : ""
  return `${spin(now)} zarg is preparing a reply · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${turn}`
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

const idNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0)

export interface AgentRow {
  readonly id: string
  readonly text: string
  /** The node's status, or "failed" when a collapsed node hides a failure. */
  readonly tone: RlmNode["status"]
  readonly selected: boolean
}

const ICON: Record<RlmNode["status"], string> = { running: "●", done: "✓", failed: "✗", stopped: "■" }
const BAR = 6

// Children in id order; a node whose parent is unknown is a root.
const childrenOf = (rlms: Readonly<Record<string, RlmNode>>) => {
  const nodes = Object.values(rlms).sort((a, b) => idNumber(a.id) - idNumber(b.id))
  return (parent: string | null) => nodes.filter((n) => (parent === null ? n.parent === null || rlms[n.parent] === undefined : n.parent === parent))
}

// Roots start open, everything below starts collapsed; `toggled` flips that per id.
const isOpen = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents, n: RlmNode) =>
  agents.toggled[n.id] ?? (n.parent === null || rlms[n.parent] === undefined)

interface Visible {
  readonly node: RlmNode
  readonly prefix: string
  readonly hidden: ReadonlyArray<RlmNode>
}

const visible = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents): ReadonlyArray<Visible> => {
  const children = childrenOf(rlms)
  const below = (n: RlmNode): Array<RlmNode> => children(n.id).flatMap((c) => [c, ...below(c)])
  const out: Array<Visible> = []
  const visit = (n: RlmNode, indent: string, last: boolean, root: boolean) => {
    const kids = children(n.id)
    const open = isOpen(rlms, agents, n)
    const mark = kids.length > 0 ? (open ? "▾" : "▸") : last ? "└" : "├"
    out.push({ node: n, prefix: `${indent}${mark}`, hidden: open ? [] : below(n) })
    if (!open) return
    const next = root ? `${indent}  ` : `${indent}${last ? " " : "│"} `
    kids.forEach((c, i) => visit(c, next, i === kids.length - 1, false))
  }
  const roots = children(null)
  roots.forEach((r, i) => visit(r, "", i === roots.length - 1, true))
  return out
}

// The highlighted RLM: the cursor while its RLM exists, else the first root.
const cursorOf = (rows: ReadonlyArray<Visible>, agents: Agents) =>
  rows.some((r) => r.node.id === agents.cursor) ? agents.cursor : rows[0]?.node.id

/** The agents tree: one line per visible RLM with its status icon, turn bar and how many descendants it hides. */
export const agentRows = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents, cols = 46, now?: number): ReadonlyArray<AgentRow> => {
  const rows = visible(rlms, agents)
  const cursor = cursorOf(rows, agents)
  const hiddenWidth = Math.max(0, ...rows.map((r) => (r.hidden.length > 0 ? `  +${r.hidden.length}`.length : 0)))
  // The left column gives way to the bar, the turns and the hidden count: a long id is cut, never wrapped.
  const room = Math.max(8, cols - (2 + BAR + 1 + 5) - hiddenWidth)
  const lefts = rows.map((r) => {
    const icon = r.node.status === "running" && now !== undefined ? spin(now) : ICON[r.node.status]
    const l = `${r.prefix} ${icon} ${r.node.preset} ${r.node.id}`
    return l.length > room ? `${l.slice(0, room - 1)}…` : l
  })
  const width = Math.max(0, ...lefts.map((l) => l.length))
  return rows.map((r, i) => {
    const n = r.node
    const filled = Math.min(BAR, Math.round((n.turns / Math.max(1, n.budget)) * BAR))
    const bar = "▰".repeat(filled) + "▱".repeat(BAR - filled)
    const hidden = r.hidden.length > 0 ? `  +${r.hidden.length}` : ""
    return {
      id: n.id,
      text: `${lefts[i]!.padEnd(width)}  ${bar} ${`${n.turns}/${n.budget}`.padStart(5)}${hidden}`,
      tone: r.hidden.some((h) => h.status === "failed") ? "failed" : n.status,
      selected: n.id === cursor,
    }
  })
}

/** The card for the highlighted RLM (the first root when none): status, task, turns, decisions, error. */
export const agentDetail = (rlms: Readonly<Record<string, RlmNode>>, cursor: string | undefined): ReadonlyArray<string> => {
  const n = (cursor !== undefined ? rlms[cursor] : undefined) ?? childrenOf(rlms)(null)[0]
  if (n === undefined) return []
  const task = n.task?.split("\n")[0]
  return [
    `${n.preset} ${n.id} · ${n.status}`,
    ...(task !== undefined ? [`task  ${task}`] : []),
    `turn ${n.turns} of ${n.budget}${n.tokens !== undefined ? ` · ${n.tokens.toLocaleString("en-US")} tokens` : ""}`,
    ...n.decisions.flatMap((d) =>
      d.kind === "extend"
        ? [`${(d.extended ? `extended to ${d.turns} turns` : "told to wrap up").padEnd(22)}${d.confidence.toFixed(2)}  ${d.reason}`]
        : [
            d.atomic ? "atomic (runs directly)" : "plan (splits into children)",
            ...d.criteria.map((c) => `  ${c.name.padEnd(16)}${(c.answer ? "yes" : "no").padEnd(5)}${c.confidence.toFixed(2)}`),
          ],
    ),
    ...(n.error !== undefined ? [`error  ${n.error}`] : []),
  ]
}

/** Open an agent's history (Enter on it, or a click); it also becomes the highlighted agent. */
export const openHistory = (ui: Ui, id: string): Ui => ({ ...ui, viewing: id, agents: { ...ui.agents, cursor: id } })

export interface HistoryLine {
  readonly kind: "zarg" | "dim" | "error" | "accent"
  readonly text: string
}

const HISTORY_CODE_LINES = 8
const HISTORY_OUTPUT_LINES = 6
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const firstLines = (text: string, n: number) => {
  const all = text.split("\n")
  return all.length > n ? [...all.slice(0, n), `… ${all.length - n} more lines`] : all
}

/** An agent's transcript lines (from the core) as what the history view shows. */
export const historyView = (lines: ReadonlyArray<Record<string, any>>): ReadonlyArray<HistoryLine> =>
  lines.flatMap((l): ReadonlyArray<HistoryLine> => {
    switch (l.type) {
      case "start":
        return [{ kind: "zarg", text: `${l.preset} ${l.rlm}: ${String(l.task ?? "").split("\n")[0]}` }]
      case "model":
        return [{ kind: "accent", text: `turn ${l.turn} · model ${(Number(l.modelMs) / 1000).toFixed(1)}s · ${Number(l.promptTokens).toLocaleString("en-US")} → ${Number(l.completionTokens).toLocaleString("en-US")} tokens` }]
      case "call": {
        const head = `  ${l.service}.${l.method} ${clip(JSON.stringify(l.params), 120)}  ${l.ms}ms`
        return [l.ok ? { kind: "dim", text: head } : { kind: "error", text: `${head}  failed: ${l.failure?._tag}: ${clip(String(l.failure?.message ?? ""), 120)}` }]
      }
      case "step":
        return [
          ...(String(l.text ?? "").trim().length > 0 ? [{ kind: "zarg" as const, text: `  ${clip(String(l.text).trim().replaceAll("\n", " "), 300)}` }] : []),
          ...(l.cells ?? []).flatMap((c: { code: string; ok: boolean; output: string; ms: number }) => [
            { kind: c.ok ? ("dim" as const) : ("error" as const), text: `  cell ${c.ok ? "ok" : "failed"} ${c.ms}ms` },
            ...firstLines(c.code, HISTORY_CODE_LINES).map((t) => ({ kind: "dim" as const, text: `    │ ${t}` })),
            ...firstLines(c.output, HISTORY_OUTPUT_LINES).filter((t) => t.length > 0).map((t) => ({ kind: c.ok ? ("zarg" as const) : ("error" as const), text: `    → ${t}` })),
          ]),
        ]
      case "atomize":
        return [{ kind: "accent", text: l.atomic ? "atomic (runs directly)" : "plan (splits into children)" }]
      case "plan":
        return [{ kind: "accent", text: `plan: ${(l.children ?? []).map((c: { id: string; preset: string }) => `${c.id} (${c.preset})`).join(", ")}` }]
      case "extend":
        return [{ kind: "accent", text: `${(l.extended ? `extended to ${l.turns} turns` : "told to wrap up").padEnd(15)}  ${Number(l.confidence).toFixed(2)}  ${l.reason}` }]
      default:
        return []
    }
  })

/** Enter on an agent, or a click: its hidden children open first; an open or childless agent shows its history. */
export const activate = (ui: Ui, rlms: Readonly<Record<string, RlmNode>>, id: string): Ui => {
  const n = rlms[id]
  if (n !== undefined && childrenOf(rlms)(id).length > 0 && !isOpen(rlms, ui.agents, n)) {
    return { ...ui, agents: { ...ui.agents, cursor: id, toggled: { ...ui.agents.toggled, [id]: true } } }
  }
  return openHistory(ui, id)
}

/** Arrows and Enter on the agents pane: move the highlight, open and close nodes, jump to the parent. */
const onAgentsKey = (ui: Ui, rlms: Readonly<Record<string, RlmNode>>, key: Key): Ui => {
  const rows = visible(rlms, ui.agents)
  const cursor = cursorOf(rows, ui.agents)
  const at = rows.findIndex((r) => r.node.id === cursor)
  const row = rows[at]
  if (row === undefined) return ui
  const n = row.node
  const move = (id: string | undefined): Ui => (id === undefined ? ui : { ...ui, agents: { ...ui.agents, cursor: id } })
  const set = (open: boolean): Ui => ({ ...ui, agents: { ...ui.agents, cursor: n.id, toggled: { ...ui.agents.toggled, [n.id]: open } } })
  const hasKids = childrenOf(rlms)(n.id).length > 0
  const open = isOpen(rlms, ui.agents, n)
  if (key.name === "down") return move(rows[Math.min(rows.length - 1, at + 1)]?.node.id)
  if (key.name === "up") return move(rows[Math.max(0, at - 1)]?.node.id)
  if (key.name === "return") return activate(ui, rlms, n.id)
  if (key.name === "right") return hasKids && !open ? set(true) : ui
  if (key.name === "left") return hasKids && open ? set(false) : n.parent !== null && rlms[n.parent] !== undefined ? move(n.parent) : ui
  return ui
}

export interface Meta {
  readonly threadId: string
  readonly driver?: string
  readonly mode: "child" | "headless"
}

/** Most important first, so a narrow terminal cuts the driver model, never the core state. */
export const statusLine = (s: SessionState, meta: Meta) =>
  [
    s.core === "down" ? "core stopped" : `core ${meta.mode}`,
    // Right after the core state: a narrow terminal cuts from the end, and YOLO must stay visible.
    ...(s.thread.yolo === true ? ["YOLO"] : []),
    s.thread.status,
    `thread ${meta.threadId}`,
    meta.driver ?? "driver model unknown",
  ].join(" · ")

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
  // An agent's history is open: Escape goes back to the conversation; other keys wait.
  if (ui.viewing !== undefined) {
    if (key.name === "escape") {
      const { viewing: _, ...rest } = ui
      return { ui: { ...rest, focus: "conversation" } }
    }
    // A question on screen still takes its keys (arrows, Enter); anything else waits for Escape.
    if (s.thread.pendingInquiry === undefined) return { ui }
    ui = { ...ui, focus: "conversation" }
  }
  if (draft !== undefined && slashActive(ui, s)) {
    const slash = onSlashKey(ui, key, draft)
    if (slash !== undefined) return slash
  }
  if (key.name === "tab") return { ui: { ...ui, focus: ui.focus === "conversation" ? "agents" : "conversation" } }
  if (ui.focus === "agents") return { ui: onAgentsKey(ui, s.thread.rlms, key) }
  const inquiry = s.thread.pendingInquiry
  // The picker takes keys only while the conversation side has focus.
  if (inquiry === undefined || ui.focus !== "conversation" || ui.answered === inquiry.id) return { ui }
  // Chatting: the Message box has the keys; Escape goes back to the picker.
  if (ui.chatting === inquiry.id) {
    if (key.name !== "escape") return { ui }
    const { chatting: _, ...rest } = ui
    return { ui: rest }
  }
  const rows = pickerRows(inquiry, ui.pick)
  const moveTo = (pick: number): Ui => ({ ...ui, pick, other: rows[pick]?.id === OTHER })
  if (key.name === "up") return { ui: moveTo(Math.max(0, ui.pick - 1)) }
  if (key.name === "down") return { ui: moveTo(Math.min(rows.length - 1, ui.pick + 1)) }
  if (key.name === "escape" && ui.other) return { ui: moveTo(preselect(inquiry)) }
  if (key.name === "return") {
    const row = rows[ui.pick]
    // Something else… answers from its own input line (onSubmit).
    if (row === undefined || row.id === OTHER) return { ui }
    if (row.id === CHAT) return { ui: { ...ui, other: false, chatting: inquiry.id } }
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
  const answering = ui.other && inquiry !== undefined && ui.chatting !== inquiry.id
  if (!answering && (COMMAND.test(t) || t === "/")) {
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
  if (answering) {
    if (ui.answered === inquiry.id) return { ui }
    return { ui: { ...ui, other: false, answered: inquiry.id }, action: { type: "answer", answer: { other: text } } }
  }
  // A message; while chatting about a question, the core takes it as discussion of that question.
  return { ui, action: { type: "send", text } }
}

/** Slash commands work in the Message box, never in the picker's Something else… line (that is text). */
export const slashActive = (ui: Ui, s: SessionState) => inputFocused(ui, s)

/** The Message box: shown when no question is up, or while chatting about the one that is. */
export const messageShown = (ui: Ui, s: SessionState) => s.thread.pendingInquiry === undefined || ui.chatting === s.thread.pendingInquiry.id

/** The Message box takes keys when it is shown and the conversation side has focus. */
export const inputFocused = (ui: Ui, s: SessionState) => ui.focus === "conversation" && messageShown(ui, s)

/** The picker's Something else… line takes keys while it is highlighted. */
export const otherFocused = (ui: Ui, s: SessionState) =>
  ui.focus === "conversation" && ui.other && s.thread.pendingInquiry !== undefined && !messageShown(ui, s) && ui.answered !== s.thread.pendingInquiry.id
