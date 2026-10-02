import type { Edge, Node } from "./node"

export interface InEdge {
  readonly from: string
  readonly edge: Edge
}

export interface Snapshot {
  readonly nodes: ReadonlyMap<string, Node>
  readonly inbound: ReadonlyMap<string, ReadonlyArray<InEdge>>
  /** Ids whose files exist but failed to load. Never handed out again and never overwritten. */
  readonly reserved: ReadonlySet<string>
}

export type Change =
  | { readonly _tag: "Put"; readonly node: Node }
  | { readonly _tag: "Remove"; readonly id: string }

export const Put = (node: Node): Change => ({ _tag: "Put", node })
export const Remove = (id: string): Change => ({ _tag: "Remove", id })

export const make = (nodes: Iterable<Node>, reserved: ReadonlySet<string> = new Set()): Snapshot => {
  const byId = new Map<string, Node>()
  for (const n of nodes) byId.set(n.id, n)
  const inbound = new Map<string, Array<InEdge>>()
  for (const n of byId.values()) {
    for (const edge of n.edges) {
      const list = inbound.get(edge.to) ?? []
      list.push({ from: n.id, edge })
      inbound.set(edge.to, list)
    }
  }
  return { nodes: byId, inbound, reserved }
}

export const empty: Snapshot = make([])

export const applyChanges = (snap: Snapshot, changes: ReadonlyArray<Change>): Snapshot => {
  const next = new Map(snap.nodes)
  for (const c of changes) {
    if (c._tag === "Put") next.set(c.node.id, c.node)
    else next.delete(c.id)
  }
  return make(next.values(), snap.reserved)
}

/** Edges whose target is missing in the snapshot. */
export const danglingEdges = (snap: Snapshot): ReadonlyArray<{ from: string; edge: Edge }> => {
  const out: Array<{ from: string; edge: Edge }> = []
  for (const n of snap.nodes.values()) {
    for (const edge of n.edges) if (!snap.nodes.has(edge.to)) out.push({ from: n.id, edge })
  }
  return out
}

export const get = (snap: Snapshot, id: string): Node | undefined => snap.nodes.get(id)

export const byType = (snap: Snapshot, type: string): ReadonlyArray<Node> =>
  [...snap.nodes.values()].filter((n) => n.type === type).sort((a, b) => a.id.localeCompare(b.id))

export const out = (snap: Snapshot, id: string, type?: string): ReadonlyArray<Edge> =>
  (snap.nodes.get(id)?.edges ?? []).filter((e) => type === undefined || e.type === type)

export const inbound = (snap: Snapshot, id: string, type?: string): ReadonlyArray<InEdge> =>
  (snap.inbound.get(id) ?? []).filter((e) => type === undefined || e.edge.type === type)

/**
 * Edges a walk never follows backward (except from where it starts): their target is a hub nearly every node
 * points at (a persona every scenario names, a journey), and walking back through it would pull in the whole graph.
 */
// ponytail: one plugin's edge named here; move it to the manifest's edge spec when a second plugin needs one.
const ONE_WAY = new Set(["gherkin/by", "gherkin/in"])

/** Node ids within k hops, following edges in both directions (one-way edges only forward). Includes `id`. */
export const neighbors = (snap: Snapshot, id: string, k: number): ReadonlyArray<string> => {
  const seen = new Set([id])
  let frontier = [id]
  for (let i = 0; i < k && frontier.length > 0; i++) {
    const next: Array<string> = []
    for (const cur of frontier) {
      const adj = [...out(snap, cur).map((e) => e.to), ...inbound(snap, cur).filter((e) => cur === id || !ONE_WAY.has(e.edge.type)).map((e) => e.from)]
      for (const n of adj) if (snap.nodes.has(n) && !seen.has(n)) {
        seen.add(n)
        next.push(n)
      }
    }
    frontier = next
  }
  return [...seen].sort()
}

/** Next free id for a prefix: `S` -> `S-0004` when `S-0003` is the highest. */
export const nextId = (snap: Snapshot, prefix: string): string => {
  let max = 0
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  for (const id of [...snap.nodes.keys(), ...snap.reserved]) {
    const m = re.exec(id)
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`
}
