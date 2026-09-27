import { type Answer, type Inquiry, type Prompt, type RlmNode, type SessionState, zargConversation } from "@zarg/client"
import { CHAT, type ConversationQuestion, conversationRows, OTHER, startUi, type ViewUi } from "@zarg/view"
import { lintSlashInput, parseSlashInput, SLASH_COMMANDS, type SlashCycle, type SlashInputState, stepCompletion } from "./commands"

/** Where the keys go: the agents list, the tile area (the open agent's view, or zarg's sheet), or the message bar. */
export type Focus = "agents" | "tile" | "bar"

/** UI-only state: what is focused and selected. Everything else comes from the session. */
export interface Ui {
  readonly focus: Focus
  /** zarg's sheet covers the tile area (it also shows while no agent is open). */
  readonly sheet: boolean
  /** The selected picker row. */
  readonly pick: number
  /** The inquiry `pick` belongs to; a new inquiry resets the selection. */
  readonly inquiryId?: string
  /** True while "Something else…" is highlighted: the bar takes the typing. */
  readonly other: boolean
  /** The inquiry the developer is chatting about (Chat about this): the bar takes the typing, the options wait. */
  readonly chatting?: string
  /** The inquiry already answered: further Enters wait for the core to move on. */
  readonly answered?: string
  /** The slash-command box: the highlighted row and the Tab cycle. */
  readonly slash?: { readonly sel: number | null; readonly cycle: SlashCycle | null }
  /** When Ctrl-C was last pressed (ms); a second press within `EXIT_WINDOW_MS` exits. */
  readonly lastCtrlC?: number
  /** When the thread started running (ms), for the working indicator; unset while it waits or idles. */
  readonly runningSince?: number
  /** The agents list: the highlighted agent and the nodes opened or closed against their default. */
  readonly agents: Agents
  /** The agent open in the tile area (Enter or a click on it); Escape closes it. */
  readonly viewing?: string
  /** In the open agent's view: the focused section, tabs, row cursors and selections. */
  readonly view?: ViewUi
  /** The agent `g` went to last: the next `g` goes on from it. */
  readonly attentionAt?: string
  /** The popover queue's head (the core keeps the queue, strictly first in first out) and its highlighted option. */
  readonly popover: { readonly id?: string; readonly pick: number }
  /** Agents the developer opened since they asked, by the `since` of the attention they saw. */
  readonly seen: Readonly<Record<string, number>>
  /** zarg's last reply the developer has seen; newer ones preview in the bar. */
  readonly readUpTo?: string
}

export interface Agents {
  readonly cursor?: string
  readonly toggled: Readonly<Record<string, boolean>>
  /** The tree these belong to (`ThreadState.trees`); a fresh tree starts over, since RLM ids repeat. */
  readonly tree?: number
}

export const EXIT_WINDOW_MS = 2000
export { CHAT, OTHER }

export const initialUi: Ui = { focus: "bar", sheet: false, pick: 0, other: false, agents: { toggled: {}, tree: 0 }, popover: { pick: 0 }, seen: {} }

export interface PickerRow {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly recommended: boolean
  readonly selected: boolean
}

/** The inquiry's options, "Something else…" when free text is allowed, and "Chat about this". */
// The picker is the conversation section's behaviour (@zarg/view), on zarg's question.
export const pickerRows = (inquiry: Inquiry, pick: number): ReadonlyArray<PickerRow> => conversationRows(questionOf(inquiry), { pick, other: false })
const questionOf = (i: Inquiry): ConversationQuestion => ({
  id: i.id,
  question: i.question,
  options: i.options.map((o) => ({ id: o.id, label: o.label, ...(o.why !== undefined ? { why: o.why } : {}), ...(o.recommended === true ? { recommended: true } : {}) })),
  allowOther: i.allowOther,
  ...(i.otherLabel !== undefined ? { otherLabel: i.otherLabel } : {}),
  ...(i.kind !== undefined ? { kind: i.kind } : {}),
})

export const preselect = (inquiry: Inquiry) => Math.max(0, inquiry.options.findIndex((o) => o.recommended === true))

