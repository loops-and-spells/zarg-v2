import type { SessionState } from "@zarg/client"
import { dispatch, focused, type InputKey, type InputLayer, keyFor, type KeyHint, leafOf, printable, startUi } from "@zarg/view"
import { viewKeys } from "./view-keys"
import {
  type Action,
  answeringOther,
  attentionOf,
  EXIT_WINDOW_MS,
  POPOVER_GUARD_MS,
  focusBar,
  type Key,
  onAgentsKey,
  onSlashKey,
  openAgent,
  pickerKey,
  preselect,
  queueOf,
  sheetShown,
  typing,
  type Ui,
} from "./view"

/** What the shell's layers read: the session, the time, the bar's draft. */
export interface ShellWorld {
  readonly s: SessionState
  readonly now: number
  readonly draft: string
}
type Layer = InputLayer<Ui, ShellWorld, Action>

const ARROWS = new Set(["left", "right", "up", "down"])

/** Alt+arrows move between the agents list, the tile area and the bar, as they sit on screen. */
const moveTile = (ui: Ui, s: SessionState, dir: string): Ui => {
  if (dir === "left") return { ...ui, focus: "agents" }
  if (dir === "right") return ui.focus === "agents" ? { ...ui, focus: "tile" } : ui
  if (dir === "down") return ui.focus === "tile" ? focusBar(ui, s) : ui
  return ui.focus === "bar" ? { ...ui, focus: "tile" } : ui
}

/** `/` from any panel: the bar opens with the slash typed (while zarg asks, as chat about the question). */
const slashFrom = (ui: Ui, s: SessionState) => {
  const q = s.thread.pendingInquiry
  return { ui: { ...focusBar(ui, s), ...(q !== undefined ? { chatting: q.id, other: false } : {}) }, draft: "/" }
}

/** g: the next agent that needs the developer, the ones not yet seen first, then tree order (zarg first). */
const nextAttention = (ui: Ui, s: SessionState) => {
  const all = attentionOf(s.thread.rlms)
  if (all.length === 0) return { ui }
  const unseen = all.filter((a) => ui.seen[a.id] !== s.thread.rlms[a.id]?.attention?.since)
  const order = [...unseen, ...all.filter((a) => !unseen.includes(a))]
  const next = order[(order.findIndex((a) => a.id === ui.attentionAt) + 1) % order.length]!
  return { ui: { ...openAgent(ui, s, next.id), attentionAt: next.id } }
}

/** g and / belong to every panel that is not a text input. */
const common = (ui: Ui, w: ShellWorld, k: InputKey) => (k.ctrl === true || k.meta === true ? undefined : k.name === "g" ? nextAttention(ui, w.s) : k.name === "/" ? slashFrom(ui, w.s) : undefined)

/** The open agent's own keys on the terminal: the focused table's actions, then the view's. */
const agentKeys = (ui: Ui, s: SessionState): ReadonlyArray<KeyHint> => {
  const v = ui.viewing === undefined ? undefined : s.thread.views?.[ui.viewing]
  if (v === undefined) return []
  const vu = ui.view ?? startUi(v)
  const at = focused(v, vu)
  const leaf = at === undefined ? undefined : leafOf(v, vu, at.id)?.leaf
  return [...(leaf?.kind === "table" ? (leaf.actions ?? []) : []), ...(v.layout.actions ?? [])].flatMap((a) => {
    const key = keyFor(a, "terminal")
    return key === undefined ? [] : [{ keys: key, does: a.label }]
  })
}

