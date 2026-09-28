import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, cards, IN, journeyName, THEN } from "./model"
import { renderCard } from "./render"

/** Every journey with its cards, for the Journeys view. */
export const journeyList = (snap: Snapshot.Snapshot) =>
  Snapshot.byType(snap, "gherkin/journey").map((j) => ({ id: j.id, name: journeyName(j), cards: Snapshot.inbound(snap, j.id, IN).map((e) => e.from).sort() }))

/**
 * A journey's cards as Gherkin, in the order the graph's states lead from one to the next: branches where a state
 * leads to several of its cards, "↺ back to" where a card leads to one already on the way, and cards linked to none
 * of the others listed apart. Only the journey's own cards and the graph's own links: nothing is left out or made up.
 */
export const journeyFlow = (snap: Snapshot.Snapshot, journey: string): string => {
  const node = snap.nodes.get(journey)
  const own = new Set(Snapshot.inbound(snap, journey, IN).map((e) => e.from))
  const members = cards(snap).filter((c) => own.has(c.id)).map((c) => c.id)
  const head = `${node === undefined ? journey : journeyName(node)}  # ${journey} · ${members.length} card${members.length === 1 ? "" : "s"}`
  if (members.length === 0) return `${head}\n\nNo cards in this journey yet.`
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
    const lines = [renderCard(snap, snap.nodes.get(c)!)]
    if (on.length === 1) lines.push(`→ ${on[0]}${done.has(on[0]!) ? " (above)" : ""}`)
    if (on.length > 1) lines.push(`→ ${on.map((n) => `${n}${done.has(n) ? " (above)" : ""}`).join(" or ")} (branches)`)
    for (const b of back) lines.push(`↺ back to ${b}`)
    blocks.push(lines.join("\n"))
    for (const n of on) if (!done.has(n)) walk(n)
    path.delete(c)
  }
  // Starts: cards none of the journey's cards lead to; then whatever a loop keeps unreached.
  for (const c of members) if (!alone.includes(c) && !hasPred(c) && !done.has(c)) walk(c)
  for (const c of members) if (!alone.includes(c) && !done.has(c)) walk(c)
  const apart = alone.map((c) => renderCard(snap, snap.nodes.get(c)!))
  return [head, ...blocks, ...(apart.length > 0 ? ["Not connected to the journey's other cards:", ...apart] : [])].join("\n\n")
}
