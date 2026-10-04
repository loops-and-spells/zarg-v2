import { Snapshot } from "@zarg/graph/pure"

export { scenarioVersion } from "@zarg/audit/version"
export const scenarioLabel = (snap: Snapshot.Snapshot, id: string) => {
  const c = snap.nodes.get(id)
  return c === undefined ? undefined : `${id} ${String(c.props.title ?? "")}`.trim()
}
