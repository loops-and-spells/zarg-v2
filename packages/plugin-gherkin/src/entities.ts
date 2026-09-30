import { versionOf } from "@zarg/entities"
import { Snapshot } from "@zarg/graph/pure"

/** What a tester reads of a card: the card, its states' text by role, its personas' names (not the journeys it is in). */
const reads = (snap: Snapshot.Snapshot, id: string) => {
  const card = snap.nodes.get(id)
  if (card === undefined || card.type !== "gherkin/card") return undefined
  const text = (to: string) => String(snap.nodes.get(to)?.props.text ?? snap.nodes.get(to)?.props.name ?? to)
  // planned says whether code exists yet, not what the card says: it leaves the version alone.
  const { planned: _, ...props } = card.props
  return { props, steps: card.edges.filter((e) => e.type !== "gherkin/in").map((e) => ({ edge: e.type, to: e.to, text: text(e.to) })) }
}
/** A card's version: rewording a state it uses, or renaming a persona in it, changes it. */
export const cardVersion = (snap: Snapshot.Snapshot, id: string) => {
  const r = reads(snap, id)
  return r === undefined ? undefined : versionOf(r)
}
export const cardLabel = (snap: Snapshot.Snapshot, id: string) => {
  const c = snap.nodes.get(id)
  return c === undefined ? undefined : `${id} ${String(c.props.title ?? "")}`.trim()
}
