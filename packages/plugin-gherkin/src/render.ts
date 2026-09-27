import { type Node, Snapshot } from "@zarg/graph/pure"
import { ARRIVES, cards, GIVEN, states, text, THEN } from "./model"

const line = (keyword: string, snap: Snapshot.Snapshot, id: string) => {
  const state = snap.nodes.get(id)
  return `  ${keyword.padEnd(5)} ${state === undefined ? `<missing ${id}>` : text(state)}  # ${id}`
}

const renderCard = (snap: Snapshot.Snapshot, card: Node): string => {
  const targets = (type: string) => Snapshot.out(snap, card.id, type).map((e) => e.to)
  const givens = [...targets(ARRIVES), ...targets(GIVEN)]
  const thens = targets(THEN)
  return [
    `${card.id} ${String(card.props.title)}`,
    ...givens.map((id, i) => line(i === 0 ? "Given" : "And", snap, id)),
    `  When  ${String(card.props.when)}`,
    ...thens.map((id, i) => line(i === 0 ? "Then" : "And", snap, id)),
  ].join("\n")
}

/** Gherkin text for every card (or those touching `focus`), then states no card uses. */
// @card UX-0002
export const render = (snap: Snapshot.Snapshot, focus?: ReadonlySet<string>): string => {
  const shown = cards(snap).filter(
    (c) => focus === undefined || focus.has(c.id) || c.edges.some((e) => focus.has(e.to)),
  )
  const unused = states(snap).filter(
    (s) => Snapshot.inbound(snap, s.id).length === 0 && (focus === undefined || focus.has(s.id)),
  )
  const parts = shown.map((c) => renderCard(snap, c))
  if (unused.length > 0) parts.push(["States without cards:", ...unused.map((s) => `  ${s.id} ${text(s)}`)].join("\n"))
  return parts.join("\n\n")
}
