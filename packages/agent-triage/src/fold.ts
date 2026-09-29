/**
 * Folding a triage round, as the RLM folds a task: the round's drafted cards (units) into small plans,
 * each at most CAP cards, ordered by what they need from each other. Pure: the model's groups and the
 * decision model's atomic answers come in from outside.
 */
type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>

/** A card the round drafted: its changes (in draft order), what it says, the feedback it answers. */
export type Unit = { readonly card: string; readonly title: string; readonly summary: string; readonly changes: Draft; readonly answers: ReadonlyArray<string> }
/** A group as the model answers it. */
export type Group = { readonly title: string; readonly steps: ReadonlyArray<string>; readonly cards: ReadonlyArray<string> }
/** A folded plan: its units (indexes, in draft order) and the plans it waits on (indexes into the fold). */
export type Folded = { readonly title: string; readonly steps: ReadonlyArray<string>; readonly units: ReadonlyArray<number>; readonly after: ReadonlyArray<number> }

export const CAP = 5
/** ROMA's atomic criteria, as the RLM asks them (packages/rlm/src/fold.ts), for a plan. */
export const ATOMIC = {
  single: "The plan has a single deliverable.",
  oneExecutor: "One agent working alone can do all of it.",
  noSteps: "Its steps do not depend on each other's results.",
  noPackaging: "It does not need several outputs packaged together.",
  noCoordination: "It needs no coordination with other work.",
} as const

type P = Record<string, unknown>
const obj = (x: unknown): P => (typeof x === "object" && x !== null ? (x as P) : {})
const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? [x] : [])
/** A state as a change refers to it: by id, or by the text it has (or is created with). */
const stateRefs = (x: unknown) => [...str(obj(x).id), ...str(obj(x).text)]

/** The nodes a change names: ids, the cards and states it points at, states by text. */
const names = (c: Draft[number]) => {
  const p = obj(c.params)
  return [...str(p.id), ...str(p.card), ...stateRefs(p.state), ...stateRefs(p.arrives), ...(Array.isArray(p.then) ? p.then.flatMap(stateRefs) : [])]
}
/** The nodes a change creates or changes. */
const made = (c: Draft[number]) => {
  const p = obj(c.params)
  switch (c.tool) {
    case "edit-state":
      return [...str(p.id), ...str(p.text)]
    case "edit-card":
    case "remove":
      return str(p.id)
    case "link":
    case "unlink":
      return [...str(p.card), ...str(obj(p.state).text)]
    case "add-state":
      return str(p.text)
    case "add-card":
      return [...str(p.title), ...str(obj(p.arrives).text), ...(Array.isArray(p.then) ? p.then.flatMap((t) => str(obj(t).text)) : [])]
    default:
      return []
  }
}

/** [b, a]: unit b (later in the draft) names a node unit a creates or changes. */
export const dependencies = (units: ReadonlyArray<Unit>): Array<[number, number]> => {
  const makes = units.map((u) => new Set(u.changes.flatMap(made)))
  const out: Array<[number, number]> = []
  units.forEach((u, b) => {
    const named = new Set(u.changes.flatMap(names))
    for (let a = 0; a < b; a++) if ([...named].some((n) => makes[a]!.has(n))) out.push([b, a])
  })
  return out
}

/** Union-find over indexes: the sets, each in order, ordered by their first. */
const components = (items: ReadonlyArray<number>, edges: ReadonlyArray<readonly [number, number]>) => {
  const parent = new Map(items.map((i) => [i, i]))
  const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!))
  for (const [a, b] of edges) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b))
  const by = new Map<number, Array<number>>()
  for (const i of [...items].sort((x, y) => x - y)) by.set(find(i), [...(by.get(find(i)) ?? []), i])
  return [...by.values()].sort((x, y) => x[0]! - y[0]!)
}
const named = (units: ReadonlyArray<Unit>, members: ReadonlyArray<number>) => ({
  title: `${units[members[0]!]!.title}${members.length > 1 ? ` and ${members.length - 1} more` : ""}`,
  steps: members.map((i) => units[i]!.summary).filter((s) => s.length > 0),
})

