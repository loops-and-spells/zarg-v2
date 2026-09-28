// packages/plugin-gherkin/src/stories.ts
import { Snapshot } from "@zarg/graph/pure"
import { ARRIVES, BY, cards, IN, journeyName, personaName, text, THEN } from "./model"

export interface StepView {
  readonly card: string
  readonly title: string
  readonly given: string
  readonly when: string
  readonly thens: ReadonlyArray<string>
  readonly via?: { readonly card: string; readonly when: string }
  readonly fork: ReadonlyArray<{ readonly card: string; readonly when: string }>
  readonly hasFailure: boolean
  /** The journeys the card is in, and the personas who act in it, by name. */
  readonly journeys: ReadonlyArray<string>
  readonly by: ReadonlyArray<string>
}

const arrivesOf = (snap: Snapshot.Snapshot, card: string) => snap.nodes.get(card)?.edges.find((e) => e.type === ARRIVES)?.to
const thensOf = (snap: Snapshot.Snapshot, card: string) => (snap.nodes.get(card)?.edges ?? []).filter((e) => e.type === THEN).map((e) => e.to)
/** Cards that start where this card's Thens lead. */
const nextOf = (snap: Snapshot.Snapshot, card: string) => [...new Set(thensOf(snap, card).flatMap((s) => Snapshot.inbound(snap, s, ARRIVES).map((e) => e.from)))].sort()

/**
 * Stories to walk. edge-pair (Ammann and Offutt): root-to-leaf stories that together cover every step
 * (card to next card) and every consecutive pair, by greedy set cover; loopbacks are left out. teleport:
 * each card alone. With focus, only stories through a focused card (or, for teleport, focused cards).
 */
export const planStories = (snap: Snapshot.Snapshot, strategy: "edge-pair" | "teleport", focus?: ReadonlySet<string>) => {
  const all = cards(snap).map((c) => c.id).sort()
  if (strategy === "teleport") return { stories: all.filter((c) => focus === undefined || focus.has(c)).map((c) => [c]), unreachable: 0 }
  // Roots: cards starting at an entry state, or at a state no card leads to.
  const roots = all.filter((c) => {
    const s = arrivesOf(snap, c)
    return s !== undefined && (snap.nodes.get(s)?.props.entry === true || Snapshot.inbound(snap, s, THEN).length === 0)
  })
  // Drop back edges (loopbacks) with a DFS from the roots, so every walk ends.
  const next = new Map<string, Array<string>>()
  const state = new Map<string, "open" | "done">()
  const visit = (c: string) => {
    state.set(c, "open")
    const out: Array<string> = []
    for (const n of nextOf(snap, c)) {
      if (state.get(n) === "open") continue
      out.push(n)
      if (!state.has(n)) visit(n)
    }
    next.set(c, out)
    state.set(c, "done")
  }
  for (const r of roots) if (!state.has(r)) visit(r)
  // Requirements: every card a root reaches (so a lone card is walked too), every step, every step pair.
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
  // Cards no root reaches (a loop nothing enters, a start that is not marked entry) are never walked: counted.
  const unreached = all.filter((c) => !next.has(c)).length
  return { stories: stories.filter((s) => focus === undefined || s.some((c) => focus.has(c))), unreachable: unreached + need.size }
}

/** What a tester sees at one step: the card, how they got here, and what they can do next. */
export const stepView = (snap: Snapshot.Snapshot, card: string, via?: string): StepView | undefined => {
  const node = snap.nodes.get(card)
  const from = arrivesOf(snap, card)
  if (node === undefined || from === undefined) return undefined
  const stateText = (id: string) => { const n = snap.nodes.get(id); return n === undefined ? id : text(n) }
  const whenOf = (id: string) => String(snap.nodes.get(id)?.props.when ?? "")
  return {
    card,
    title: String(node.props.title ?? card),
    given: stateText(from),
    when: whenOf(card),
    thens: thensOf(snap, card).map(stateText),
    ...(via !== undefined && snap.nodes.has(via) ? { via: { card: via, when: whenOf(via) } } : {}),
    fork: nextOf(snap, card).map((c) => ({ card: c, when: whenOf(c) })),
    // Another card leaves the same state: an alternative outcome (a failure case or a choice) exists.
    hasFailure: Snapshot.inbound(snap, from, ARRIVES).length > 1,
    journeys: Snapshot.out(snap, card, IN).flatMap((e) => { const n = snap.nodes.get(e.to); return n === undefined ? [] : [journeyName(n)] }),
    by: Snapshot.out(snap, card, BY).flatMap((e) => { const n = snap.nodes.get(e.to); return n === undefined ? [] : [personaName(n)] }),
  }
}
