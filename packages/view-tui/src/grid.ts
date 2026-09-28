import type { TokenKey } from "@zarg/tokens"
import type { RlmNode, SessionState } from "@zarg/client"
import { keyFor, rowsOf, type ViewState } from "@zarg/view"
import { contextOf, displayName } from "./rail"
import { ICON, liveRlms, type Ui } from "./view"

/** An agent as the grid shows it. */
export interface Card {
  readonly id: string
  readonly glyph: string
  readonly glyphToken: TokenKey
  readonly name: string
  readonly context: string
  /** The card's stats headline (value and label), or the row's text. */
  readonly headline?: string
  readonly gauge?: { readonly done: number; readonly total: number }
  /** Up to three recent lines. */
  readonly recent: ReadonlyArray<{ readonly text: string; readonly tone?: string }>
  /** The card's one action: run with its key, on the section that holds it. */
  readonly action?: { readonly id: string; readonly label: string; readonly key: string; readonly section?: string; readonly rows: ReadonlyArray<string> }
  /** No view yet. */
  readonly starting: boolean
  readonly attention: boolean
}

type Leaf = { readonly id: string; readonly kind: string; readonly actions?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>>; readonly on: string }> }
/** Every leaf of a view with its path (`tabs.tab` inside tabs). */
const leaves = (v: ViewState): ReadonlyArray<{ readonly path: string; readonly leaf: Leaf }> =>
  v.layout.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs.map((t) => ({ path: `${s.id}.${t.id}`, leaf: t as Leaf })) : [{ path: s.id, leaf: s as Leaf }]))

const recentOf = (v: ViewState, path: string, kind: string): Card["recent"] => {
  const d = v.data[path] as { lines?: ReadonlyArray<{ text: string; tone?: string }>; items?: ReadonlyArray<{ text: string; tone?: string }>; rows?: ReadonlyArray<{ cells: Record<string, string>; tone?: string }> } | undefined
  const all =
    kind === "log" ? (d?.lines ?? []).map((l) => ({ text: l.text, ...(l.tone !== undefined ? { tone: l.tone } : {}) }))
    : kind === "list" ? (d?.items ?? []).map((i) => ({ text: i.text, ...(i.tone !== undefined ? { tone: i.tone } : {}) }))
    : (d?.rows ?? []).map((r) => ({ text: Object.values(r.cells).join("  "), ...(r.tone !== undefined ? { tone: r.tone } : {}) }))
  return all.slice(-3)
}

const cardOf = (ui: Ui, s: SessionState, n: RlmNode): Card => {
  const v = s.thread.views?.[n.id]
  const unseen = n.attention !== undefined && ui.seen[n.id] !== n.attention.since
  const base = {
    id: n.id,
    glyph: n.attention !== undefined ? "◆" : n.status === "running" ? "⠼" : ICON[n.status],
    glyphToken: (n.attention !== undefined ? "attention" : n.status === "running" ? "accent" : n.status === "failed" ? "error" : "dim") as TokenKey,
    name: displayName(n),
    context: contextOf(n),
    starting: v === undefined,
    attention: unseen || n.attention !== undefined,
  }
  const card = v?.layout.card
  // No card declared: the agent's row (its text, its progress), nothing guessed from the view.
  if (v === undefined || card === undefined)
    return {
      ...base,
      headline: n.attention?.reason ?? n.row?.text ?? `${n.turns}/${n.budget}`,
      ...(n.row?.progress !== undefined ? { gauge: n.row.progress } : {}),
      recent: [],
    }
  const all = leaves(v)
  const stats = v.data[card.headline] as { items?: ReadonlyArray<{ label: string; value: string }>; progress?: { done: number; total: number } } | undefined
  const first = stats?.items?.[0]
  const recent = card.recent === undefined ? undefined : all.find((l) => l.path === card.recent)
  const holder = card.action === undefined ? undefined : all.find((l) => (l.leaf.actions ?? []).some((a) => a.id === card.action))
  const a = holder?.leaf.actions?.find((x) => x.id === card.action) ?? v.layout.actions?.find((x) => x.id === card.action)
  const key = a === undefined ? undefined : keyFor(a, "terminal")
  const rows = holder === undefined || a?.on === "none" ? [] : rowsOf(v, holder.path).slice(0, 1).map((r) => r.id)
  return {
    ...base,
    ...(n.attention !== undefined ? { headline: n.attention.reason } : first !== undefined ? { headline: `${first.value} ${first.label}` } : {}),
    ...(stats?.progress !== undefined ? { gauge: stats.progress } : {}),
    recent: recent === undefined ? [] : recentOf(v, recent.path, recent.leaf.kind),
    ...(a !== undefined && key !== undefined ? { action: { id: a.id, label: a.label, key, ...(holder !== undefined ? { section: holder.path } : {}), rows } } : {}),
  }
}

/** Every top-level live plugin agent as a card: attention (unseen first), then running, then finished. zarg and its RLMs are the conversation. */
export const gridCards = (ui: Ui, s: SessionState): ReadonlyArray<Card> => {
  const live = liveRlms(s)
  // One card per top-level agent: an agent under another live agent (a tester under its run) shows inside its parent.
  const nodes = Object.values(live).filter((n) => n.id.includes(":") && (n.parent === null || live[n.parent] === undefined))
  const rank = (n: RlmNode) => (n.attention !== undefined ? (ui.seen[n.id] !== n.attention.since ? 0 : 1) : n.status === "running" ? 2 : 3)
  return nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map(({ n }) => cardOf(ui, s, n))
}

/** How many cards fit in the focus area: about 44×10 a card, two columns once there are 68, one on a narrow terminal; at least two rows. */
export const gridShape = (width: number, height: number, narrow = false) => ({
  cols: narrow ? 1 : Math.max(width >= 68 ? 2 : 1, Math.floor(width / 44)),
  rows: Math.max(2, Math.floor(height / 10)),
})

/** Where the grid's cursor is: on its agent's card when that card still shows, else its last place. */
export const gridCursor = (ui: Ui, cards: ReadonlyArray<Card>) => {
  const byId = ui.grid.id === undefined ? -1 : cards.findIndex((c) => c.id === ui.grid.id)
  return byId >= 0 ? byId : Math.max(0, Math.min(ui.grid.cursor, cards.length - 1))
}
