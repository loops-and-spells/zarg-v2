import { Schema } from "effect"
import type { Node } from "@zarg/graph"
import type { EdgeSpec, Finding, LintContext, ServerPlugin } from "./plugin"

export interface Registry {
  readonly plugins: ReadonlyArray<ServerPlugin>
  readonly nodes: ReadonlyMap<string, Schema.ConstraintDecoder<unknown>>
  /** Full edge type -> spec with full node type names. */
  readonly edges: ReadonlyMap<string, EdgeSpec>
}

export class PluginConfigError extends Error {}

export const registry = (plugins: ReadonlyArray<ServerPlugin>): Registry => {
  const names = new Set<string>()
  const nodes = new Map<string, Schema.ConstraintDecoder<unknown>>()
  const edges = new Map<string, EdgeSpec>()
  for (const p of plugins) {
    if (names.has(p.name)) throw new PluginConfigError(`plugin "${p.name}" is registered twice`)
    names.add(p.name)
  }
  for (const p of plugins) {
    for (const r of p.requires ?? []) {
      if (!names.has(r)) throw new PluginConfigError(`plugin "${p.name}" requires "${r}", which is not registered`)
    }
    for (const [local, schema] of Object.entries(p.nodes ?? {})) nodes.set(`${p.name}/${local}`, schema)
  }
  const full = (owner: string, type: string) => (type.includes("/") ? type : `${owner}/${type}`)
  for (const p of plugins) {
    for (const [local, spec] of Object.entries(p.edges ?? {})) {
      const resolved = { ...spec, from: full(p.name, spec.from), to: full(p.name, spec.to) }
      for (const t of [resolved.from, resolved.to]) {
        if (!nodes.has(t)) throw new PluginConfigError(`edge "${p.name}/${local}" uses unknown node type "${t}"`)
      }
      edges.set(`${p.name}/${local}`, resolved)
    }
  }
  return { plugins, nodes, edges }
}

const error = (code: string, message: string, about: ReadonlyArray<string>): Finding => ({
  severity: "error",
  code,
  message,
  about,
})

/** Schema, edge-type and cardinality checks for one node, against the snapshot it lives in. */
const checkNode = (reg: Registry, ctx: LintContext, node: Node): ReadonlyArray<Finding> => {
  const schema = reg.nodes.get(node.type)
  if (schema === undefined) return [error("unknown-type", `${node.id}: unknown node type "${node.type}"`, [node.id])]
  const out: Array<Finding> = []
  const decoded = Schema.decodeUnknownExit(schema)(node.props)
  if (decoded._tag === "Failure") {
    out.push(error("invalid-props", `${node.id}: props do not match ${node.type}: ${String(decoded.cause)}`, [node.id]))
  }
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

/** Every check for a proposed change: structure of touched nodes, then every plugin's lints. */
export const check = (reg: Registry, ctx: LintContext): ReadonlyArray<Finding> => [
  ...[...ctx.diff.added, ...ctx.diff.changed.map((c) => c.after)].flatMap((n) => checkNode(reg, ctx, n)),
  ...reg.plugins.flatMap((p) => (p.lints ?? []).flatMap((lint) => lint(ctx))),
]
