import { Snapshot } from "@zarg/graph/pure"

export type FlowStep = { readonly id: string; readonly next: ReadonlyArray<string>; readonly back: ReadonlyArray<string> }

/**
 * A journey's scenarios in the order the graph's states lead from one to the next: depth first from scenarios none of
 * the others lead to, each with where it leads (`next`, in walk order, including ones already walked) and which scenarios
 * on the way it leads back to; `apart`: scenarios linked to none of the others. Only the graph's own links.
 */
export const flowOf = (snap: Snapshot.Snapshot, journey: string): { readonly steps: ReadonlyArray<FlowStep>; readonly apart: ReadonlyArray<string> } => {
  const own = new Set(Snapshot.inbound(snap, journey, "gherkin/in").map((e) => e.from))
  const members = Snapshot.byType(snap, "gherkin/scenario").filter((c) => own.has(c.id)).map((c) => c.id)
  const arrivesOf = (c: string) => snap.nodes.get(c)?.edges.find((e) => e.type === "gherkin/arrives")?.to
  const thensOf = (c: string) => new Set((snap.nodes.get(c)?.edges ?? []).filter((e) => e.type === "gherkin/then").map((e) => e.to))
  const next = (c: string) => members.filter((n) => thensOf(c).has(arrivesOf(n) ?? ""))
  const hasPred = (c: string) => members.some((p) => next(p).includes(c))
  const alone = members.filter((c) => next(c).length === 0 && !hasPred(c))
  const steps: Array<FlowStep> = []
  const done = new Set<string>()
  const path = new Set<string>()
  const walk = (c: string) => {
    done.add(c)
    path.add(c)
    const ns = next(c)
    const on = ns.filter((n) => !path.has(n))
    steps.push({ id: c, next: on, back: ns.filter((n) => path.has(n)) })
    for (const n of on) if (!done.has(n)) walk(n)
    path.delete(c)
  }
  // Starts: scenarios none of the journey's scenarios lead to; then whatever a loop keeps unreached.
  for (const c of members) if (!alone.includes(c) && !hasPred(c) && !done.has(c)) walk(c)
  for (const c of members) if (!alone.includes(c) && !done.has(c)) walk(c)
  return { steps, apart: alone }
}