/** A new inquiry preselects its recommended option (or the first); a new popover its recommended option; a shown sheet reads zarg's replies. */
export const syncUi = (ui0: Ui, s: SessionState, now = Date.now()): Ui => {
  const ui = withPopover(withRead(withRunClock(ui0.agents.tree === s.thread.trees ? ui0 : { ...ui0, agents: { toggled: {}, tree: s.thread.trees } }, s, now), s), s)
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

const lastReply = (s: SessionState) => s.thread.messages.filter((m) => m.role === "assistant").at(-1)
const withRead = (ui: Ui, s: SessionState): Ui => {
  const last = lastReply(s)?.id
  return sheetShown(ui) && last !== undefined && last !== ui.readUpTo ? { ...ui, readUpTo: last } : ui
}
const withPopover = (ui: Ui, s: SessionState): Ui => {
  const head = queueOf(ui, s)[0]
  if (head === undefined) return ui.popover.id === undefined ? ui : { ...ui, popover: { pick: 0 } }
  if (head.id === ui.popover.id) return ui
  return { ...ui, popover: { id: head.id, pick: Math.max(0, head.options.findIndex((o) => o.recommended === true)) } }
}

const question = (s: SessionState) => s.thread.pendingInquiry
/** zarg's sheet covers the tile area: opened, or no agent is open. */
export const sheetShown = (ui: Ui) => ui.sheet || ui.viewing === undefined
/** Typing "Something else…" in the bar: the highlighted row is the free-text one. */
export const answeringOther = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return q !== undefined && ui.other && ui.chatting !== q.id && ui.answered !== q.id
}
/** The bar takes text: it has focus, and nothing is asked, or the developer chats about the question or types their own answer. */
export const typing = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return ui.focus === "bar" && (q === undefined || ui.chatting === q.id || answeringOther(ui, s))
}
/** The shared popover queue, in the order the core asked: nothing on the client reorders it. */
export const queueOf = (_ui: Ui, s: SessionState): ReadonlyArray<Prompt> => s.thread.prompts ?? []
/** The bar's input has the keys: it takes text and no popover is up. */
export const inputFocused = (ui: Ui, s: SessionState) => typing(ui, s) && queueOf(ui, s).length === 0
/** The bar takes focus; while zarg asks, the sheet opens with the question. */
export const focusBar = (ui: Ui, s: SessionState): Ui => ({ ...ui, focus: "bar", sheet: ui.sheet || question(s) !== undefined })
const seenNow = (ui: Ui, s: SessionState, id: string): Ui => {
  const since = s.thread.rlms[id]?.attention?.since
  return since === undefined ? ui : { ...ui, seen: { ...ui.seen, [id]: since } }
}
/** Open an agent: zarg's sheet for zarg, the agent's view otherwise; either way its attention counts as seen. */
export const openAgent = (ui: Ui, s: SessionState, id: string): Ui => {
  const at = seenNow({ ...ui, agents: { ...ui.agents, cursor: id } }, s, id)
  if (id === "zarg") return { ...at, sheet: true, focus: "tile" }
  const { view: _, ...rest } = at
  return { ...rest, viewing: id, sheet: false, focus: "tile" }
}

// The thread's status is stale once the core is down: nothing is working then.
const busy = (s: SessionState) => s.core === "up" && s.thread.status === "running" && s.thread.pendingInquiry === undefined

/** Whether anything on screen animates: the driver working, or agents running while no question waits. */
export const animating = (ui: Ui, s: SessionState) =>
  ui.runningSince !== undefined ||
  // zarg's own row is always there: only agents doing work keep the clock ticking.
  (s.core === "up" && s.thread.pendingInquiry === undefined && Object.values(s.thread.rlms).some((r) => r.status === "running" && r.preset !== "zarg"))

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
  const root = driverRoot(s.thread.rlms)
  const turn = root !== undefined ? ` · turn ${root.turns}/${root.budget}` : ""
  return `${spin(now)} zarg is preparing a reply · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${turn}`
}

export interface Line {
  readonly kind: "you" | "zarg" | "error" | "notice"
  readonly text: string
}

