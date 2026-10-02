import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, scenarios, IN, journeyName, THEN } from "./model"
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
  const arrivesOf = (c: string) => snap.nodes.get(c)?.edges.find((e) => e.type === ARRIVES)?.to
  const thensOf = (c: string) => new Set((snap.nodes.get(c)?.edges ?? []).filter((e) => e.type === THEN).map((e) => e.to))
  const next = (c: string) => members.filter((n) => thensOf(c).has(arrivesOf(n) ?? ""))
  const hasPred = (c: string) => members.some((p) => next(p).includes(c))
  const alone = members.filter((c) => next(c).length === 0 && !hasPred(c))
  const blocks: Array<string> = []
  const done = new Set<string>()
  const path = new Set<string>()
  const walk = (c: string) => {
    done.add(c)
    path.add(c)
    const ns = next(c)
    const back = ns.filter((n) => path.has(n))
    const on = ns.filter((n) => !path.has(n))
    const lines = [renderScenario(snap, snap.nodes.get(c)!)]
    if (on.length === 1) lines.push(`→ ${on[0]}${done.has(on[0]!) ? " (above)" : ""}`)
    if (on.length > 1) lines.push(`→ ${on.map((n) => `${n}${done.has(n) ? " (above)" : ""}`).join(" or ")} (branches)`)
    for (const b of back) lines.push(`↺ back to ${b}`)
    blocks.push(lines.join("\n"))
    for (const n of on) if (!done.has(n)) walk(n)
    path.delete(c)
  }
  // Starts: scenarios none of the journey's scenarios lead to; then whatever a loop keeps unreached.
  for (const c of members) if (!alone.includes(c) && !hasPred(c) && !done.has(c)) walk(c)
  for (const c of members) if (!alone.includes(c) && !done.has(c)) walk(c)
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
