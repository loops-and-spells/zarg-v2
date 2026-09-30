import { parseRef } from "@zarg/entities"
import { target } from "./feedback"

export const LANES = ["backlog", "ready", "running", "review", "done"] as const
export type Lane = (typeof LANES)[number]
export const LANE_TITLES: Readonly<Record<Lane, string>> = { backlog: "Backlog", ready: "Ready", running: "Running", review: "Review", done: "Done" }

/** A plan on the board: the card changes it drafted, the feedback it closes, and how it moves (every move an event). */
export interface Item {
  readonly id: string
  readonly title: string
  readonly journey: string
  /** The cards it changes, each a ref with the version the plan was drafted on. */
  readonly cards: ReadonlyArray<{ readonly ref: string; readonly to?: string }>
  /** The drafted changes: gherkin tool calls the Planner applies. */
  readonly changes: ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
  readonly feedback: ReadonlyArray<string>
  readonly steps: ReadonlyArray<string>
  readonly status: Lane
  readonly agent?: string
  readonly after?: ReadonlyArray<string>
  readonly persona?: string
  readonly severity?: "high" | "medium" | "low"
  readonly events: ReadonlyArray<{ readonly what: string; readonly by: string }>
  /** Dropped: off the board, its feedback open again. */
  readonly dropped?: boolean
  /** Why it needs the operator (an apply that failed), until it moves again. */
  readonly needs?: string
  /** A code plan: the code must change to match the card (the Planner never takes it). */
  readonly kind?: "graph" | "code"
}

export const ITEM_ID = /^B-\d{2,}$/
export const nextId = (items: ReadonlyArray<Item>) => `B-${String(Math.max(0, ...items.map((i) => Number(i.id.slice(2)) || 0)) + 1).padStart(2, "0")}`
const order = (i: Item) => Number(i.id.slice(2)) || 0

/** The lane beside this one (the ends stay put). */
export const neighbour = (lane: Lane, dir: 1 | -1): Lane => LANES[Math.max(0, Math.min(LANES.length - 1, LANES.indexOf(lane) + dir))]!

/** An item moved to a lane, the move recorded. */
export const moved = (item: Item, to: Lane, by: string, what?: string): Item => {
  const { agent: _, needs: __, ...rest } = item
  // A note on a plan already in the lane (the Planner's commit) is its own event.
  const what_ = item.status === to ? (what ?? to) : `${item.status} → ${to}${what !== undefined ? `: ${what}` : ""}`
  return { ...rest, status: to, ...(to === "running" || to === "review" ? { agent: by } : {}), events: [...item.events, { what: what_, by }] }
}

/** Items it waits for that are not done (a missing one no longer holds it back; a dropped one does, until it is dropped too or resynced). */
export const waitingOn = (item: Item, all: ReadonlyArray<Item>) =>
  (item.after ?? []).filter((id) => {
    const x = all.find((i) => i.id === id)
    return x !== undefined && x.status !== "done"
  })

/** Its changed refs that count: a card a plan it waits on also touches changes by design when that plan applies. */
export const stale = (item: Item, all: ReadonlyArray<Item>, changed: ReadonlySet<string>) => {
  const theirs = new Set(all.filter((i) => (item.after ?? []).includes(i.id)).flatMap((i) => i.cards.map((c) => target(c.ref))))
  return new Set(item.cards.map((c) => c.ref).filter((r) => changed.has(r) && !theirs.has(target(r))))
}

/** The Planner's next: the oldest Ready item whose after items are done and whose cards have not changed since it was drafted. */
export const pickNext = (items: ReadonlyArray<Item>, changed: (ref: string) => boolean) =>
  [...items]
    .filter((i) => i.status === "ready" && i.kind !== "code" && i.dropped !== true && i.needs === undefined && waitingOn(i, items).length === 0 && stale(i, items, new Set(i.cards.map((c) => c.ref).filter(changed))).size === 0)
    .sort((a, b) => order(a) - order(b))[0]

/** How an item shows on the board: its stripe, top line, badge, then who it is for, who works it, why it waits. */
export const boardCard = (item: Item, all: ReadonlyArray<Item>, changedRefs: ReadonlySet<string>) => {
  const card = item.cards[0] === undefined ? undefined : parseRef(item.cards[0].ref)?.id
  const waits = waitingOn(item, all)
  const changed = (item.status === "backlog" || item.status === "ready") && stale(item, all, changedRefs).size > 0
  return {
    id: item.id,
    title: item.title,
    ...(item.severity !== undefined ? { tone: `severity.${item.severity}` as const } : {}),
    top: card === undefined ? item.id : `${item.id} ${card}`,
    badge: `◇${item.feedback.length}`,
    lines: [
      ...(item.persona !== undefined ? [{ text: item.persona, tone: "persona" as const }] : []),
      ...(item.kind === "code" ? [{ text: "code change", tone: "accent" as const }] : []),
      ...(item.status === "running" && item.agent !== undefined ? [{ text: `⠼ ${item.agent}`, tone: "accent" as const }] : []),
      ...(waits.length > 0 && item.status !== "done" ? [{ text: `⇠ after ${waits.map((id) => (all.find((i) => i.id === id)?.dropped === true ? `${id} (dropped)` : id)).join(", ")}`, tone: "error" as const }] : []),
      ...(changed ? [{ text: "⚠ card changed", tone: "attention" as const }] : []),
    ],
  }
}
