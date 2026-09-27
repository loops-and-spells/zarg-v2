import type { SessionState } from "@zarg/client"
import { dispatch, focused, type InputKey, type InputLayer, keyFor, type KeyHint, leafOf, printable, startUi, type ViewState, type ViewUi } from "@zarg/view"
import { viewKeys } from "./view-keys"
import {
  type Action,
  answeringOther,
  attentionOf,
  EXIT_WINDOW_MS,
  focusedPanel,
  panelsShown,
  closedKey,
  POPOVER_GUARD_MS as GUARD_MS,
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
  zargLoaded,
} from "./view"

/** What the shell's layers read: the session, the time, the bar's draft. */
export interface ShellWorld {
  readonly s: SessionState
  readonly now: number
  readonly draft: string
}
type Layer = InputLayer<Ui, ShellWorld, Action>

const ARROWS = new Set(["left", "right", "up", "down"])

/** Alt+arrows move between the agents list, the tile area, its panels that take keys, and the bar, as they sit on screen. */
const moveTile = (ui: Ui, s: SessionState, dir: string): Ui => {
  const shown = panelsShown(ui, s)
  const bottom = shown.bottom.filter((p) => p.input === "onFocus")
  const right = shown.right.filter((p) => p.input === "onFocus")
  const toPanel = (id: string): Ui => {
    const { panelView: _, ...rest } = ui
    return { ...rest, focus: "panel", panel: id }
  }
  const at = ui.focus === "panel" ? ui.panel : undefined
  const inBottom = bottom.findIndex((p) => p.id === at)
  if (dir === "left") return ui.focus === "panel" && right.some((p) => p.id === at) ? { ...ui, focus: "tile" } : { ...ui, focus: "agents" }
  if (dir === "right") return ui.focus === "agents" ? { ...ui, focus: "tile" } : ui.focus === "tile" && right[0] !== undefined ? toPanel(right[0].id) : ui
  if (dir === "down") {
    if (ui.focus === "tile") return bottom[0] !== undefined ? toPanel(bottom[0].id) : focusBar(ui, s)
    if (inBottom >= 0) return bottom[inBottom + 1] !== undefined ? toPanel(bottom[inBottom + 1]!.id) : focusBar(ui, s)
    return ui
  }
  if (ui.focus === "bar") return bottom.at(-1) !== undefined ? toPanel(bottom.at(-1)!.id) : { ...ui, focus: "tile" }
  if (inBottom > 0) return toPanel(bottom[inBottom - 1]!.id)
  return ui.focus === "panel" ? { ...ui, focus: "tile" } : ui
}

/** A key on a view that is not the open agent's: its new state, and its action or answer for `agent`. */
const surfaceKey = (v: ViewState, vu: ViewUi, k: InputKey, agent: string): { readonly view: ViewUi; readonly action?: Action } => {
  const r = viewKeys(v, vu, k)
  return {
    view: r.ui,
    // The view's key goes along: an action's `opens` is found in the view it came from.
    ...(r.act !== undefined ? { action: { type: "act" as const, ...r.act, agent, view: v.agent } } : r.answer !== undefined ? { action: { type: "answer-agent" as const, ...r.answer, agent } } : {}),
  }
}

