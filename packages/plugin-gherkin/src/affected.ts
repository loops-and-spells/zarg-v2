import { diff, Snapshot } from "@zarg/graph/pure"
import { CARD, STATE } from "./model"

export interface Affected {
  /** Cards to (re)implement: added, changed, or using a state whose text changed. Sorted. */
  readonly cards: ReadonlyArray<string>
  /** Cards that no longer exist. Sorted. */
  readonly removed: ReadonlyArray<string>
}

/** Cards a graph change affects: what plan and implement must reconcile between `before` and `after`. */
export const affectedCards = (before: Snapshot.Snapshot, after: Snapshot.Snapshot): Affected => {
  const d = diff(before, after)
  const cards = new Set<string>()
  for (const n of d.added) if (n.type === CARD) cards.add(n.id)
  const withoutPlanned = (props: Readonly<Record<string, unknown>>) => {
    const { planned: _, ...rest } = props
    return JSON.stringify(rest)
  }
  for (const c of d.changed) {
    // Marking a card planned (or clearing it) changes nothing to implement.
    if (c.after.type === CARD && withoutPlanned(c.before.props) === withoutPlanned(c.after.props) && JSON.stringify(c.before.edges) === JSON.stringify(c.after.edges)) continue
    if (c.after.type === CARD) cards.add(c.id)
    // A reworded state changes every card that uses it (arrives, given or then).
    else if (c.after.type === STATE) for (const e of Snapshot.inbound(after, c.id)) if (after.nodes.get(e.from)?.type === CARD) cards.add(e.from)
  }
  const removed = d.removed.filter((n) => n.type === CARD).map((n) => n.id)
  return { cards: [...cards].sort(), removed: removed.sort() }
}
