import { type Node, Snapshot } from "@zarg/graph/pure"
import { ARRIVES, BOUNDS, BY, CONSTRAINT, FOR, GIVEN, IN, intents, journeyName, OUTCOME, personaName, QUESTION, scenarios, SERVES, statementsOf, states, text, THEN } from "./model"

const line = (keyword: string, snap: Snapshot.Snapshot, id: string) => {
  const state = snap.nodes.get(id)
  return `  ${keyword.padEnd(5)} ${state === undefined ? `<missing ${id}>` : text(state)}  # ${id}`
}

/** One scenario as Gherkin: title, By and In lines when it has them, Given / And / When / Then / And. */
export const renderScenario = (snap: Snapshot.Snapshot, scenario: Node): string => {
  const targets = (type: string) => Snapshot.out(snap, scenario.id, type).map((e) => e.to)
  const givens = [...targets(ARRIVES), ...targets(GIVEN)]
  const thens = targets(THEN)
  const by = targets(BY)
  const tags = targets(IN)
  const names = by.map((id) => { const n = snap.nodes.get(id); return n === undefined ? `<missing ${id}>` : personaName(n) })
  return [
    `${scenario.id} ${String(scenario.props.title)}`,
    ...(scenario.props.planned === true ? ["  Status planned"] : []),
    ...(by.length > 0 ? [`  By    ${names.join(", ")}  # ${by.join(", ")}`] : []),
    ...(tags.length > 0 ? [`  In    ${tags.map((id) => { const n = snap.nodes.get(id); return n === undefined ? `<missing ${id}>` : journeyName(n) }).join(", ")}  # ${tags.join(", ")}`] : []),
    ...givens.map((id, i) => line(i === 0 ? "Given" : "And", snap, id)),
    `  When  ${String(scenario.props.when)}`,
    ...thens.map((id, i) => line(i === 0 ? "Then" : "And", snap, id)),
  ].join("\n")
}

/** Gherkin text for every scenario (or those touching `focus`), then states no scenario uses. */
// @scenario S-0002
export const render = (snap: Snapshot.Snapshot, focus?: ReadonlySet<string>): string => {
  const shown = scenarios(snap).filter(
    (c) => focus === undefined || focus.has(c.id) || c.edges.some((e) => focus.has(e.to)),
  )
  const unused = states(snap).filter(
    (s) => Snapshot.inbound(snap, s.id).length === 0 && (focus === undefined || focus.has(s.id)),
  )
  // Intents only when asked for: an intent, or one of its statements, in focus.
  const shownIntents = focus === undefined ? [] : intents(snap).filter((i) => focus.has(i.id) || statementsOf(snap, i.id).some((s) => focus.has(s.id)))
  const parts = [...shownIntents.map((i) => renderIntent(snap, i)), ...shown.map((c) => renderScenario(snap, c))]
  if (unused.length > 0) parts.push(["States without scenarios:", ...unused.map((s) => `  ${s.id} ${text(s)}`)].join("\n"))
  // Nothing to render is said, never an empty string (a reader took it for an empty graph, intents and all).
  if (parts.length === 0 && focus === undefined) {
    const all = intents(snap)
    return ["No scenarios yet.", ...(all.length > 0 ? [`Intents: ${all.map((i) => `${i.id} ${String(i.props.title ?? "")}`).join("; ")} (render with its id in focus for its outcomes, constraints and questions)`] : [])].join("\n")
  }
  return parts.join("\n\n")
}

const KEYWORD: Readonly<Record<string, string>> = { [OUTCOME]: "Outcome", [CONSTRAINT]: "Constraint", [QUESTION]: "Question" }

/** One intent: status, who it is for, then each statement with what serves it (←), what it bounds (→) or whether it is open. */
export const renderIntent = (snap: Snapshot.Snapshot, intent: Node): string => {
  const pad = (k: string) => k.padEnd(10)
  const name = (id: string) => {
    const n = snap.nodes.get(id)
    return n === undefined ? `<missing ${id}>` : String(n.props.name ?? n.props.title ?? n.props.text ?? id)
  }
  const fors = Snapshot.out(snap, intent.id, FOR).map((e) => e.to)
  const line = (s: Node) => {
    const served = Snapshot.inbound(snap, s.id, SERVES).map((e) => e.from).sort()
    const bounds = s.edges.filter((e) => e.type === BOUNDS).map((e) => e.to)
    const why =
      s.type === OUTCOME ? ` ← ${served.length > 0 ? served.join(", ") : "no journey"}`
      : s.type === CONSTRAINT ? (bounds.length > 0 ? ` → ${bounds.join(", ")}` : "")
      : s.props.answer !== undefined ? ` (answered: ${String(s.props.answer)})` : " (open)"
    return `  ${pad(KEYWORD[s.type] ?? s.type)} ${text(s)}  # ${s.id}${why}`
  }
  return [
    `${intent.id} ${String(intent.props.title)}`,
    `  ${pad("Status")} ${String(intent.props.status)}`,
    ...(fors.length > 0 ? [`  ${pad("For")} ${fors.map(name).join(", ")}  # ${fors.join(", ")}`] : []),
    ...statementsOf(snap, intent.id).map(line),
  ].join("\n")
}
