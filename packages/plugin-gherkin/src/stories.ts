// packages/plugin-gherkin/src/stories.ts
import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, BY, scenarios, IN, journeyName, personaName, text, THEN, GIVEN } from "./model"

export interface SceneView {
  readonly scenario: string
  readonly title: string
  readonly given: string
  readonly when: string
  readonly thens: ReadonlyArray<string>
  readonly via?: { readonly scenario: string; readonly when: string }
  readonly fork: ReadonlyArray<{ readonly scenario: string; readonly when: string }>
  readonly hasFailure: boolean
  /** The journeys the scenario is in, and the personas who act in it, by name. */
  readonly journeys: ReadonlyArray<string>
  readonly by: ReadonlyArray<string>
  /** The states by id: the Given (arrives), the extra context (given), the Thens. */
  readonly ids: { readonly given: string; readonly context: ReadonlyArray<string>; readonly thens: ReadonlyArray<string> }
  /** Not built yet: rehearse does not walk it. */
  readonly planned?: boolean
}

const arrivesOf = (snap: Snapshot.Snapshot, scenario: string) => snap.nodes.get(scenario)?.edges.find((e) => e.type === ARRIVES)?.to
const thensOf = (snap: Snapshot.Snapshot, scenario: string) => (snap.nodes.get(scenario)?.edges ?? []).filter((e) => e.type === THEN).map((e) => e.to)
/** Scenarios that start where this scenario's Thens lead. */
const nextOf = (snap: Snapshot.Snapshot, scenario: string) => [...new Set(thensOf(snap, scenario).flatMap((s) => Snapshot.inbound(snap, s, ARRIVES).map((e) => e.from)))].sort()

/**
 * Edge-pair (Ammann and Offutt) over some scenarios (all of them when `members` is undefined): root-to-leaf stories
 * that together cover every scenario, every two scenarios in a row (both members) and every three in a row, by
 * greedy set cover; loopbacks are left out. Roots: members whose Given is an entry state, or that no member leads to.
 */
const edgePair = (snap: Snapshot.Snapshot, members?: ReadonlySet<string>) => {
  const all = scenarios(snap).map((c) => c.id).filter((c) => members === undefined || members.has(c)).sort()
  const inside = (c: string) => members === undefined || members.has(c)
  const nextIn = (c: string) => nextOf(snap, c).filter(inside)
  const roots = all.filter((c) => {
    const s = arrivesOf(snap, c)
    return s !== undefined && (snap.nodes.get(s)?.props.entry === true || Snapshot.inbound(snap, s, THEN).filter((e) => inside(e.from)).length === 0)
  })
  // Drop back edges (loopbacks) with a DFS from the roots, so every walk ends.
  const next = new Map<string, Array<string>>()
  const state = new Map<string, "open" | "done">()
  const visit = (c: string) => {
    state.set(c, "open")
    const out: Array<string> = []
    for (const n of nextIn(c)) {
      if (state.get(n) === "open") continue
      out.push(n)
      if (!state.has(n)) visit(n)
    }
    next.set(c, out)
    state.set(c, "done")
  }
  for (const r of roots) if (!state.has(r)) visit(r)
  // Requirements: every scenario a root reaches (so a lone scenario is walked too), every two in a row, every three in a row.
  const need = new Set<string>([...next.keys()])
  for (const [c, ns] of next) for (const n of ns) {
    need.add(`${c}>${n}`)
    for (const m of next.get(n) ?? []) need.add(`${c}>${n}>${m}`)
  }
  const stories: Array<Array<string>> = []
  while (need.size > 0) {
    // f(p, c): the most uncovered requirements a walk from c (arrived from p) can still cover to a leaf.
    const memo = new Map<string, { gain: number; path: Array<string> }>()
    const f = (p: string | undefined, c: string): { gain: number; path: Array<string> } => {
      const key = `${p ?? ""}|${c}`
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const own = need.has(c) ? 1 : 0
      let best = { gain: own, path: [c] }
      let first = true
      for (const n of next.get(c) ?? []) {
        const rest = f(c, n)
        const gain = own + (need.has(`${c}>${n}`) ? 1 : 0) + (p !== undefined && need.has(`${p}>${c}>${n}`) ? 1 : 0) + rest.gain
        if (first || gain > best.gain) best = { gain, path: [c, ...rest.path] }
        first = false
      }
      memo.set(key, best)
      return best
    }
    const pick = roots.map((r) => f(undefined, r)).sort((a, b) => b.gain - a.gain)[0]
    if (pick === undefined || pick.gain === 0) break
    stories.push(pick.path)
    pick.path.forEach((c, i) => {
      need.delete(c)
      if (i > 0) need.delete(`${pick.path[i - 1]}>${c}`)
      if (i > 1) need.delete(`${pick.path[i - 2]}>${pick.path[i - 1]}>${c}`)
    })
  }
  // Scenarios no root reaches (a loop nothing enters, a start that is not marked entry) are never walked: counted.
  return { stories, unreachable: all.filter((c) => !next.has(c)).length + need.size }
}

