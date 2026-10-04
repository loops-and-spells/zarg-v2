import { Schema } from "effect"
import { type Layout, layoutOf, type Surface } from "@zarg/view"
import { contractDigest } from "./contract-digest"
import type { EdgeSpec, Plugin, PluginCommand, Scopes } from "./define"
import type { EntityOp } from "./entities"

export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service" | "agent"
  readonly runtime?: "sandboxed" | "trusted"
  readonly config: unknown
  /** The contract this plugin implements: its digest and the methods dependents may call. */
  readonly contract?: { readonly name: string; readonly digest: string; readonly methods: ReadonlyArray<string> }
  readonly commands?: ReadonlyArray<PluginCommand>
  /** Views its agents draw, as layouts. */
  readonly views?: ReadonlyArray<Layout>
  /** Where its views show. */
  readonly surfaces?: ReadonlyArray<Surface>
  /** What this plugin was built against: each dependency's name and contract digest. */
  readonly pluginDependencies: ReadonlyArray<{ readonly name: string; readonly digest: string }>
  readonly scopes: Scopes
  readonly optional: Scopes
  readonly methods: Readonly<Record<string, { readonly doc: string; readonly params: unknown; readonly success: unknown; readonly agents: boolean; readonly deadlineMs?: number; readonly stream: boolean }>>
  readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
  /** Entity kinds it serves: data schema, tone, glyph, commands (command → method), the nav surface that shows them, the ops it serves itself. */
  readonly entities?: Readonly<Record<string, { readonly doc: string; readonly data: unknown; readonly tone: string; readonly glyph: string; readonly commands: Readonly<Record<string, string>>; readonly open?: string; readonly ops: ReadonlyArray<EntityOp> }>>
  /** Evidence kinds it renders. */
  readonly evidence?: Readonly<Record<string, { readonly label: string; readonly files: "text" | "binary" }>>
  /** Its assets as built: file name → sha256 (`writeDist` fills it from `assetFiles`). */
  readonly assets?: Readonly<Record<string, string>>
  /** Its assets as declared, relative to its package (build only; `writeDist` replaces them with `assets`). */
  readonly assetFiles?: ReadonlyArray<string>
}

const json = (s: Schema.Top) => Schema.toJsonSchemaDocument(s)

export const manifestOf = (p: Plugin): Manifest => ({
  name: p.name,
  service: p.service,
  archetype: p.archetype,
  ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
  config: json(p.config),
  scopes: p.scopes,
  optional: p.optional ?? {},
  ...(p.implements !== undefined ? { contract: { name: p.implements.pluginName, digest: contractDigest(p.implements), methods: Object.keys(p.implements.methods) } } : {}),
  pluginDependencies: (p.pluginDependencies ?? []).map((c) => ({ name: c.pluginName, digest: contractDigest(c) })),
  ...(p.commands !== undefined ? { commands: p.commands } : {}),
  ...(p.views !== undefined && p.views.length > 0 ? { views: p.views.map(layoutOf) } : {}),
  ...(p.surfaces !== undefined && p.surfaces.length > 0 ? { surfaces: p.surfaces } : {}),
  methods: Object.fromEntries(
    Object.entries(p.methods).map(([k, m]) => [k, { doc: m.doc, params: json(m.params), success: json(m.success), agents: m.agents === true, stream: m.stream === true, ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}) }]),
  ),
  ...(p.entities !== undefined && Object.keys(p.entities).length > 0
    ? { entities: Object.fromEntries(Object.entries(p.entities).map(([k, d]) => [k, { doc: d.doc, data: json(d.data), tone: d.tone, glyph: d.glyph, commands: d.commands ?? {}, ...(d.open !== undefined ? { open: d.open } : {}), ops: d.ops ?? (p.archetype === "graph" ? [] : ["get", "label", "version"]) }])) }
    : {}),
  ...(p.evidence !== undefined && Object.keys(p.evidence).length > 0 ? { evidence: Object.fromEntries(Object.entries(p.evidence).map(([k, d]) => [k, { label: d.label, files: d.files }])) } : {}),
  ...(p.assets !== undefined && p.assets.length > 0 ? { assetFiles: p.assets } : {}),
  ...(p.graph !== undefined ? { graph: { nodes: Object.fromEntries(Object.entries(p.graph.nodes).map(([k, s]) => [k, json(s)])), edges: p.graph.edges } } : {}),
})
