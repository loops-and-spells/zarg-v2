import { openTopics } from "@zarg/client"
import { inboxKey } from "./inbox-keys"
import type { SessionState } from "@zarg/client"
import { closeMenu, dispatch, focused, type InputKey, type InputLayer, keyFor, type KeyHint, leafOf, printable, startUi, type ViewState, type ViewUi } from "@zarg/view"
import { gridCards, gridCursor } from "./grid"
import { SLASH_COMMANDS } from "./commands"
import { paletteEntries } from "./palette"
import { reviewActs, reviewGroups } from "./review"
import { viewKeys } from "./view-keys"
import {
  type Action,
  answeringOther,
  attentionOf,
  EXIT_WINDOW_MS,
  focusedPanel,
  panelsShown,
  closedKey,
  closeOverlays,
  POPOVER_GUARD_MS as GUARD_MS,
  POPOVER_GUARD_MS,
  focusBar,
  goBack,
  goHome,
  goTo,
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
  /** The grid's columns and cards a page (from the terminal's size; 2 and 4 when unknown). */
  readonly gridCols?: number
  readonly gridPage?: number
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

/** g: a blocking topic first (open in the inbox), then the next agent that needs the operator, the ones not yet seen first, then tree order (zarg first). */
const nextAttention = (ui: Ui, s: SessionState) => {
  const blocking = openTopics(s.thread).find((t) => t.blocking && t.id !== ui.inbox.open)
  if (blocking !== undefined) {
    const home = goHome(ui, s)
    return { ui: { ...home, sheet: false, focus: "tile" as const, inbox: { ...home.inbox, open: blocking.id, pick: 0 } } }
  }
  const all = attentionOf(s.thread.rlms)
  if (all.length === 0) return { ui }
  const unseen = all.filter((a) => ui.seen[a.id] !== s.thread.rlms[a.id]?.attention?.since)
  const order = [...unseen, ...all.filter((a) => !unseen.includes(a))]
  const next = order[(order.findIndex((a) => a.id === ui.attentionAt) + 1) % order.length]!
  return { ui: { ...openAgent(ui, s, next.id), attentionAt: next.id } }
}

/** g and / belong to every panel that is not a text input. */
/** A column menu open in the view, the sheet or a panel: it owns the plain keys (its search takes the typing). */
const menuOpen = (ui: Ui) => [ui.view, ui.sheetView, ui.panelView].some((v) => v?.menu !== undefined || v?.searching !== undefined || v?.input !== undefined || v?.choose !== undefined)
const common = (ui: Ui, w: ShellWorld, k: InputKey) =>
  k.ctrl === true || k.meta === true || menuOpen(ui)
    ? undefined
    : k.name === "g"
      ? nextAttention(ui, w.s)
      : k.name === "/"
        ? slashFrom(ui, w.s)
        : // ⇥: back to the previous focus.
          k.name === "tab" && k.shift !== true
          ? { ui: goBack(ui, w.s) }
          : undefined

/** A view keyed `${agent}@${view}` belongs to that agent: its actions and answers go there. */
const ownerOf = (key: string) => (key.includes("@") ? { agent: key.split("@")[0]! } : {})

/** Keys a focused section has of its own (not actions): a toggle table's space, a board's folds and moves. */
const sectionHints = (ui: Ui, s: SessionState): ReadonlyArray<KeyHint> => {
  const v = ui.viewing === undefined ? undefined : s.thread.views?.[ui.viewing]
  if (v === undefined) return []
  const vu = ui.view ?? startUi(v)
  const at = focused(v, vu)
  const leaf = at === undefined ? undefined : leafOf(v, vu, at.id)?.leaf
  if (leaf?.kind === "table" && leaf.toggle === true) return [{ keys: "Space", does: "flip" }]
  if (leaf?.kind === "board") return [{ keys: "Enter", does: "open" }, { keys: "⇧←→", does: "move" }, { keys: "z Z", does: "fold" }]
  return []
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
      if (k.ctrl && k.name === "k") return { ui: { ...ui, palette: { query: "", pick: 0 } } }
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
    // ^k: it owns every key but the global ones while open; typing filters, ⏎ goes.
    id: "palette",
    exclusive: true,
    when: (ui) => ui.palette !== undefined,
    hints: () => [{ keys: "↑↓", does: "pick" }, { keys: "Enter", does: "go" }, { keys: "Esc", does: "close" }],
    handle: (ui, w, k) => {
      const p = ui.palette!
      const close = (): Ui => {
        const { palette: _, ...rest } = ui
        return rest
      }
      if (k.name === "escape") return { ui: close() }
      const entries = paletteEntries(w.s, p.query, SLASH_COMMANDS)
      const pick = Math.min(p.pick, Math.max(0, entries.length - 1))
      // The highlight stays on the ten entries the palette shows.
      if (k.name === "down") return { ui: { ...ui, palette: { ...p, pick: Math.max(0, Math.min(Math.min(entries.length, 10) - 1, pick + 1)) } } }
      if (k.name === "up") return { ui: { ...ui, palette: { ...p, pick: Math.max(0, pick - 1) } } }
      if (k.name === "backspace") return { ui: { ...ui, palette: { query: p.query.slice(0, -1), pick: 0 } } }
      if (printable(k)) return { ui: { ...ui, palette: { query: p.query + (k.name === "space" ? " " : k.name), pick: 0 } } }
      if (k.name === "return") {
        const e = entries[pick]
        if (e === undefined) return { ui }
        if ("command" in e.go) return { ui: close(), action: { type: "command", text: e.go.command } }
        const to = e.go.main === "agent" && e.go.viewing !== undefined ? openAgent(close(), w.s, e.go.viewing) : goTo(close(), e.go.main)
        return { ui: { ...to, sheet: false, focus: "tile" } }
      }
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
      if (k.name === "escape" && ui.panelView?.menu !== undefined) return { ui: { ...ui, panelView: closeMenu(ui.panelView) } }
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
      if (k.name === "escape" && ui.sheetView?.menu !== undefined) return { ui: { ...ui, sheetView: closeMenu(ui.sheetView) } }
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
      // Esc: zarg's focus goes back; the sheet over another focus closes.
      if (k.name === "escape") return { ui: ui.main === "zarg" && !ui.sheet ? goBack(ui, w.s) : { ...ui, sheet: false } }
      return common(ui, w, k) ?? "pass"
    },
  },
  {
    id: "view",
    when: (ui) => ui.focus === "tile" && ui.main === "agent" && !sheetShown(ui),
    hints: (ui, w) =>
      ui.view?.menu !== undefined
        ? [{ keys: "↑↓", does: "move" }, { keys: "Enter", does: "apply" }, { keys: "Esc", does: "close" }]
        : ui.view?.header !== undefined
          ? [{ keys: "←→", does: "column" }, { keys: "Enter", does: "sort, select" }, { keys: "↓", does: "rows" }, { keys: "Esc", does: "back" }]
          : // The view's actions are buttons in the view: the status line keeps no view keys, but the few keys a section has of its own.
            [...sectionHints(ui, w.s), { keys: "Esc", does: "back" }],
    handle: (ui, w, k) => {
      // Esc closes an open menu or clears a search being typed (the view's keys handle both); else it goes back.
      // A drawer over the view closes before the view goes back.
      if (k.name === "escape" && ui.view?.menu === undefined && ui.view?.searching === undefined && ui.view?.input === undefined && ui.view?.choose === undefined) {
        const closed = closeOverlays(ui, w.s)
        return { ui: closed !== ui ? closed : goBack(ui, w.s) }
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
    // The inbox (home): the list and the open topic; its own keys first, then g, / and ⇥ as anywhere.
    id: "inbox",
    when: (ui) => ui.focus === "tile" && ui.main === "inbox" && !ui.sheet,
    hints: (ui, w) =>
      ui.inbox.typing !== undefined
        ? [{ keys: "Enter", does: "send" }, { keys: "Esc", does: "cancel" }]
        : ui.inbox.open !== undefined
          ? (() => {
              const t = w.s.thread.inbox?.[ui.inbox.open!]
              const answerable = t?.state === "open" && ((t.answers ?? []).length > 0 || t.text !== undefined)
              return [...(answerable ? [{ keys: "1-9", does: "answer" }, { keys: "t", does: "with a reason" }] : []), ...(t?.origin !== undefined ? [{ keys: "o", does: "open" }] : []), { keys: "z", does: "snooze" }, { keys: "Esc", does: "back" }]
            })()
          : [{ keys: "↑↓", does: "move" }, { keys: "Enter", does: "open" }, { keys: "1-9", does: "answer" }, { keys: "Space", does: "mark" }, { keys: "a", does: "all" }],
    handle: (ui, w, k) => {
      if (ui.inbox.typing === undefined) {
        const c = common(ui, w, k)
        if (c !== undefined) return c
      }
      const r = inboxKey(ui, w.s, k)
      return r.ui === ui && r.action === undefined ? "pass" : r
    },
  },
  {
    id: "grid",
    when: (ui) => ui.focus === "tile" && ui.main === "grid" && !ui.sheet,
    hints: () => [{ keys: "←→↑↓", does: "move" }, { keys: "Enter", does: "open" }, { keys: "] [", does: "page" }],
    handle: (ui, w, k) => {
      const c = common(ui, w, k)
      if (c !== undefined) return c
      if (k.name === "escape") return { ui: goBack(ui, w.s) }
      const cards = gridCards(ui, w.s)
      if (cards.length === 0) return "pass"
      const cols = w.gridCols ?? 2
      const page = w.gridPage ?? 4
      const at = gridCursor(ui, cards)
      // The cursor follows its agent: a card moving (attention first) keeps it on the same agent.
      const to = (i: number) => {
        const cursor = Math.max(0, Math.min(cards.length - 1, i))
        return { ui: { ...ui, grid: { cursor, id: cards[cursor]!.id } } }
      }
      if (k.name === "left") return to(at - 1)
      if (k.name === "right") return to(at + 1)
      if (k.name === "up") return to(at - cols)
      if (k.name === "down") return to(at + cols)
      if (k.name === "]" || k.name === "pagedown") return to((Math.floor(at / page) + 1) * page)
      if (k.name === "[" || k.name === "pageup") return to((Math.floor(at / page) - 1) * page)
      const card = cards[at]!
      if (k.name === "return") return { ui: openAgent(ui, w.s, card.id) }
      // The card's one action, on its agent.
      if (card.action !== undefined && k.name === card.action.key && k.ctrl !== true && k.meta !== true)
        return { ui, action: { type: "act", section: card.action.section, action: card.action.id, rows: card.action.rows, agent: card.id, view: card.id } }
      return "pass"
    },
  },
  {
    id: "review",
    when: (ui) => ui.focus === "tile" && ui.main === "review" && !ui.sheet,
    // The queue's actions are buttons under it: the status line keeps no view keys.
    hints: () => [{ keys: "Enter", does: "open agent" }, { keys: "Esc", does: "back" }],
    handle: (ui, w, k) => {
      if (k.name === "escape") return { ui: goBack(ui, w.s) }
      const c = common(ui, w, k)
      if (c !== undefined) return c
      const groups = reviewGroups(w.s)
      const rows = groups.flatMap((g) => g.rows)
      if (rows.length === 0) return "pass"
      const at = Math.min(ui.review.cursor, rows.length - 1)
      const to = (i: number) => ({ ui: { ...ui, review: { ...ui.review, cursor: Math.max(0, Math.min(rows.length - 1, i)) } } })
      if (k.name === "down") return to(at + 1)
      if (k.name === "up") return to(at - 1)
      if (k.name === "pagedown") return to(at + 10)
      if (k.name === "pageup") return to(at - 10)
      const row = rows[at]!
      if (k.name === "space") {
        const sel = ui.review.selected
        return { ui: { ...ui, review: { ...ui.review, selected: sel.includes(row.key) ? sel.filter((x) => x !== row.key) : [...sel, row.key] } } }
      }
      if (k.name === "return") return { ui: openAgent(ui, w.s, row.agent) }
      if (k.ctrl === true || k.meta === true) return "pass"
      const acts = reviewActs(groups, at, ui.review.selected, k.name)
      return acts.length === 0 ? "pass" : { ui: { ...ui, review: { ...ui.review, selected: [] } }, action: { type: "review-acts", acts } }
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
export const onKey = (ui: Ui, s: SessionState, key: Key, now: number, draft?: string, grid?: { readonly gridCols: number; readonly gridPage: number }) =>
  dispatch(SHELL, ui, { s, now, draft: draft ?? "", ...(grid ?? {}) }, key)