/**
 * Stories to walk. journey (the default): edge-pair inside each journey, one two-scenario story for each handoff from a
 * journey into another (a seam), and each scenario in no journey alone. edge-pair: the same over the whole graph.
 * teleport: each scenario alone. With focus, only stories through a focused scenario (or, for teleport, focused scenarios); a focused journey is its scenarios.
 */
export const planStories = (snap: Snapshot.Snapshot, strategy: "journey" | "edge-pair" | "teleport", focused?: ReadonlySet<string>) => {
  // A focused journey means its scenarios.
  const focus = focused === undefined ? undefined : new Set([...focused].flatMap((id) => (snap.nodes.get(id)?.type === "gherkin/journey" ? Snapshot.inbound(snap, id, IN).map((e) => e.from) : [id])))
  const all = scenarios(snap).map((c) => c.id).sort()
  const through = (stories: ReadonlyArray<ReadonlyArray<string>>) => stories.filter((s) => focus === undefined || s.some((c) => focus.has(c)))
  if (strategy === "teleport") return { stories: all.filter((c) => focus === undefined || focus.has(c)).map((c) => [c]), unreachable: 0 }
  if (strategy === "edge-pair") {
    const r = edgePair(snap)
    return { stories: through(r.stories), unreachable: r.unreachable }
  }
  const journeys = Snapshot.byType(snap, "gherkin/journey")
    .map((j) => ({ id: j.id, scenarios: new Set(Snapshot.inbound(snap, j.id, IN).map((e) => e.from)) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const stories: Array<Array<string>> = []
  let unreachable = 0
  for (const j of journeys) {
    const r = edgePair(snap, j.scenarios)
    stories.push(...r.stories)
    unreachable += r.unreachable
  }
  // Seams: a handoff from one journey's scenario to a scenario of another journey (not also in the first): its handoff alone.
  const seams = new Set<string>()
  for (const j of journeys)
    for (const c of j.scenarios)
      for (const n of nextOf(snap, c)) if (!j.scenarios.has(n) && journeys.some((o) => o !== j && o.scenarios.has(n))) seams.add(`${c}>${n}`)
  stories.push(...[...seams].sort().map((x) => x.split(">")))
  // Scenarios in no journey: each alone, so nothing goes unwalked.
  const inAny = new Set(journeys.flatMap((j) => [...j.scenarios]))
  stories.push(...all.filter((c) => !inAny.has(c)).map((c) => [c]))
  return { stories: through(stories), unreachable }
}

/** What a tester sees at one scene: the scenario, how they got here, and what they can do next. */
export const sceneView = (snap: Snapshot.Snapshot, scenario: string, via?: string): SceneView | undefined => {
  const node = snap.nodes.get(scenario)
  const from = arrivesOf(snap, scenario)
  if (node === undefined || from === undefined) return undefined
  const stateText = (id: string) => { const n = snap.nodes.get(id); return n === undefined ? id : text(n) }
  const whenOf = (id: string) => String(snap.nodes.get(id)?.props.when ?? "")
  return {
    scenario,
    title: String(node.props.title ?? scenario),
    given: stateText(from),
    when: whenOf(scenario),
    thens: thensOf(snap, scenario).map(stateText),
    ...(via !== undefined && snap.nodes.has(via) ? { via: { scenario: via, when: whenOf(via) } } : {}),
    fork: nextOf(snap, scenario).map((c) => ({ scenario: c, when: whenOf(c) })),
    // Another scenario leaves the same state: an alternative outcome (a failure case or a choice) exists.
    hasFailure: Snapshot.inbound(snap, from, ARRIVES).length > 1,
    journeys: Snapshot.out(snap, scenario, IN).flatMap((e) => { const n = snap.nodes.get(e.to); return n === undefined ? [] : [journeyName(n)] }),
    by: Snapshot.out(snap, scenario, BY).flatMap((e) => { const n = snap.nodes.get(e.to); return n === undefined ? [] : [personaName(n)] }),
    // The states by id: the Given (arrives), the extra context (given), the Thens, in the order shown.
    ids: { given: from, context: Snapshot.out(snap, scenario, GIVEN).map((e) => e.to), thens: thensOf(snap, scenario) },
    ...(node.props.planned === true ? { planned: true } : {}),
  }
}
