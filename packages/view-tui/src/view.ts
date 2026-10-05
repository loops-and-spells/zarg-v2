import { type Answer, type Inquiry, type Panel, type Prompt, type RlmNode, type SessionState, zargConversation } from "@zarg/client"
import { CHAT, type ConversationQuestion, conversationRows, OTHER, startUi, type ViewUi } from "@zarg/view"
import { lintSlashInput, parseSlashInput, SLASH_COMMANDS, type SlashCycle, type SlashInputState, stepCompletion } from "./commands"

/** Where the keys go: the agents list, the tile area (the open agent's view, or a sheet), the message bar, or a panel. */
export type Focus = "agents" | "tile" | "bar" | "panel"
/** What the focus area shows: the grid of agents (home), one agent's view, zarg's conversation, the review queue. */
export type Main = "grid" | "agent" | "zarg" | "review" | "inbox"

/** UI-only state: what is focused and selected. Everything else comes from the session. */
export interface Ui {
  readonly focus: Focus
  /** zarg's sheet covers the tile area (it also shows while no agent is open). */
  readonly sheet: boolean
  /** What the focus area shows ("agent": the one `viewing` names). */
  readonly main: Main
  /** Where Esc and ⇥ go back to. */
  readonly back: ReadonlyArray<{ readonly main: Main; readonly viewing?: string; readonly sheet?: boolean }>
  /** The arrival rule ran (the sheet opened or not by whether agents work). */
  readonly arrived: boolean
  /** The grid's highlighted card (its page follows from it). */
  readonly grid: { readonly cursor: number; readonly id?: string }
  /** The review queue: the highlighted row (over every group) and the selected rows' keys. */
  readonly review: { readonly cursor: number; readonly selected: ReadonlyArray<string> }
  /** ^k: the query typed and the highlighted entry, while the palette is open. */
  readonly palette?: { readonly query: string; readonly pick: number }
  /** The selected picker row. */
  readonly pick: number
  /** The inquiry `pick` belongs to; a new inquiry resets the selection. */
  readonly inquiryId?: string
  /** True while "Something else…" is highlighted: the bar takes the typing. */
  readonly other: boolean
  /** The inquiry the operator is chatting about (Chat about this): the bar takes the typing, the options wait. */
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
  readonly popover: {
    readonly id?: string
    readonly pick: number
    /** When the head showed (ms): Enter waits `POPOVER_GUARD_MS`, so a fast double Enter never answers the next one unread. */
    readonly since?: number
    /** The head already answered: its done event is on its way, a second Enter sends nothing. */
    readonly answering?: string
    /** A plugin popover's view state (its focused section, rows). */
    readonly view?: ViewUi
  }
  /** Agents the operator opened since they asked, by the `since` of the attention they saw. */
  readonly seen: Readonly<Record<string, number>>
  /** zarg's last reply the operator has seen; newer ones preview in the bar. */
  readonly readUpTo?: string
  /** The focused panel's id (focus "panel") and its view's state. */
  readonly panel?: string
  readonly panelView?: ViewUi
  /** Panels the operator closed, by `closedKey`: one the plugin opens again (a new `at`) shows again. */
  readonly closedPanels: ReadonlyArray<string>
  /** The seq of the last navigation request followed. */
  readonly navigated?: number
  /** The view a plugin's sheet shows (with `sheet`); undefined: zarg's sheet. */
  readonly sheetOf?: string
  readonly sheetView?: ViewUi
  /** The inbox: the highlighted row, the open topic (and its highlighted answer), marked rows, answered ones shown, a reason being typed. */
  readonly inbox: {
    readonly cursor: number
    /** The topic the highlight is on: it follows the topic as the list changes. */
    readonly at?: string
    readonly open?: string
    readonly pick?: number
    readonly marked: ReadonlyArray<string>
    readonly all: boolean
    /** A line being typed in the open topic: a reason with the highlighted answer, or a reply (`reply`: chat about it). */
    readonly typing?: { readonly id: string; readonly text: string; readonly reply?: boolean }
  }
}

export interface Agents {
  readonly cursor?: string
  readonly toggled: Readonly<Record<string, boolean>>
  /** The tree these belong to (`ThreadState.trees`); a fresh tree starts over, since RLM ids repeat. */
  readonly tree?: number
}

export const EXIT_WINDOW_MS = 2000
/** How long a popover that just showed ignores Enter. */
export const POPOVER_GUARD_MS = 300
/** A navigation request older than this (a replayed log) is not followed. */
export const NAVIGATE_FRESH_MS = 10_000
export { CHAT, OTHER }

