import { Schema } from "effect"
import type { EdgeSpec, Plugin, Scopes } from "./define"

export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider"
  readonly config: unknown
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
  methods: Object.fromEntries(
    Object.entries(p.methods).map(([k, m]) => [k, { doc: m.doc, params: json(m.params), success: json(m.success), agents: m.agents === true, stream: m.stream === true, ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}) }]),
  ),
  ...(p.graph !== undefined ? { graph: { nodes: Object.fromEntries(Object.entries(p.graph.nodes).map(([k, s]) => [k, json(s)])), edges: p.graph.edges } } : {}),
})