/** `/` from any panel: the bar opens with the slash typed (while zarg asks, as chat about the question). */
const slashFrom = (ui: Ui, s: SessionState) => {
  if (!zargLoaded(s)) return { ui }
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

/** A view keyed `${agent}@${view}` belongs to that agent: its actions and answers go there. */
const ownerOf = (key: string) => (key.includes("@") ? { agent: key.split("@")[0]! } : {})

/** The open agent's own keys on the terminal: the focused table's actions, then the view's. */
const agentKeys = (ui: Ui, s: SessionState): ReadonlyArray<KeyHint> => {
  const v = ui.viewing === undefined ? undefined : s.thread.views?.[ui.viewing]
  return v === undefined ? [] : viewKeyHints(v, ui.view ?? startUi(v))
}
/** A view's own keys on the terminal: its focused table's actions, then the view's. */
const viewKeyHints = (v: ViewState, vu: ViewUi): ReadonlyArray<KeyHint> => {
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
      if (k.meta && k.name === "m") {
        if (ui.focus !== "bar") return { ui: focusBar(ui, w.s) }
        // The second alt+m opens zarg's sheet, in place of a plugin's.
        const { sheetOf: _, ...rest } = ui
        return { ui: { ...rest, sheet: true } }
      }
      return "pass"
    },
  },
  {
    id: "popover",
    exclusive: true,
    when: (ui, w) => queueOf(ui, w.s).length > 0,
    hints: (ui, w) => {
      const head = queueOf(ui, w.s)[0]
      if (head?.kind !== "surface") return [{ keys: "←→", does: "pick" }, { keys: "Enter", does: "choose" }]
      const v = head.view === undefined ? undefined : w.s.thread.views?.[head.view]
      return [{ keys: "Esc", does: "close" }, ...(v === undefined ? [] : viewKeyHints(v, ui.popover.view ?? startUi(v)))]
    },
    handle: (ui, w, k) => {
      const head = queueOf(ui, w.s)[0]!
      // A plugin's popover: its view takes the keys; Esc closes it (for every client).
      if (head.kind === "surface") {
        if (k.name === "escape") return { ui, action: { type: "close-prompt", id: head.id } }
        // Like a grant, a popover that just showed takes no keys: a key meant for what was there never acts on it.
        if (ui.popover.since !== undefined && w.now - ui.popover.since < GUARD_MS) return { ui }
        const v = head.view === undefined ? undefined : w.s.thread.views?.[head.view]
        if (v === undefined || head.agent === undefined) return { ui }
        const r = surfaceKey(v, ui.popover.view ?? startUi(v), k, head.agent)
        return { ui: { ...ui, popover: { ...ui.popover, view: r.view } }, ...(r.action !== undefined ? { action: r.action } : {}) }
      }
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
      return q !== undefined && ui.answered !== q.id && ui.chatting !== q.id && (ui.focus === "bar" || (ui.focus === "tile" && sheetShown(ui) && ui.sheetOf === undefined))
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
    id: "panel",
    when: (ui, w) => ui.focus === "panel" && focusedPanel(ui, w.s) !== undefined,
    hints: () => [{ keys: "Esc", does: "close" }],
    handle: (ui, w, k) => {
      const p = focusedPanel(ui, w.s)!
      if (k.name === "escape") {
        const { panel: _, panelView: __, ...rest } = ui
        return { ui: { ...rest, focus: "tile", closedPanels: [...ui.closedPanels, closedKey(p)] } }
      }
      const c = common(ui, w, k)
      if (c !== undefined) return c
      const v = w.s.thread.views?.[p.view]
      if (v === undefined) return { ui }
      const r = surfaceKey(v, ui.panelView ?? startUi(v), k, p.agent)
      return { ui: { ...ui, panelView: r.view }, ...(r.action !== undefined ? { action: r.action } : {}) }
    },
  },
  {
    // A plugin's sheet over the tile area: its view takes the keys; Esc closes it.
    id: "plugin-sheet",
    when: (ui) => ui.focus === "tile" && ui.sheet && ui.sheetOf !== undefined,
    hints: () => [{ keys: "Esc", does: "close" }],
    handle: (ui, w, k) => {
      if (k.name === "escape") {
        const { sheetOf: _, sheetView: __, ...rest } = ui
        return { ui: { ...rest, sheet: false } }
      }
      const c = common(ui, w, k)
      if (c !== undefined) return c
      const v = w.s.thread.views?.[ui.sheetOf!]
      if (v === undefined) return { ui }
      const r = surfaceKey(v, ui.sheetView ?? startUi(v), k, v.agent.split("@")[0]!)
      return { ui: { ...ui, sheetView: r.view }, ...(r.action !== undefined ? { action: r.action } : {}) }
    },
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
          ? { action: { type: "act" as const, ...r.act, view: v.agent, ...ownerOf(v.agent) } }
          : r.answer !== undefined
            ? { action: { type: "answer-agent" as const, ...r.answer, ...ownerOf(v.agent) } }
            : r.scroll !== undefined
              ? { action: { type: "scroll" as const, delta: r.scroll } }
              : {}),
      }
    },
  },
  {
    id: "agents",
    when: (ui) => ui.focus === "agents",
    hints: (ui) =>
      ui.agents.cursor?.startsWith("archived:") === true
        ? [{ keys: "x", does: "restore" }, { keys: "D", does: "delete" }, { keys: "Enter", does: "open" }]
        : [{ keys: "↑↓", does: "move" }, { keys: "Enter", does: "open" }, { keys: "x", does: "archive" }, { keys: "X", does: "archive finished" }, { keys: "g", does: "next ◆" }],
    handle: (ui, w, k) => common(ui, w, k) ?? onAgentsKey(ui, w.s, k),
  },
]

/** What a key does: the next UI state, maybe an action for the session and a new draft for the bar, and which layer took it. */
export const onKey = (ui: Ui, s: SessionState, key: Key, now: number, draft?: string) => dispatch(SHELL, ui, { s, now, draft: draft ?? "" }, key)