/** zarg's conversation: its section's messages, then the run error and any transport notice. */
export const conversation = (s: SessionState): ReadonlyArray<Line> => [
  ...(zargConversation(s.thread).data.talk as { messages: ReadonlyArray<{ role: string; text: string }> }).messages.map((m): Line => ({ kind: m.role === "user" ? "you" : "zarg", text: m.text })),
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
  /** The agent asks for the developer (◆, its reason in place of its progress). */
  readonly attention: boolean
}

const ICON: Record<RlmNode["status"], string> = { running: "●", done: "✓", failed: "✗", stopped: "■" }
const BAR = 6

// Children in id order; a node whose parent is unknown is a root.
const childrenOf = (rlms: Readonly<Record<string, RlmNode>>) => {
  const nodes = Object.values(rlms).sort((a, b) => idNumber(a.id) - idNumber(b.id))
  return (parent: string | null) => nodes.filter((n) => (parent === null ? n.parent === null || rlms[n.parent] === undefined : n.parent === parent))
}

/** The driver's RLM: the first child of zarg's row, or the first root when zarg has no row. */
const driverRoot = (rlms: Readonly<Record<string, RlmNode>>): RlmNode | undefined => {
  const children = childrenOf(rlms)
  const zarg = children(null).find((n) => n.preset === "zarg")
  return zarg !== undefined ? (children(zarg.id)[0] ?? undefined) : children(null)[0]
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
    // zarg's row does not spin: it is there all session, working or not.
    const icon = r.node.attention !== undefined ? "◆" : r.node.status === "running" && now !== undefined && r.node.preset !== "zarg" ? spin(now) : ICON[r.node.status]
    const l = `${r.prefix} ${icon} ${r.node.preset} ${r.node.id}`
    return l.length > room ? `${l.slice(0, room - 1)}…` : l
  })
  const width = Math.max(0, ...lefts.map((l) => l.length))
  return rows.map((r, i) => {
    const n = r.node
    // An agent may draw its own row: its progress, its text; otherwise turns out of the budget.
    const done = n.row?.progress?.done ?? n.turns
    const total = n.row?.progress?.total ?? n.budget
    const filled = Math.min(BAR, Math.round((done / Math.max(1, total)) * BAR))
    const bar = "▰".repeat(filled) + "▱".repeat(BAR - filled)
    const hidden = r.hidden.length > 0 ? `  +${r.hidden.length}` : ""
    // A reason gets the room left of the row, and is cut there.
    const room = Math.max(4, cols - width - 2 - BAR - 1 - hidden.length)
    const reason = n.attention?.reason
    const count = reason !== undefined ? (reason.length > room ? `${reason.slice(0, room - 1)}…` : reason) : (n.row?.text ?? `${done}/${total}`.padStart(5))
    return {
      id: n.id,
      text: `${lefts[i]!.padEnd(width)}  ${bar} ${count}${hidden}`,
      tone: r.hidden.some((h) => h.status === "failed") ? "failed" : n.status,
      selected: n.id === cursor,
      attention: n.attention !== undefined,
    }
  })
}

/** The agents asking for the developer, in tree order, zarg first. */
export const attentionOf = (rlms: Readonly<Record<string, RlmNode>>): ReadonlyArray<{ readonly id: string; readonly reason: string }> => {
  const children = childrenOf(rlms)
  const order: Array<RlmNode> = []
  const visit = (n: RlmNode) => {
    order.push(n)
    children(n.id).forEach(visit)
  }
  const roots = children(null)
  ;[...roots.filter((r) => r.id === "zarg"), ...roots.filter((r) => r.id !== "zarg")].forEach(visit)
  return order.flatMap((n) => (n.attention !== undefined ? [{ id: n.id, reason: n.attention.reason }] : []))
}

/** The status line's attention: the first two agents asking, with their reasons. */
export const attentionLine = (rlms: Readonly<Record<string, RlmNode>>) =>
  attentionOf(rlms)
    .slice(0, 2)
    .map((a) => `◆ ${a.id}: ${a.reason}`)
    .join("   ")

