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

/** What next once every outcome is served: rehearse the journeys first, then extend a journey from where it starts. */
// @scenario S-0014
export const nextWhenServed = (snap: Snapshot.Snapshot, focus?: ReadonlySet<string>): ReadonlyArray<NextOption> => [
  { id: "rehearse", label: "Rehearse the journeys", why: "testers walk them and file what they find", task: "The requirements are complete for now: start a rehearsal with Rehearse.run (testers walk the journeys and file feedback), then tell the developer it runs and where its feedback will show (Feedback)." },
  ...[...snap.nodes.values()]
    .filter((n) => n.type === "gherkin/state" && n.props.entry === true && (focus === undefined || focus.has(n.id)))
    .map((n): NextOption => ({ id: n.id, label: `Extend the journey from "${String(n.props.text ?? n.id)}"`, task: `Work on the journey that starts at "${String(n.props.text ?? n.id)}" (${n.id}).` })),
]
