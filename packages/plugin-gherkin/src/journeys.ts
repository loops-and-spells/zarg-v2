import { Snapshot } from "@zarg/graph/pure"
import { flowOf } from "@zarg/audit/flow"
import { IN, journeyName, scenarios } from "./model"
import { renderScenario } from "./render"

/** Every journey with its scenarios, for the Journeys view. */
export const journeyList = (snap: Snapshot.Snapshot) =>
  Snapshot.byType(snap, "gherkin/journey").map((j) => ({ id: j.id, name: journeyName(j), scenarios: Snapshot.inbound(snap, j.id, IN).map((e) => e.from).sort() }))

/**
 * A journey's scenarios as Gherkin, in the order the graph's states lead from one to the next: branches where a state
 * leads to several of its scenarios, "↺ back to" where a scenario leads to one already on the way, and scenarios linked to none
 * of the others listed apart. Only the journey's own scenarios and the graph's own links: nothing is left out or made up.
 */
export const journeyFlow = (snap: Snapshot.Snapshot, journey: string): string => {
  const node = snap.nodes.get(journey)
  const own = new Set(Snapshot.inbound(snap, journey, IN).map((e) => e.from))
  const members = scenarios(snap).filter((c) => own.has(c.id)).map((c) => c.id)
  const head = `${node === undefined ? journey : journeyName(node)}  # ${journey} · ${members.length} scenario${members.length === 1 ? "" : "s"}`
  if (members.length === 0) return `${head}\n\nNo scenarios in this journey yet.`
  const { steps, apart: alone } = flowOf(snap, journey)
  const order = new Map(steps.map((st, i) => [st.id, i]))
  const blocks = steps.map((st, i) => {
    // A scenario walked before this one is "(above)".
    const at = (n: string) => `${n}${(order.get(n) ?? i) < i ? " (above)" : ""}`
    const lines = [renderScenario(snap, snap.nodes.get(st.id)!)]
    if (st.next.length === 1) lines.push(`→ ${at(st.next[0]!)}`)
    if (st.next.length > 1) lines.push(`→ ${st.next.map(at).join(" or ")} (branches)`)
    for (const b of st.back) lines.push(`↺ back to ${b}`)
    return lines.join("\n")
  })
  const apart = alone.map((c) => renderScenario(snap, snap.nodes.get(c)!))
  return [head, ...blocks, ...(apart.length > 0 ? ["Not connected to the journey's other scenarios:", ...apart] : [])].join("\n\n")
}

/** The Journeys view's data: journeys by name with their scenario counts, and every journey's flow by its row. */
export const journeysView = (snap: Snapshot.Snapshot) => {
  const all = [...journeyList(snap)].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const scenariosIn = new Set(all.flatMap((j) => j.scenarios))
  return {
    summary: { items: [{ label: all.length === 1 ? "journey" : "journeys", value: String(all.length) }, { label: scenariosIn.size === 1 ? "scenario" : "scenarios", value: String(scenariosIn.size) }] },
    rows: all.map((j) => ({ id: j.id, cells: { name: j.name, scenarios: String(j.scenarios.length) } })),
    flows: Object.fromEntries(all.map((j) => [j.id, `\`\`\`gherkin\n${journeyFlow(snap, j.id)}\n\`\`\``])) as Record<string, string>,
  }
}
