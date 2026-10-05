import type { Effect } from "effect"
import type { Snapshot } from "@zarg/graph/pure"

/** One way to go on, offered when nothing is open: what the operator picks becomes their word to the driver. */
export interface NextOption {
  readonly id: string
  readonly label: string
  readonly why?: string
  readonly task: string
  /** It starts work elsewhere (a rehearsal): once its item ends, zarg waits for that work's results rather than ask again. */
  readonly waits?: boolean
  /** zarg does it itself when picked (no driver item): what it says back. zarg then waits, as for `waits`. */
  readonly run?: Effect.Effect<string>
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

const REHEARSE: NextOption = { id: "rehearse", label: "Rehearse the journeys", why: "testers walk them and file what they find", task: "The requirements are complete for now: start a rehearsal now with Rehearse.run({}) (its defaults: testers walk each journey and file feedback; never ask which strategy), then finish: your reply tells the developer it runs and that its feedback will show in Feedback. Never ask about the run: zarg takes up what it files when it ends.", waits: true }
/** Build the scenarios: reconcile on (zarg turns it on, `run`), or the operator's /reconcile when zarg cannot. */
const build = (run?: Effect.Effect<string>): NextOption => ({
  id: "build",
  label: run !== undefined ? "Build the scenarios" : "Build the scenarios (/reconcile)",
  why: "nothing is built yet: reconcile implements, verifies and commits each one; rehearse walks only built scenarios",
  task: "Nothing is built yet: no scenario has code tagged to it. Tell the developer that /reconcile turns on building (zarg implements each scenario, verifies and commits it), and that rehearsing waits for it.",
  ...(run !== undefined ? { run } : {}),
})

/**
 * What next once every outcome is served: rehearse the journeys first (build them first when no scenario is built: `built`,
 * the scenarios with code tagged), then extend a journey from where it starts.
 */
// @scenario S-0014
export const nextWhenServed = (snap: Snapshot.Snapshot, focus?: ReadonlySet<string>, built?: ReadonlySet<string>, reconcileOn = false, turnOn?: Effect.Effect<string>): ReadonlyArray<NextOption> => {
  const nodes = [...snap.nodes.values()]
  const scenarios = nodes.filter((n) => n.type === "gherkin/scenario" && n.props.planned !== true)
  // Reconcile on: a pass builds them, nothing to offer.
  const unbuilt = !reconcileOn && built !== undefined && scenarios.length > 0 && !scenarios.some((n) => built.has(n.id))
  return [
    ...(unbuilt ? [build(turnOn)] : []),
    REHEARSE,
    ...nodes
      .filter((n) => n.type === "gherkin/state" && n.props.entry === true && (focus === undefined || focus.has(n.id)))
      .map((n): NextOption => ({ id: n.id, label: `Extend the journey from "${String(n.props.text ?? n.id)}"`, task: `Work on the journey that starts at "${String(n.props.text ?? n.id)}" (${n.id}).` })),
  ]
}
