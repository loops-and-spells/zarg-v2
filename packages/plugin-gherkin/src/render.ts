import { type Node, Snapshot } from "@zarg/graph/pure"
import { ARRIVES, BY, scenarios, GIVEN, IN, journeyName, personaName, states, text, THEN } from "./model"

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
  const parts = shown.map((c) => renderScenario(snap, c))
  if (unused.length > 0) parts.push(["States without scenarios:", ...unused.map((s) => `  ${s.id} ${text(s)}`)].join("\n"))
  return parts.join("\n\n")
}