type Draft_ = { title: string; steps: ReadonlyArray<string>; units: Array<number> }
/** Which draft groups wait on which: a unit of one depends on a unit of the other. */
const waits = (groups: ReadonlyArray<Draft_>, deps: ReadonlyArray<readonly [number, number]>) => {
  const home = new Map(groups.flatMap((g, k) => g.units.map((u) => [u, k] as const)))
  return groups.map((_, k) => [...new Set(deps.filter(([b]) => home.get(b) === k).map(([, a]) => home.get(a)!).filter((j) => j !== undefined && j !== k))].sort((x, y) => x - y))
}

/**
 * The round folded: the model's groups (each unit once; unknown cards dropped, missing units alone), or the
 * dependency components without them; a group the decision model finds not atomic split into its components;
 * groups that would wait on each other merged; at most CAP units a plan, split in draft order; ordered by first unit.
 */
export const fold = (units: ReadonlyArray<Unit>, deps: ReadonlyArray<readonly [number, number]>, groups?: ReadonlyArray<Group>, atomic: (g: Group) => boolean = () => true): Array<Folded> => {
  const all = units.map((_, i) => i)
  let drafts: Array<Draft_>
  if (groups === undefined) drafts = components(all, deps).map((m) => ({ ...named(units, m), units: m }))
  else {
    const taken = new Set<number>()
    drafts = []
    for (const g of groups) {
      const mine = units.flatMap((u, i) => (g.cards.includes(u.card) && !taken.has(i) ? [i] : []))
      mine.forEach((i) => taken.add(i))
      if (mine.length === 0) continue
      if (mine.length > 1 && !atomic(g)) drafts.push(...components(mine, deps).map((m) => ({ ...named(units, m), units: m })))
      else drafts.push({ title: g.title, steps: g.steps, units: mine })
    }
    for (const i of all) if (!taken.has(i)) drafts.push({ ...named(units, [i]), units: [i] })
  }
  // Groups in a cycle (each waits on the other, however far round) are one.
  const w = waits(drafts, deps)
  const reach = (from: number) => {
    const seen = new Set<number>()
    const go = (k: number) => w[k]!.forEach((j) => !seen.has(j) && (seen.add(j), go(j)))
    go(from)
    return seen
  }
  const reaches = drafts.map((_, k) => reach(k))
  const cyc = drafts.flatMap((_, k) => [...reaches[k]!].filter((j) => reaches[j]!.has(k)).map((j) => [k, j] as const))
  drafts = components(drafts.map((_, k) => k), cyc).map((ks) => ({
    title: drafts[ks[0]!]!.title,
    steps: ks.flatMap((k) => drafts[k]!.steps),
    units: ks.flatMap((k) => drafts[k]!.units).sort((x, y) => x - y),
  }))
  // The cap, in draft order.
  drafts = drafts.flatMap((d) =>
    d.units.length <= CAP ? [d] : Array.from({ length: Math.ceil(d.units.length / CAP) }, (_, k) => ({ title: k === 0 ? d.title : `${d.title} (${k + 1})`, steps: k === 0 ? d.steps : [], units: d.units.slice(k * CAP, (k + 1) * CAP) })),
  )
  drafts.sort((x, y) => x.units[0]! - y.units[0]!)
  const after = waits(drafts, deps)
  return drafts.map((d, k) => ({ title: d.title, steps: d.steps, units: d.units, after: after[k]! }))
}

/** Plan k merged into the first plan it waits on (none: the one before it); what waited on k waits on that one. */
export const merge = (plans: ReadonlyArray<Folded>, k: number): Array<Folded> => {
  const into = plans[k]!.after[0] ?? k - 1
  if (into < 0) return [...plans]
  const at = (j: number) => (j === k ? into : j > k ? j - 1 : j)
  return plans.flatMap((p, j) => {
    if (j === k) return []
    const joined = j === into ? { title: p.title, steps: [...p.steps, ...plans[k]!.steps], units: [...p.units, ...plans[k]!.units].sort((x, y) => x - y), after: [...p.after, ...plans[k]!.after] } : p
    const after = [...new Set(joined.after.map(at))].filter((x) => x !== at(j)).sort((x, y) => x - y)
    return [{ ...joined, after }]
  })
}
