import { versionOf } from "@zarg/entities"
import { Snapshot } from "@zarg/graph/pure"

/** What a tester reads of a scenario: the scenario, its states' text by role, its personas' names (not the journeys it is in). */
const reads = (snap: Snapshot.Snapshot, id: string) => {
  const scenario = snap.nodes.get(id)
  if (scenario === undefined || scenario.type !== "gherkin/scenario") return undefined
  const text = (to: string) => String(snap.nodes.get(to)?.props.text ?? snap.nodes.get(to)?.props.name ?? to)
  // planned says whether code exists yet, not what the scenario says: it leaves the version alone.
  const { planned: _, ...props } = scenario.props
  return { props, steps: scenario.edges.filter((e) => e.type !== "gherkin/in").map((e) => ({ edge: e.type, to: e.to, text: text(e.to) })) }
}
/** A scenario's version: rewording a state it uses, or renaming a persona in it, changes it. */
export const scenarioVersion = (snap: Snapshot.Snapshot, id: string) => {
  const r = reads(snap, id)
  return r === undefined ? undefined : versionOf(r)
}
