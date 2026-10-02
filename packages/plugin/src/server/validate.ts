import type { Node } from "@zarg/graph"
import type { EdgeSpec, Finding, LintContext } from "./plugin"

export class PluginConfigError extends Error {}

const error = (code: string, message: string, about: ReadonlyArray<string>): Finding => ({
  severity: "error",
  code,
  message,
  about,
})

/** Type, edge and cardinality checks for one node, against the snapshot it lives in. */
const checkNode = (reg: ManifestRegistry, ctx: LintContext, node: Node): ReadonlyArray<Finding> => {
  if (!reg.nodes.has(node.type)) return [error("unknown-type", `${node.id}: unknown node type "${node.type}"`, [node.id])]
  const out: Array<Finding> = []
  for (const edge of node.edges) {
    const spec = reg.edges.get(edge.type)
    if (spec === undefined) {
      out.push(error("unknown-edge", `${node.id}: unknown edge type "${edge.type}"`, [node.id]))
      continue
    }
    if (spec.from !== node.type) {
      out.push(error("edge-source", `${node.id}: "${edge.type}" edges must start at a ${spec.from}`, [node.id]))
    }
    const target = ctx.after.nodes.get(edge.to)
    if (target !== undefined && target.type !== spec.to) {
      out.push(error("edge-target", `${node.id}: "${edge.type}" must point to a ${spec.to}, ${edge.to} is a ${target.type}`, [node.id, edge.to]))
    }
  }
  // @scenario S-0007
  const seen = new Set<string>()
  for (const edge of node.edges) {
    const key = `${edge.type}\u0000${edge.to}`
    if (seen.has(key)) {
      out.push(error("duplicate-edge", `${node.id}: links ${edge.to} as "${edge.type}" twice; remove the duplicate`, [node.id, edge.to]))
    }
    seen.add(key)
  }
  for (const [type, spec] of reg.edges) {
    if (spec.from !== node.type) continue
    const n = node.edges.filter((e) => e.type === type).length
    if (spec.min !== undefined && n < spec.min) {
      out.push(error("too-few-edges", `${node.id}: needs at least ${spec.min} "${type}" edge(s), has ${n}`, [node.id]))
    }
    if (spec.max !== undefined && n > spec.max) {
      out.push(error("too-many-edges", `${node.id}: allows at most ${spec.max} "${type}" edge(s), has ${n}`, [node.id]))
    }
  }
  return out
}

/** Node types and edge specs from plugin manifests (props are checked by each plugin's own `validate`). */
export interface ManifestRegistry {
  /** Full node type ("notes/topic") → the plugin that owns it. */
  readonly nodes: ReadonlyMap<string, string>
  readonly edges: ReadonlyMap<string, EdgeSpec>
}

export const manifestRegistry = (
  manifests: ReadonlyArray<{ readonly name: string; readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> } }>,
): ManifestRegistry => {
  const names = new Set<string>()
  for (const m of manifests) {
    if (names.has(m.name)) throw new PluginConfigError(`plugin "${m.name}" is registered twice`)
    names.add(m.name)
  }
  const nodes = new Map<string, string>()
  for (const m of manifests) for (const local of Object.keys(m.graph?.nodes ?? {})) nodes.set(`${m.name}/${local}`, m.name)
  const full = (owner: string, type: string) => (type.includes("/") ? type : `${owner}/${type}`)
  const edges = new Map<string, EdgeSpec>()
  for (const m of manifests) {
    for (const [local, spec] of Object.entries(m.graph?.edges ?? {})) {
      const resolved = { ...spec, from: full(m.name, spec.from), to: full(m.name, spec.to) }
      for (const t of [resolved.from, resolved.to]) {
        if (!nodes.has(t)) throw new PluginConfigError(`edge "${m.name}/${local}" uses unknown node type "${t}"`)
      }
      edges.set(`${m.name}/${local}`, resolved)
    }
  }
  return { nodes, edges }
}

/** Type, edge and cardinality checks for the nodes a change touches (no props: plugins check those). */
export const checkStructure = (reg: ManifestRegistry, ctx: LintContext): ReadonlyArray<Finding> =>
  [...ctx.diff.added, ...ctx.diff.changed.map((c) => c.after)].flatMap((node) => checkNode(reg, ctx, node))