export const initialUi: Ui = { focus: "bar", sheet: false, main: "inbox", back: [], arrived: false, grid: { cursor: 0 }, review: { cursor: 0, selected: [] }, pick: 0, other: false, agents: { toggled: {}, tree: 0 }, popover: { pick: 0 }, seen: {}, closedPanels: [], inbox: { cursor: 0, marked: [], all: false } }

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
  const ui = withGrid(withPanels(withNavigate(withPopover(withRead(withRunClock(withArrival(ui0.agents.tree === s.thread.trees ? ui0 : { ...ui0, agents: { toggled: {}, tree: s.thread.trees } }, s), s, now), s), s, now), s, now), s), s)
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
const withPopover = (ui0: Ui, s: SessionState, now: number): Ui => {
  const head = queueOf(ui0, s)[0]
  // A popover takes the keys: an open palette closes rather than sit under it.
  const ui = head !== undefined && ui0.palette !== undefined ? (({ palette: _, ...rest }) => rest)(ui0) : ui0
  if (head === undefined) return ui.popover.id === undefined ? ui : { ...ui, popover: { pick: 0 } }
  if (head.id === ui.popover.id) return ui
  return { ...ui, popover: { id: head.id, pick: Math.max(0, head.options.findIndex((o) => o.recommended === true)), since: now } }
}

/** A plugin opened a tile or sheet during the operator's call: follow it once, unless it is old (a replayed log). */
const withNavigate = (ui: Ui, s: SessionState, now: number): Ui => {
  const n = s.thread.navigate
  if (n === undefined || (ui.navigated !== undefined && n.seq <= ui.navigated)) return ui
  const at: Ui = { ...ui, navigated: n.seq }
  // A close applies whatever its age: only the sheet it names, and only when it is the one shown.
  if (n.kind === "close") {
    if (at.sheetOf !== n.view) return at
    const { sheetOf: _, sheetView: __, ...closed } = at
    return { ...closed, sheet: false }
  }
  if (now - n.at >= NAVIGATE_FRESH_MS) return at
  if (n.kind === "sheet") {
    const { sheetView: _, ...fresh } = at
    return { ...fresh, sheet: true, sheetOf: n.view, focus: "tile" }
  }
  const { sheetOf: _, ...rest } = at
  return { ...goTo(rest, "agent", n.view), sheet: false, focus: "tile" }
}
/** Closed panels the core dropped are forgotten; a focused panel that went gives the tile the keys. */
const withPanels = (ui: Ui, s: SessionState): Ui => {
  const ids = new Set((s.thread.panels ?? []).map(closedKey))
  const closedPanels = ui.closedPanels.filter((id) => ids.has(id))
  const next = closedPanels.length === ui.closedPanels.length ? ui : { ...ui, closedPanels }
  if (next.focus !== "panel" || focusedPanel(next, s) !== undefined) return next
  const { panel: _, panelView: __, ...rest } = next
  return { ...rest, focus: "tile" }
}

/** How a closed panel is remembered: its id and when it was opened, so opening it again shows it. */
export const closedKey = (p: Panel) => (p.at === undefined ? p.id : `${p.id}#${p.at}`)

/** Panels on screen, by edge, in opening order: agent-scope ones only while their agent is open; shell-scope ones one per plugin and two per edge; closed ones left out. */
export const panelsShown = (ui: Ui, s: SessionState): Readonly<Record<"top" | "bottom" | "right", ReadonlyArray<Panel>>> => {
  const open = (s.thread.panels ?? []).filter((p) => p.id !== ZARG_BAR && !ui.closedPanels.includes(closedKey(p)))
  const plugins = new Set<string>()
  const shell = open.filter((p) => p.scope === "shell" && !plugins.has(p.plugin) && (plugins.add(p.plugin), true))
  const mine = open.filter((p) => p.scope === "agent" && ui.viewing !== undefined && (ui.viewing === p.agent || ui.viewing.startsWith(`${p.agent}@`)))
  const edge = (e: Panel["edge"]) => [...mine.filter((p) => p.edge === e), ...shell.filter((p) => p.edge === e).slice(0, 2)]
  return { top: edge("top"), bottom: edge("bottom"), right: edge("right") }
}
/** The drawers over the view closed (Esc or a click outside them); the same ui when none is shown. */
export const closeOverlays = (ui: Ui, s: SessionState): Ui => {
  const over = panelsShown(ui, s).right.filter((p) => p.overlay === true)
  if (over.length === 0) return ui
  const inside = over.some((p) => p.id === ui.panel)
  const { panel: _, panelView: __, ...rest } = ui
  return { ...(inside ? { ...rest, focus: "tile" as const } : ui), closedPanels: [...ui.closedPanels, ...over.map(closedKey)] }
}
/** The focused panel, while it is on screen. */
export const focusedPanel = (ui: Ui, s: SessionState): Panel | undefined => {
  const shown = panelsShown(ui, s)
  return ui.panel === undefined ? undefined : [...shown.top, ...shown.bottom, ...shown.right].find((p) => p.id === ui.panel)
}

