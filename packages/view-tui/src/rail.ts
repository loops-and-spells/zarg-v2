import type { RlmNode, SessionState } from "@zarg/client"
import type { ThemeToken } from "@zarg/view"
import { fit } from "./look"
import { ARCHIVED, archivedNodes, childrenOf, cursorOf, ICON, isOpen, liveRlms, PULSE_MS, spin, type Ui, visible } from "./view"

/** How an agent is named on screen: a plugin agent by its own id (its run by the plugin's name), an RLM by preset and number, zarg as zarg. */
export const displayName = (n: RlmNode) => {
  const at = n.id.indexOf(":")
  if (at >= 0) return n.preset === n.id.slice(0, at) ? n.preset : n.id.slice(at + 1)
  // An RLM by its preset and number: the rail has no room for `rlm-`.
  return n.id === "zarg" ? "zarg" : `${n.preset} ${n.id.replace(/^rlm-/, "")}`
}
/** What is shown dim beside a name: the plugin, and the task's first line. */
export const contextOf = (n: RlmNode) => {
  const at = n.id.indexOf(":")
  const task = n.task?.split("\n")[0] ?? ""
  return [...(at >= 0 ? [n.id.slice(0, at)] : []), ...(task.length > 0 ? [task] : [])].join(" · ")
}

export interface RailRow {
  /** An agent id, ARCHIVED, or `archived:<id>`. */
  readonly id: string
  readonly depth: number
  readonly glyph: string
  readonly glyphToken: ThemeToken
  readonly name: string
  /** Right-aligned: progress, "asks", a count, how it ended. */
  readonly note: string
  /** A gauge under running work that reports its progress. */
  readonly gauge?: { readonly done: number; readonly total: number }
  readonly selected: boolean
  /** Finished and asking for nothing. */
  readonly dimmed: boolean
}

const NOTE = 8
const noteOf = (n: RlmNode, hidden: number, open: boolean) => {
  if (!open && hidden > 0) return `+${hidden}`
  if (n.attention !== undefined) return /^\d+/.exec(n.attention.reason)?.[0] ?? "asks"
  if (n.status === "running") return n.row?.progress !== undefined ? `${n.row.progress.done}/${n.row.progress.total}` : `${n.turns}/${n.budget}`
  return n.status
}

/** The rail: the live agents flat and indented, then a folded "archived" row with the agents it holds. */
export const railRows = (ui: Ui, s: SessionState, now: number | undefined, width: number): ReadonlyArray<RailRow> => {
  const live = liveRlms(s)
  const rows = visible(live, ui.agents)
  const cursor = cursorOf(rows, ui.agents)
  const kids = childrenOf(live)
  const depthOf = (n: RlmNode): number => (n.parent !== null && live[n.parent] !== undefined ? 1 + depthOf(live[n.parent]!) : 0)
  const blink = now !== undefined && Math.floor(now / PULSE_MS) % 2 === 1
  const out: Array<RailRow> = rows.map((r) => {
    const n = r.node
    const depth = depthOf(n)
    const hasKids = kids(n.id).length > 0
    const open = isOpen(live, ui.agents, n)
    const unseen = n.attention !== undefined && ui.seen[n.id] !== n.attention.since
    const glyph = n.attention !== undefined ? (unseen && blink ? "◇" : "◆") : hasKids ? (open ? "▾" : "▸") : n.status === "running" ? (now !== undefined ? spin(now) : "⠼") : ICON[n.status]
    const glyphToken: ThemeToken = n.attention !== undefined ? "attention" : n.status === "running" ? "accent" : n.status === "failed" ? "error" : "dim"
    const note = noteOf(n, r.hidden.length, open)
    const room = Math.max(4, width - depth * 2 - 2 - Math.min(NOTE, note.length) - 1)
    return {
      id: n.id,
      depth,
      glyph,
      glyphToken,
      name: fit(displayName(n), room),
      note: fit(note, NOTE),
      ...(n.status === "running" && n.row?.progress !== undefined ? { gauge: n.row.progress } : {}),
      selected: n.id === cursor,
      dimmed: n.status !== "running" && n.attention === undefined,
    }
  })
  const arch = archivedNodes(s)
  if (arch.length === 0) return out
  const openArch = ui.agents.toggled[ARCHIVED] === true
  out.push({ id: ARCHIVED, depth: 0, glyph: openArch ? "▾" : "▸", glyphToken: "dim", name: "archived", note: String(arch.length), selected: ui.agents.cursor === ARCHIVED, dimmed: true })
  if (openArch)
    for (const a of arch)
      out.push({ id: `archived:${a.node.id}`, depth: 1, glyph: ICON[a.node.status], glyphToken: a.node.status === "failed" ? "error" : "dim", name: fit(displayName(a.node), Math.max(4, width - 2 - 2 - NOTE - 1)), note: fit(a.reason, NOTE), selected: ui.agents.cursor === `archived:${a.node.id}`, dimmed: true })
  return out
}