/** The shell's input layers, top first. Each is on the stack while its `when` holds; a key goes to the first that takes it. */
export const SHELL: ReadonlyArray<Layer> = [
  {
    id: "global",
    when: () => true,
    hints: () => [],
    handle: (ui, w, k) => {
      if (k.ctrl && k.name === "d") return { ui, action: { type: "exit" } }
      if (k.ctrl && k.name === "c")
        return ui.lastCtrlC !== undefined && w.now - ui.lastCtrlC < EXIT_WINDOW_MS ? { ui, action: { type: "exit" } } : { ui: { ...ui, lastCtrlC: w.now }, action: { type: "stop" } }
      if (k.meta && ARROWS.has(k.name)) return { ui: moveTile(ui, w.s, k.name) }
      if (k.meta && k.name === "a") return { ui: { ...ui, focus: "agents" } }
      if (k.meta && k.name === "v") return { ui: { ...ui, sheet: false, focus: "tile" } }
      if (k.meta && k.name === "m") return { ui: ui.focus === "bar" ? { ...ui, sheet: true } : focusBar(ui, w.s) }
      return "pass"
    },
  },
  {
    id: "popover",
    when: (ui, w) => queueOf(ui, w.s).length > 0,
    hints: () => [{ keys: "←→", does: "pick" }, { keys: "Enter", does: "choose" }],
    handle: (ui, w, k) => {
      const head = queueOf(ui, w.s)[0]!
      const n = head.options.length
      const pick = Math.min(ui.popover.pick, Math.max(0, n - 1))
      if (k.name === "left" || k.name === "up") return { ui: { ...ui, popover: { ...ui.popover, pick: Math.max(0, pick - 1) } } }
      if (k.name === "right" || k.name === "down") return { ui: { ...ui, popover: { ...ui.popover, pick: Math.min(n - 1, pick + 1) } } }
      const option = head.options[pick]
      if (k.name === "return") {
        // A grant is a gate: an answer already on its way, or a head that only just showed, takes no Enter.
        const fresh = ui.popover.since !== undefined && w.now - ui.popover.since < POPOVER_GUARD_MS
        if (option === undefined || ui.popover.answering === head.id || fresh) return { ui }
        return { ui: { ...ui, popover: { ...ui.popover, answering: head.id } }, action: { type: "answer-prompt", id: head.id, choice: option.id } }
      }
      // Strictly first in, first out: a grant stays until answered (Esc included), and nothing jumps the queue.
      return { ui }
    },
  },
  {
    id: "slash",
    when: (ui, w) => typing(ui, w.s) && !answeringOther(ui, w.s) && w.draft.startsWith("/"),
    hints: () => [{ keys: "Tab", does: "complete" }, { keys: "↑↓", does: "pick" }, { keys: "Enter", does: "run" }, { keys: "Esc", does: "close" }],
    handle: (ui, w, k) => onSlashKey(ui, k, w.draft) ?? "pass",
  },
  {
    id: "bar",
    when: (ui, w) => typing(ui, w.s),
    hints: (ui, w) => [{ keys: "Enter", does: answeringOther(ui, w.s) ? "answer" : "send" }, { keys: "Esc", does: "leave" }],
    handle: (ui, w, k) => {
      // Letters, space and Backspace are the input's own: the renderer's input gets them, nobody else does.
      if (printable(k) || k.name === "return") return { ui }
      if (k.name !== "escape") return "pass"
      const q = w.s.thread.pendingInquiry
      if (q !== undefined && ui.chatting === q.id) {
        const { chatting: _, ...rest } = ui
        return { ui: rest }
      }
      if (q !== undefined && answeringOther(ui, w.s)) return { ui: { ...ui, other: false, pick: preselect(q) } }
      return { ui: { ...ui, focus: "tile" } }
    },
  },
  {
    id: "picker",
    when: (ui, w) => {
      const q = w.s.thread.pendingInquiry
      return q !== undefined && ui.answered !== q.id && ui.chatting !== q.id && (ui.focus === "bar" || (ui.focus === "tile" && sheetShown(ui)))
    },
    hints: () => [{ keys: "↑↓", does: "pick" }, { keys: "Enter", does: "answer" }],
    handle: (ui, w, k) => pickerKey(ui, w.s, k),
  },
  {
    // The bar with focus but not typing (zarg's question is in the picker): Esc leaves it, g and / as anywhere.
    id: "bar-idle",
    when: (ui, w) => ui.focus === "bar" && !typing(ui, w.s),
    hints: () => [{ keys: "Esc", does: "leave" }],
    handle: (ui, w, k) => (k.name === "escape" ? { ui: { ...ui, focus: "tile" } } : (common(ui, w, k) ?? "pass")),
  },
  {
    id: "sheet",
    when: (ui) => ui.focus === "tile" && sheetShown(ui),
    hints: () => [{ keys: "PgUp PgDn", does: "scroll" }, { keys: "Esc", does: "collapse" }],
    handle: (ui, w, k) => {
      if (k.name === "pageup" || k.name === "pagedown") return { ui, action: { type: "scroll-talk", delta: k.name === "pageup" ? -10 : 10 } }
      if (k.name === "up" || k.name === "down") return { ui, action: { type: "scroll-talk", delta: k.name === "up" ? -1 : 1 } }
      // With no agent open the sheet is all there is: Esc hands the keys to the agents list.
      if (k.name === "escape") return { ui: ui.viewing === undefined ? { ...ui, sheet: false, focus: "agents" } : { ...ui, sheet: false } }
      return common(ui, w, k) ?? "pass"
    },
  },
  {
    id: "view",
    when: (ui) => ui.focus === "tile" && !sheetShown(ui),
    hints: (ui, w) => [{ keys: "Tab", does: "sections" }, { keys: "[ ]", does: "tabs" }, { keys: "Space", does: "select" }, { keys: "Esc", does: "close" }, ...agentKeys(ui, w.s)],
    handle: (ui, w, k) => {
      if (k.name === "escape") {
        const { viewing: _, view: __, ...rest } = ui
        return { ui: rest }
      }
      const c = common(ui, w, k)
      if (c !== undefined) return c
      const v = ui.viewing === undefined ? undefined : w.s.thread.views?.[ui.viewing]
      if (v === undefined) return { ui }
      const r = viewKeys(v, ui.view ?? startUi(v), k)
      return {
        ui: { ...ui, view: r.ui },
        ...(r.act !== undefined
          ? { action: { type: "act" as const, ...r.act } }
          : r.answer !== undefined
            ? { action: { type: "answer-agent" as const, ...r.answer } }
            : r.scroll !== undefined
              ? { action: { type: "scroll" as const, delta: r.scroll } }
              : {}),
      }
    },
  },
  {
    id: "agents",
    when: (ui) => ui.focus === "agents",
    hints: () => [{ keys: "↑↓", does: "move" }, { keys: "←→", does: "fold" }, { keys: "Enter", does: "open" }, { keys: "g", does: "next ◆" }],
    handle: (ui, w, k) => common(ui, w, k) ?? { ui: onAgentsKey(ui, w.s, k) },
  },
]

/** What a key does: the next UI state, maybe an action for the session and a new draft for the bar, and which layer took it. */
export const onKey = (ui: Ui, s: SessionState, key: Key, now: number, draft?: string) => dispatch(SHELL, ui, { s, now, draft: draft ?? "" }, key)