/** zarg's bar is agent-zarg's panel; the shell draws it as the message bar. */
export const ZARG_BAR = "zarg:bar:zarg"
/** zarg is loaded: its bar panel is open (before the core's first panels snapshot, it is taken as loaded). */
export const zargLoaded = (s: SessionState) => s.thread.panels === undefined || s.thread.panels.some((p) => p.id === ZARG_BAR)

const question = (s: SessionState) => s.thread.pendingInquiry
/** zarg's sheet covers the tile area: opened, or no agent is open. */
export const sheetShown = (ui: Ui) => ui.sheet || ui.main === "zarg"

/** Plugin agents (an id with ":") running or asking for the operator, not archived or deleted: work the grid shows. zarg and its RLMs are the conversation. */
export const agentsWork = (s: SessionState) =>
  Object.values(liveRlms(s)).some((n) => n.id.includes(":") && (n.status === "running" || n.attention !== undefined))

/** Go to a focus, remembering where you were (the back stack). */
export const goTo = (ui: Ui, main: Main, viewing?: string): Ui => {
  // Where you were, and whether zarg's sheet was open over it: back puts both back.
  const here = { main: ui.main, ...(ui.viewing !== undefined ? { viewing: ui.viewing } : {}), ...(ui.sheet ? { sheet: true } : {}) }
  const same = here.main === main && here.viewing === viewing
  const back = same ? ui.back : [...ui.back, here].slice(-20)
  const { viewing: _, view: __, ...rest } = ui
  // A reason half typed in the inbox goes with it.
  const { typing: ___, ...inbox } = ui.inbox
  return { ...rest, inbox, main, back, ...(main === "agent" && viewing !== undefined ? { viewing } : {}) }
}
/** Home: the inbox, with zarg's sheet open when nothing is going on (no agent works, no topic waits) and closed otherwise. */
export const goHome = (ui: Ui, s: SessionState): Ui => {
  const { viewing: _, view: __, sheetOf: ___, ...rest } = ui
  // Topics that wait in the inbox alone: grants show as popovers, and zarg's own questions in its sheet.
  const waiting = Object.values(s.thread.inbox ?? {}).some((t) => t.state === "open" && t.kind !== "grant" && t.from.agent !== "zarg")
  const idle = !agentsWork(s) && !waiting
  return { ...rest, main: "inbox", back: [], sheet: idle, focus: idle && ui.focus === "bar" ? "bar" : "tile" }
}
/** Back one step; with nothing to go back to, home. */
export const goBack = (ui: Ui, s: SessionState): Ui => {
  const to = ui.back.at(-1)
  if (to === undefined) return goHome(ui, s)
  const { viewing: _, view: __, ...rest } = ui
  return { ...rest, main: to.main, back: ui.back.slice(0, -1), sheet: to.sheet === true, ...(to.viewing !== undefined ? { viewing: to.viewing } : {}) }
}
/** The grid's cursor stays on a card that exists. */
const withGrid = (ui: Ui, s: SessionState): Ui => {
  const live = liveRlms(s)
  const n = Object.values(live).filter((x) => x.id.includes(":") && (x.parent === null || live[x.parent] === undefined)).length
  const cursor = Math.max(0, Math.min(ui.grid.cursor, n - 1))
  return cursor === ui.grid.cursor ? ui : { ...ui, grid: { cursor } }
}
/** The arrival rule, once: the grid, the sheet open when nothing is going on. */
// It waits for the core's events (a TUI attaching sees an empty thread until the replay arrives).
const withArrival = (ui: Ui, s: SessionState): Ui => (ui.arrived || (s.thread.seq === 0 && s.core === "up") ? ui : { ...goHome(ui, s), arrived: true })
/** Typing "Something else…" in the bar: the highlighted row is the free-text one. */
export const answeringOther = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return q !== undefined && ui.other && ui.chatting !== q.id && ui.answered !== q.id
}
/** The bar takes text: it has focus, and nothing is asked, or the operator chats about the question or types their own answer. */
export const typing = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return ui.focus === "bar" && zargLoaded(s) && (q === undefined || ui.chatting === q.id || answeringOther(ui, s))
}
/** The shared popover queue, in the order the core asked: nothing on the client reorders it. */
// A stopped core cannot take an answer, and a prompt without options cannot be answered: neither holds the keys.
export const queueOf = (_ui: Ui, s: SessionState): ReadonlyArray<Prompt> => {
  if (s.core === "down") return []
  // Grants are inbox topics now: the popover shows the open ones, first raised first (answering it answers the topic).
  const grants = Object.values(s.thread.inbox ?? {})
    .filter((t) => t.kind === "grant" && t.state === "open" && t.blocking)
    .sort((a, b) => a.created - b.created)
    .map((t): Prompt => ({ id: t.id, question: t.title, options: (t.answers ?? []).map((a) => ({ id: a.id, label: a.label, ...(a.recommended === true ? { recommended: true } : {}) })), kind: "grant" }))
  return [...(s.thread.prompts ?? []).filter((p) => p.kind === "surface" || p.options.length > 0), ...grants]
}
/** The bar's input has the keys: it takes text and no popover is up. */
export const inputFocused = (ui: Ui, s: SessionState) => typing(ui, s) && queueOf(ui, s).length === 0 && ui.palette === undefined
/** The bar takes focus; while zarg asks, the sheet opens with the question. */
export const focusBar = (ui: Ui, s: SessionState): Ui => {
  // Without zarg there is no bar to type in.
  if (!zargLoaded(s)) return ui
  if (question(s) === undefined) return { ...ui, focus: "bar" }
  // zarg's question opens zarg's sheet (in place of a plugin's).
  const { sheetOf: _, ...rest } = ui
  return { ...rest, focus: "bar", sheet: true }
}
const seenNow = (ui: Ui, s: SessionState, id: string): Ui => {
  const since = s.thread.rlms[id]?.attention?.since
  return since === undefined ? ui : { ...ui, seen: { ...ui.seen, [id]: since } }
}
/** Open an agent: zarg's sheet for zarg, the agent's view otherwise; either way its attention counts as seen. */
export const openAgent = (ui: Ui, s: SessionState, id: string): Ui => {
  const at = seenNow({ ...ui, agents: { ...ui.agents, cursor: id } }, s, id)
  if (id === "zarg") {
    const { sheetOf: _, ...rest } = goTo(at, "zarg")
    return { ...rest, sheet: false, focus: "tile" }
  }
  return { ...goTo(at, "agent", id), sheet: false, focus: "tile" }
}