/** The card for the highlighted RLM (the first root when none): status, task, turns, decisions, error. */
export const agentDetail = (rlms: Readonly<Record<string, RlmNode>>, cursor: string | undefined): ReadonlyArray<string> => {
  const n = (cursor !== undefined ? rlms[cursor] : undefined) ?? driverRoot(rlms)
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

/** Enter on an agent, or a click: its hidden children open first; an open or childless agent opens. */
export const activate = (ui: Ui, s: SessionState, id: string): Ui => {
  const rlms = s.thread.rlms
  const n = rlms[id]
  if (n !== undefined && childrenOf(rlms)(id).length > 0 && !isOpen(rlms, ui.agents, n)) {
    return { ...ui, agents: { ...ui.agents, cursor: id, toggled: { ...ui.agents.toggled, [id]: true } } }
  }
  return openAgent(ui, s, id)
}

/** Arrows and Enter on the agents list: move the highlight, open and close nodes, jump to the parent. */
export const onAgentsKey = (ui: Ui, s: SessionState, key: Key): Ui => {
  const rlms = s.thread.rlms
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
  if (key.name === "return") return activate(ui, s, n.id)
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
  readonly shift?: boolean
  readonly meta?: boolean
}

export type Action =
  | { readonly type: "answer"; readonly answer: Answer }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "command"; readonly text: string }
  | { readonly type: "stop" }
  /** An action on rows of a table in the open agent's view. */
  | { readonly type: "act"; readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> }
  /** Answer a question in the open agent's conversation. */
  | { readonly type: "answer-agent"; readonly question: string; readonly answer: { readonly choice?: string; readonly other?: string } }
  /** Scroll the open agent's focused section by lines. */
  | { readonly type: "scroll"; readonly delta: number }
  /** Scroll zarg's sheet by lines. */
  | { readonly type: "scroll-talk"; readonly delta: number }
  /** Answer the popover at the head of the queue (a grant). */
  | { readonly type: "answer-prompt"; readonly id: string; readonly choice: string }
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
export const onSlashKey = (ui: Ui, key: Key, draft: string): { readonly ui: Ui; readonly draft?: string } | undefined => {
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

/** Keys on zarg's question: arrows pick, Enter answers or moves the typing to the bar (Something else…, Chat about this). */
export const pickerKey = (ui: Ui, s: SessionState, key: Key): { readonly ui: Ui; readonly action?: Action } | "pass" => {
  const inquiry = s.thread.pendingInquiry
  if (inquiry === undefined) return "pass"
  const rows = pickerRows(inquiry, ui.pick)
  const moveTo = (pick: number): Ui => ({ ...ui, pick, other: rows[pick]?.id === OTHER })
  if (key.name === "up") return { ui: moveTo(Math.max(0, ui.pick - 1)) }
  if (key.name === "down") return { ui: moveTo(Math.min(rows.length - 1, ui.pick + 1)) }
  if (key.name === "escape" && ui.other) return { ui: moveTo(preselect(inquiry)) }
  if (key.name === "return") {
    const row = rows[ui.pick]
    if (row === undefined) return { ui }
    // Something else… is typed in the bar and answers from there (onSubmit).
    if (row.id === OTHER) return { ui: { ...ui, other: true, focus: "bar" } }
    if (row.id === CHAT) return { ui: { ...ui, other: false, chatting: inquiry.id, focus: "bar" } }
    return { ui: { ...ui, answered: inquiry.id }, action: { type: "answer", answer: { choice: row.id } } }
  }
  return "pass"
}

const COMMAND = /^\/[a-z][a-z0-9-]*(\s|$)/

/** Enter in the text field: the "Something else…" answer, or a message (an interjection while the driver works). */
export const onSubmit = (ui: Ui, s: SessionState, text: string): { readonly ui: Ui; readonly action?: Action; readonly draft?: string } => {
  if (text.trim().length === 0) return { ui }
  const inquiry = s.thread.pendingInquiry
  // A command is "/name" as the first word (or a bare "/" with a row highlighted); a path ("/api/v2 …")
  // or an answer to "Something else…" is text.
  const t = text.trim()
  const answering = inquiry !== undefined && ui.other && ui.chatting !== inquiry.id
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
  // A message; while chatting about a question, the core takes it as discussion of that question. The sheet opens for the reply.
  return { ui: { ...ui, sheet: true }, action: { type: "send", text } }
}

/** Slash commands work in the bar, never while typing an answer to Something else… (that is text). */
export const slashActive = (ui: Ui, s: SessionState) => typing(ui, s) && !answeringOther(ui, s)
