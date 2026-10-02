import { diff, Snapshot } from "@zarg/graph/pure"
import { SCENARIO, STATE } from "./model"

export interface Affected {
  /** Scenarios to (re)implement: added, changed, or using a state whose text changed. Sorted. */
  readonly scenarios: ReadonlyArray<string>
  /** Scenarios that no longer exist. Sorted. */
  readonly removed: ReadonlyArray<string>
}

/** Scenarios a graph change affects: what plan and implement must reconcile between `before` and `after`. */
export const affectedScenarios = (before: Snapshot.Snapshot, after: Snapshot.Snapshot): Affected => {
  const d = diff(before, after)
  const scenarios = new Set<string>()
  for (const n of d.added) if (n.type === SCENARIO) scenarios.add(n.id)
  const withoutPlanned = (props: Readonly<Record<string, unknown>>) => {
    const { planned: _, ...rest } = props
    return JSON.stringify(rest)
  }
  for (const c of d.changed) {
    // Marking a scenario planned (or clearing it) changes nothing to implement.
    if (c.after.type === SCENARIO && withoutPlanned(c.before.props) === withoutPlanned(c.after.props) && JSON.stringify(c.before.edges) === JSON.stringify(c.after.edges)) continue
    if (c.after.type === SCENARIO) scenarios.add(c.id)
    // A reworded state changes every scenario that uses it (arrives, given or then).
    else if (c.after.type === STATE) for (const e of Snapshot.inbound(after, c.id)) if (after.nodes.get(e.from)?.type === SCENARIO) scenarios.add(e.from)
  }
  const removed = d.removed.filter((n) => n.type === SCENARIO).map((n) => n.id)
  return { scenarios: [...scenarios].sort(), removed: removed.sort() }
}
