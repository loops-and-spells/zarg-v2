import { diff, Snapshot } from "@zarg/graph/pure"
import { IN, SCENARIO, STATE } from "./model"

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
  // What a scenario's code depends on: its words and its edges, not whether it is planned nor which journeys hold it.
  const behaviour = (n: { readonly props: Readonly<Record<string, unknown>>; readonly edges: ReadonlyArray<{ readonly type: string; readonly to: string }> }) => {
    const { planned: _, ...props } = n.props
    return JSON.stringify([props, n.edges.filter((e) => e.type !== IN)])
  }
  for (const c of d.changed) {
    if (c.after.type === SCENARIO && behaviour(c.before) !== behaviour(c.after)) scenarios.add(c.id)
    // A reworded state changes every scenario that uses it (arrives, given or then); marking it entry or terminal does not.
    else if (c.after.type === STATE && c.before.props.text !== c.after.props.text) for (const e of Snapshot.inbound(after, c.id)) if (after.nodes.get(e.from)?.type === SCENARIO) scenarios.add(e.from)
  }
  const removed = d.removed.filter((n) => n.type === SCENARIO).map((n) => n.id)
  return { scenarios: [...scenarios].sort(), removed: removed.sort() }
}