// The thread's status is stale once the core is down: nothing is working then.
const busy = (s: SessionState) => s.core === "up" && s.thread.status === "running" && s.thread.pendingInquiry === undefined

/** Whether anything on screen animates: the driver working, or agents running while no question waits. */
export const animating = (ui: Ui, s: SessionState) =>
  ui.runningSince !== undefined ||
  // A view still loading: its spinner turns.
  Object.values(s.thread.views ?? {}).some((v) => Object.values(v.data).some((d) => (d as { loading?: unknown } | undefined)?.loading !== undefined)) ||
  // An unseen request for attention blinks, and so does an unseen blocking topic.
  Object.values(s.thread.rlms).some((r) => r.attention !== undefined && ui.seen[r.id] !== r.attention.since) ||
  Object.values(s.thread.inbox ?? {}).some((t) => t.state === "open" && t.blocking && ui.seen[`inbox:${t.id}`] === undefined) ||
  // zarg's own row is always there: only agents doing work keep the clock ticking. zarg's agents wait on its
  // question with it; a plugin's agents (plugin:agent) work on meanwhile.
  (s.core === "up" && Object.values(s.thread.rlms).some((r) => r.status === "running" && r.preset !== "zarg" && (s.thread.pendingInquiry === undefined || r.id.includes(":"))))

