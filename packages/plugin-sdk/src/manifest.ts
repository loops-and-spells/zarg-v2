import { Schema } from "effect"
import { type Layout, layoutOf } from "@zarg/view"
import { contractDigest } from "./contract-digest"
import type { EdgeSpec, Plugin, PluginCommand, Scopes } from "./define"

export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service"
  readonly config: unknown
  /** The contract this plugin implements: its digest and the methods dependents may call. */
  readonly contract?: { readonly name: string; readonly digest: string; readonly methods: ReadonlyArray<string> }
  readonly commands?: ReadonlyArray<PluginCommand>
  /** Views its agents draw, as layouts. */
  readonly views?: ReadonlyArray<Layout>
  /** What this plugin was built against: each dependency's name and contract digest. */
  readonly pluginDependencies: ReadonlyArray<{ readonly name: string; readonly digest: string }>
  readonly scopes: Scopes
  readonly optional: Scopes
  readonly methods: Readonly<Record<string, { readonly doc: string; readonly params: unknown; readonly success: unknown; readonly agents: boolean; readonly deadlineMs?: number; readonly stream: boolean }>>
  readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
}

const json = (s: Schema.Top) => Schema.toJsonSchemaDocument(s)

export const manifestOf = (p: Plugin): Manifest => ({
  name: p.name,
  service: p.service,
  archetype: p.archetype,
  config: json(p.config),
  scopes: p.scopes,
  optional: p.optional ?? {},
  ...(p.implements !== undefined ? { contract: { name: p.implements.pluginName, digest: contractDigest(p.implements), methods: Object.keys(p.implements.methods) } } : {}),
  pluginDependencies: (p.pluginDependencies ?? []).map((c) => ({ name: c.pluginName, digest: contractDigest(c) })),
  ...(p.commands !== undefined ? { commands: p.commands } : {}),
  ...(p.views !== undefined && p.views.length > 0 ? { views: p.views.map(layoutOf) } : {}),
  methods: Object.fromEntries(
    Object.entries(p.methods).map(([k, m]) => [k, { doc: m.doc, params: json(m.params), success: json(m.success), agents: m.agents === true, stream: m.stream === true, ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}) }]),
  ),
  ...(p.graph !== undefined ? { graph: { nodes: Object.fromEntries(Object.entries(p.graph.nodes).map(([k, s]) => [k, json(s)])), edges: p.graph.edges } } : {}),
})
