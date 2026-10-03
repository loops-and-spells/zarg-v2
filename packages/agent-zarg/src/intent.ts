import type { Snapshot } from "@zarg/graph/pure"

/** One way to go on, offered when nothing is open: what the operator picks becomes their word to the driver. */
export interface NextOption {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly task: string
}

/** What next: every outcome no journey serves, in id order, with the intent it belongs to. */
export const nextOutcomes = (snap: Snapshot.Snapshot): ReadonlyArray<NextOption> => {
  const nodes = [...snap.nodes.values()]
  const served = new Set(nodes.flatMap((n) => (n.type === "gherkin/journey" ? n.edges.filter((e) => e.type === "gherkin/serves").map((e) => e.to) : [])))
  const intentOf = (id: string) => nodes.find((n) => n.type === "gherkin/intent" && n.edges.some((e) => e.type === "gherkin/has" && e.to === id))
  return nodes
    .filter((n) => n.type === "gherkin/outcome" && !served.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => {
      const text = String(o.props.text ?? o.id)
      const intent = intentOf(o.id)
      return { id: o.id, label: text, ...(intent !== undefined ? { why: String(intent.props.title ?? intent.id) } : {}), task: `Find or shape the journey that delivers ${o.id} (${text}), then link it with link {edge: "serves", journey, outcome: "${o.id}"}.` }
    })
}