const withRunClock = (ui: Ui, s: SessionState, now: number): Ui => {
  if (busy(s)) return ui.runningSince === undefined ? { ...ui, runningSince: now } : ui
  if (ui.runningSince === undefined) return ui
  const { runningSince: _, ...rest } = ui
  return rest
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
export const spin = (now: number) => SPINNER[Math.floor(now / 100) % SPINNER.length]!

/** The line under the conversation while zarg works on a reply or a question: spinner, elapsed time, driver turn. */
// @scenario S-0072
export const working = (ui: Ui, s: SessionState, now: number): string | undefined => {
  if (!busy(s) || ui.runningSince === undefined) return undefined
  const secs = Math.max(0, Math.floor((now - ui.runningSince) / 1000))
  const root = driverRoot(s.thread.rlms)
  const turn = root !== undefined ? ` · turn ${root.turns}/${root.budget}` : ""
  return `${spin(now)} zarg is preparing a reply · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${turn}`
}

/** What the bar shows when it is not an input: zarg's question, the working line, an unread reply, or the prompt. */
export const barLine = (ui: Ui, s: SessionState, now: number): { readonly text: string; readonly tone: "question" | "working" | "reply" | "idle" } => {
  if (!zargLoaded(s)) return { text: "zarg is not loaded", tone: "idle" }
  const q = s.thread.pendingInquiry
  if (q !== undefined && ui.answered === q.id) return { text: "sending your answer…", tone: "working" }
  if (q !== undefined && ui.chatting !== q.id)
    // The sheet already shows the question with its options: the bar only says how to reach them.
    return sheetShown(ui) ? { text: "answer zarg above, or / to chat about it", tone: "question" } : { text: `◆ zarg asks ${q.question}   ⏎ answer   / chat`, tone: "question" }
  const busyLine = working(ui, s, now)
  if (busyLine !== undefined) return { text: busyLine, tone: "working" }
  const last = lastReply(s)
  if (last !== undefined && last.id !== ui.readUpTo && !sheetShown(ui)) return { text: `zarg ${last.text.length > 60 ? `${last.text.slice(0, 59)}…` : last.text}`, tone: "reply" }
  return { text: "› message zarg… (alt+m or /)", tone: "idle" }
}

/** A panel's name split around its Alt letter; a letter not in the name goes before it. */
export const titleHot = (name: string, letter: string): { readonly before: string; readonly letter: string; readonly after: string } => {
  const i = name.toLowerCase().indexOf(letter)
  return i < 0 ? { before: "", letter, after: ` ${name}` } : { before: name.slice(0, i), letter: name[i]!, after: name.slice(i + 1) }
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
  /** The agent asks for the operator (◆, its reason in place of its progress). */
  readonly attention: boolean
  /** Set while its request for attention is unseen: its ◆ blinks with the clock. */
  readonly pulse?: "on" | "off"
}

/** How often an unseen ◆ blinks. */
export const PULSE_MS = 500

export const ICON: Record<RlmNode["status"], string> = { running: "●", done: "✓", failed: "✗", stopped: "■" }
const BAR = 6

// Children in id order; a node whose parent is unknown is a root.
// @scenario S-0041
export const childrenOf = (rlms: Readonly<Record<string, RlmNode>>) => {
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
// @scenario S-0074
export const isOpen = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents, n: RlmNode) =>
  agents.toggled[n.id] ?? (n.parent === null || rlms[n.parent] === undefined)

export interface Visible {
  readonly node: RlmNode
  readonly prefix: string
  readonly hidden: ReadonlyArray<RlmNode>
}

// @scenario S-0074
export const visible = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents): ReadonlyArray<Visible> => {
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
export const cursorOf = (rows: ReadonlyArray<Visible>, agents: Agents) =>
  // On the Archived row or one of its agents, no live row is highlighted.
  agents.cursor !== undefined && isArchiveRow(agents.cursor) ? undefined : rows.some((r) => r.node.id === agents.cursor) ? agents.cursor : rows[0]?.node.id

/** The Archived row's id, and the prefix of an archived agent's row. */
export const ARCHIVED = "__archived"
const ARCH = "archived:"
const isArchiveRow = (id: string) => id === ARCHIVED || id.startsWith(ARCH)

/** The agents still in the tree: archived and deleted ones leave it, but a running agent never hides (a new rlm-1). */
export const liveRlms = (s: SessionState): Readonly<Record<string, RlmNode>> => {
  const archived = s.thread.archived ?? {}
  const deleted = new Set(s.thread.deleted ?? [])
  return Object.fromEntries(Object.entries(s.thread.rlms).filter(([id, n]) => n.status === "running" || (archived[id] === undefined && !deleted.has(id))))
}
export const archivedNodes = (s: SessionState) => {
  const deleted = new Set(s.thread.deleted ?? [])
  return Object.entries(s.thread.archived ?? {})
    .flatMap(([id, a]) => {
      const n = s.thread.rlms[id]
      return n === undefined || n.status === "running" || deleted.has(id) ? [] : [{ node: n, ...a }]
    })
    .sort((a, b) => b.at - a.at)
}
const ago = (at: number, now: number) => {
  const m = Math.max(0, Math.floor((now - at) / 60_000))
  return m < 60 ? `${m}m ago` : m < 24 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / (24 * 60))}d ago`
}

/** The agents list: the live tree, then a folded Archived row with the agents it holds (why, and when). */
export const treeRows = (ui: Ui, s: SessionState, now?: number, cols = 46, seen?: Readonly<Record<string, number>>): ReadonlyArray<AgentRow> => {
  const rows = agentRows(liveRlms(s), ui.agents, cols, now, seen)
  const arch = archivedNodes(s)
  if (arch.length === 0) return rows
  const open = ui.agents.toggled[ARCHIVED] === true
  const group: AgentRow = { id: ARCHIVED, text: `${open ? "▾" : "▸"} Archived (${arch.length})`, tone: "done", selected: ui.agents.cursor === ARCHIVED, attention: false }
  const items = open
    ? arch.map((a): AgentRow => ({ id: `${ARCH}${a.node.id}`, text: `  ${ICON[a.node.status]} ${a.node.preset} ${a.node.id}  ${a.reason} · ${ago(a.at, now ?? Date.now())}`, tone: a.node.status === "failed" ? "failed" : "done", selected: ui.agents.cursor === `${ARCH}${a.node.id}`, attention: false }))
    : []
  return [...rows, group, ...items]
}

/** The agents tree: one line per visible RLM with its status icon, turn bar and how many descendants it hides. */
export const agentRows = (rlms: Readonly<Record<string, RlmNode>>, agents: Agents, cols = 46, now?: number, seen?: Readonly<Record<string, number>>): ReadonlyArray<AgentRow> => {
  const phase = Math.floor((now ?? 0) / PULSE_MS) % 2 === 0 ? "on" : "off"
  const unseen = (n: RlmNode) => n.attention !== undefined && seen?.[n.id] !== n.attention.since
  const rows = visible(rlms, agents)
  const cursor = cursorOf(rows, agents)
  const hiddenWidth = Math.max(0, ...rows.map((r) => (r.hidden.length > 0 ? `  +${r.hidden.length}`.length : 0)))
  // A narrow list keeps the names and drops the bar.
  const barWidth = cols >= 40 ? BAR : 0
  // The left column gives way to the bar, the turns and the hidden count: a long id is cut, never wrapped.
  const room = Math.max(8, cols - (2 + barWidth + (barWidth > 0 ? 1 : 0) + 5) - hiddenWidth)
  const lefts = rows.map((r) => {
    // zarg's row does not spin: it is there all session, working or not.
    const icon = r.node.attention !== undefined ? (unseen(r.node) && phase === "off" ? "◇" : "◆") : r.node.status === "running" && now !== undefined && r.node.preset !== "zarg" ? spin(now) : ICON[r.node.status]
    const l = `${r.prefix} ${icon} ${r.node.preset} ${r.node.id}`
    return l.length > room ? `${l.slice(0, room - 1)}…` : l
  })
  const width = Math.max(0, ...lefts.map((l) => l.length))
  return rows.map((r, i) => {
    const n = r.node
    // An agent may draw its own row: its progress, its text; otherwise turns out of the budget.
    const done = n.row?.progress?.done ?? n.turns
    const total = n.row?.progress?.total ?? n.budget
    const filled = Math.max(0, Math.min(barWidth, Math.round((done / Math.max(1, total)) * barWidth) || 0))
    const bar = barWidth > 0 ? `${"▰".repeat(filled)}${"▱".repeat(barWidth - filled)} ` : ""
    const hidden = r.hidden.length > 0 ? `  +${r.hidden.length}` : ""
    // A reason gets the room left of the row, and is cut there.
    const room = Math.max(4, cols - width - 2 - bar.length - hidden.length)
    const reason = n.attention?.reason
    const count = reason !== undefined ? (reason.length > room ? `${reason.slice(0, room - 1)}…` : reason) : (n.row?.text ?? `${done}/${total}`.padStart(5))
    return {
      id: n.id,
      text: `${lefts[i]!.padEnd(width)}  ${bar}${count}${hidden}`,
      tone: r.hidden.some((h) => h.status === "failed") ? "failed" : n.status,
      selected: n.id === cursor,
      attention: n.attention !== undefined,
      ...(unseen(n) ? { pulse: phase } : {}),
    }
  })
}

/** The agents asking for the operator, in tree order, zarg first. */
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
// @scenario S-0042 S-0073
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

/** A nav item's rail row id: `nav:` and the item's id. */
export const NAV = "nav:"
/** The nav items' row ids, in the order the rail lists them (above the agents). */
export const navRows = (s: SessionState) => (s.thread.nav ?? []).map((n) => `${NAV}${n.id}`)
/** The Inbox's row in the rail, above the plugins' views: the arrows reach it, Enter goes home. */
export const INBOX_ROW = "home:inbox"
/** Open a nav item: its view in the focus, and the plugin asked to fill it (its `act` "open"). */
export const openNav = (ui: Ui, s: SessionState, row: string): { readonly ui: Ui; readonly action?: Action } => {
  const item = (s.thread.nav ?? []).find((n) => `${NAV}${n.id}` === row)
  if (item === undefined) return { ui }
  const at = { ...ui, agents: { ...ui.agents, cursor: row } }
  return { ui: { ...goTo(at, "agent", item.view), sheet: false, focus: "tile" }, action: { type: "act", agent: item.id, action: "open", section: undefined, rows: [], view: item.view } }
}

/** Keys on the agents list: move the highlight, fold, open; `x` archives (or restores), `X` archives every finished agent, `D` deletes an archived one for good. */
export const onAgentsKey = (ui: Ui, s: SessionState, key: Key): { readonly ui: Ui; readonly action?: Action } => {
  const live = liveRlms(s)
  const rows = visible(live, ui.agents)
  const nav = [INBOX_ROW, ...navRows(s)]
  const ids = treeRows(ui, s).map((r) => r.id)
  const move = (id: string | undefined): Ui => (id === undefined ? ui : { ...ui, agents: { ...ui.agents, cursor: id } })
  // The nav items sit above the agents: the arrows run through both.
  if (ui.agents.cursor !== undefined && nav.includes(ui.agents.cursor)) {
    const i = nav.indexOf(ui.agents.cursor)
    if (key.name === "down") return { ui: move(nav[i + 1] ?? ids[0]) }
    if (key.name === "up") return { ui: move(nav[Math.max(0, i - 1)]) }
    if (key.name === "return") return ui.agents.cursor === INBOX_ROW ? { ui: { ...goHome(ui, s), sheet: false, focus: "tile" } } : openNav(ui, s, ui.agents.cursor)
    return { ui }
  }
  const cursor = ui.agents.cursor !== undefined && isArchiveRow(ui.agents.cursor) ? ui.agents.cursor : cursorOf(rows, ui.agents)
  if (cursor === undefined) return key.name === "up" || key.name === "down" ? { ui: move(nav.at(-1)) } : { ui }
  const at = ids.indexOf(cursor)
  const shifted = (letter: string) => key.name === letter.toUpperCase() || (key.name === letter && key.shift === true)
  const archive = (change: { archive?: ReadonlyArray<string>; restore?: ReadonlyArray<string>; delete?: ReadonlyArray<string> }) => ({ ui, action: { type: "archive" as const, change } })
  // Finished, asking for nothing, and not zarg: what may leave the tree.
  const finished = (n: RlmNode) => n.id !== "zarg" && n.status !== "running" && n.attention === undefined
  if (key.name === "down") return { ui: move(ids[Math.min(ids.length - 1, at + 1)]) }
  if (key.name === "up") return { ui: move(at === 0 && nav.length > 0 ? nav.at(-1) : ids[Math.max(0, at - 1)]) }
  if (shifted("x")) {
    const all = rows.flatMap((r) => [r.node, ...r.hidden]).filter(finished).map((n) => n.id)
    return all.length > 0 ? archive({ archive: all }) : { ui }
  }
  const toggleGroup = (open: boolean): Ui => ({ ...ui, agents: { ...ui.agents, cursor: ARCHIVED, toggled: { ...ui.agents.toggled, [ARCHIVED]: open } } })
  if (cursor === ARCHIVED) {
    if (key.name === "return") return { ui: toggleGroup(ui.agents.toggled[ARCHIVED] !== true) }
    if (key.name === "right") return { ui: toggleGroup(true) }
    if (key.name === "left") return { ui: toggleGroup(false) }
    return { ui }
  }
  if (cursor.startsWith(ARCH)) {
    const id = cursor.slice(ARCH.length)
    if (key.name === "x") return archive({ restore: [id] })
    if (shifted("d")) return archive({ delete: [id] })
    if (key.name === "return") return { ui: openAgent(ui, s, id) }
    if (key.name === "left") return { ui: move(ARCHIVED) }
    return { ui }
  }
  const row = rows.find((r) => r.node.id === cursor)
  if (row === undefined) return { ui }
  const n = row.node
  const children = childrenOf(live)
  const below = (x: RlmNode): Array<RlmNode> => children(x.id).flatMap((c) => [c, ...below(c)])
  if (key.name === "x") return finished(n) ? archive({ archive: [n, ...below(n)].filter(finished).map((x) => x.id) }) : { ui }
  const set = (open: boolean): Ui => ({ ...ui, agents: { ...ui.agents, cursor: n.id, toggled: { ...ui.agents.toggled, [n.id]: open } } })
  const hasKids = children(n.id).length > 0
  const open = isOpen(live, ui.agents, n)
  if (key.name === "return") return { ui: activate(ui, s, n.id) }
  if (key.name === "right") return { ui: hasKids && !open ? set(true) : ui }
  if (key.name === "left") return { ui: hasKids && open ? set(false) : n.parent !== null && live[n.parent] !== undefined ? move(n.parent) : ui }
  return { ui }
}

export interface Meta {
  readonly threadId: string
  /** The project's name (its folder), shown under zarg at the top of the rail. */
  readonly repo?: string
  readonly driver?: string
  readonly mode: "child" | "headless"
}

/** The inbox's count for the status line: `◆ 1 blocking · 3 open`, or nothing when it is empty. */
const inboxCount = (s: SessionState) => {
  const open = Object.values(s.thread.inbox ?? {}).filter((t) => t.state === "open")
  const blocking = open.filter((t) => t.blocking).length
  return open.length === 0 ? [] : [blocking > 0 ? `◆ ${blocking} blocking · ${open.length} open` : `${open.length} open`]
}
/** Most important first, so a narrow terminal cuts the driver model, never the core state. */
// @scenario S-0067 S-0070
export const statusLine = (s: SessionState, meta: Meta) =>
  [
    s.core === "down" ? "core stopped" : `core ${meta.mode}`,
    // Right after the core state: a narrow terminal cuts from the end, and YOLO must stay visible.
    ...(s.thread.yolo === true ? ["YOLO"] : []),
    // Then what waits on the operator: a blocked agent must not be out of sight.
    ...inboxCount(s),
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
  /** An action on rows of a table in a view: the open agent's, or `agent`'s (a panel, a popover, a plugin sheet). */
  | { readonly type: "act"; readonly section: string | undefined; readonly action: string; readonly rows: ReadonlyArray<string>; readonly agent?: string; readonly view?: string; readonly text?: string }
  /** Close a plugin's popover. */
  | { readonly type: "close-prompt"; readonly id: string }
  /** Review actions: one act per agent and table. */
  | { readonly type: "review-acts"; readonly acts: ReadonlyArray<{ readonly agent: string; readonly section: string; readonly action: string; readonly rows: ReadonlyArray<string> }> }
  /** Archive, restore or delete agents of the tree. */
  | { readonly type: "archive"; readonly change: { readonly archive?: ReadonlyArray<string>; readonly restore?: ReadonlyArray<string>; readonly delete?: ReadonlyArray<string> } }
  /** Answer a question in the open agent's conversation (or `agent`'s). */
  | { readonly type: "answer-agent"; readonly question: string; readonly answer: { readonly choice?: string; readonly other?: string }; readonly agent?: string }
  /** Scroll the open agent's focused section by lines. */
  | { readonly type: "scroll"; readonly delta: number }
  /** Scroll zarg's sheet by lines. */
  | { readonly type: "scroll-talk"; readonly delta: number }
  /** Answer the popover at the head of the queue (a grant). */
  | { readonly type: "answer-prompt"; readonly id: string; readonly choice: string }
  /** The inbox: answer a topic (an answer, a reason, or both), a batch of one kind, snooze, read. */
  | { readonly type: "answer-topic"; readonly id: string; readonly answer?: string; readonly text?: string }
  | { readonly type: "answer-topics"; readonly ids: ReadonlyArray<string>; readonly answer: string }
  | { readonly type: "snooze-topic"; readonly id: string }
  | { readonly type: "read-topic"; readonly id: string }
  /** A reply in a topic: talk it over with whoever asked. */
  | { readonly type: "reply-topic"; readonly id: string; readonly text: string }
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
  // A number answers that option, as in the inbox (when not typing Something else…).
  if (!ui.other && /^[1-9]$/.test(key.name) && key.ctrl !== true && key.meta !== true) {
    const option = inquiry.options[Number(key.name) - 1]
    return option === undefined ? { ui } : { ui: { ...ui, answered: inquiry.id }, action: { type: "answer", answer: { choice: option.id } } }
  }
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
