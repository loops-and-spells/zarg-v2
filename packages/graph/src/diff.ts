import { JsonPatch } from "effect"
import { canonical, type Edge, type Node } from "./node"
import type { Snapshot } from "./snapshot"

export interface EdgeDiff {
  readonly added: ReadonlyArray<Edge>
  readonly removed: ReadonlyArray<Edge>
  readonly changed: ReadonlyArray<{ readonly before: Edge; readonly after: Edge }>
}

export interface NodeChange {
  readonly id: string
  readonly before: Node
  readonly after: Node
  readonly props: JsonPatch.JsonPatch
  readonly edges: EdgeDiff
}

export interface Diff {
  readonly added: ReadonlyArray<Node>
  readonly removed: ReadonlyArray<Node>
  readonly changed: ReadonlyArray<NodeChange>
}

const edgeKey = (e: Edge) => `${e.type}\u0000${e.to}`

const diffEdges = (before: ReadonlyArray<Edge>, after: ReadonlyArray<Edge>): EdgeDiff => {
  const b = new Map(before.map((e) => [edgeKey(e), e]))
  const a = new Map(after.map((e) => [edgeKey(e), e]))
  return {
    added: after.filter((e) => !b.has(edgeKey(e))),
    removed: before.filter((e) => !a.has(edgeKey(e))),
    changed: after.flatMap((e) => {
      const prev = b.get(edgeKey(e))
      return prev !== undefined && JSON.stringify(prev.props ?? {}) !== JSON.stringify(e.props ?? {})
        ? [{ before: prev, after: e }]
        : []
    }),
  }
}

/** Keyed by node id, like React keys. Pure. */
export const diff = (before: Snapshot, after: Snapshot): Diff => {
  const added: Array<Node> = []
  const removed: Array<Node> = []
  const changed: Array<NodeChange> = []
  for (const [id, a] of after.nodes) {
    const b = before.nodes.get(id)
    if (b === undefined) added.push(a)
    else if (canonical(a) !== canonical(b)) {
      changed.push({ id, before: b, after: a, props: JsonPatch.get(b.props, a.props), edges: diffEdges(b.edges, a.edges) })
    }
  }
  for (const [id, b] of before.nodes) if (!after.nodes.has(id)) removed.push(b)
  const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id)
  return { added: added.sort(byId), removed: removed.sort(byId), changed: changed.sort(byId) }
}

export const isEmpty = (d: Diff): boolean =>
  d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0
