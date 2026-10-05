import { Effect, Schema } from "effect"
import { hash, Snapshot } from "@zarg/graph"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import type { Manifest, PluginHost } from "@zarg/plugin/server"
import type { Scope } from "../scope"

const Item = Schema.Struct({ id: Schema.String, title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String), priority: Schema.Number })
const NodeView = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  hash: Schema.String,
  props: Schema.Record(Schema.String, Schema.Json),
  edges: Schema.Array(Schema.Struct({ type: Schema.String, to: Schema.String })),
  inbound: Schema.Array(Schema.Struct({ from: Schema.String, type: Schema.String })),
})

export const GraphDef = defineService("Graph", "The requirements graph, limited to your scope (read only).", {
  render: { doc: "Gherkin text for the scenarios in scope (optionally narrowed to ids).", params: Schema.Struct({ focus: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Only these node ids and their scenarios; omit for everything in scope (large)." }) }), success: Schema.String },
  agenda: { doc: "Open items in scope, most urgent first.", params: Schema.Struct({}), success: Schema.Array(Item) },
  show: { doc: "One node with its hash (for expectations) and inbound edges.", params: Schema.Struct({ id: Schema.String }), success: NodeView },
  neighbors: { doc: "Node ids within k hops, both directions.", params: Schema.Struct({ id: Schema.String, k: Schema.Number.annotate({ description: "Hops; 1 or 2 is usually enough." }) }), success: Schema.Array(Schema.String) },
})

const outOfScope = (id: string): ServiceFailure => ({ _tag: "OutOfScope", message: `${id} is outside this RLM's graph scope; hand the work to a child RLM` })

export interface GraphContext {
  readonly host: PluginHost["Service"]
  readonly snapshot: Effect.Effect<Snapshot.Snapshot, ServiceFailure>
  readonly scope: Scope
}

/** The set of node ids this scope may see, or undefined for the whole graph. */
export const scopeSet = (snap: Snapshot.Snapshot, scope: Scope): ReadonlySet<string> | undefined =>
  scope.graph === undefined ? undefined : new Set(scope.graph.focus.flatMap((id) => Snapshot.neighbors(snap, id, scope.graph!.k)))

/** A node named by its entity ref (`gherkin/state:ST-0002`, with or without `@version`) is that node's id. */
const bare = (id: string) => /^[a-z][a-z0-9-]*\/[a-z]+:([^@]+)(@[0-9a-f]+)?$/.exec(id)?.[1] ?? id

export const graph = (ctx: GraphContext): Bound =>
  bind(GraphDef, {
    render: ({ focus }) =>
      Effect.gen(function* () {
        const visible = scopeSet(yield* ctx.snapshot, ctx.scope)
        const wanted = focus === undefined ? visible : new Set(focus.filter((id) => visible === undefined || visible.has(id)))
        return yield* ctx.host.render(wanted).pipe(Effect.mapError((e): ServiceFailure => ({ _tag: e._tag, message: e.message })))
      }),
    agenda: () =>
      Effect.gen(function* () {
        const visible = scopeSet(yield* ctx.snapshot, ctx.scope)
        return yield* ctx.host.agenda(visible).pipe(Effect.mapError((e): ServiceFailure => ({ _tag: e._tag, message: e.message })))
      }),
    show: ({ id: raw }) =>
      Effect.gen(function* () {
        const id = bare(raw)
        const snap = yield* ctx.snapshot
        const visible = scopeSet(snap, ctx.scope)
        if (visible !== undefined && !visible.has(id)) return yield* Effect.fail(outOfScope(id))
        const node = snap.nodes.get(id)
        if (node === undefined) return yield* Effect.fail({ _tag: "NotFound", message: `no node ${id}` })
        return {
          id: node.id,
          type: node.type,
          hash: hash(node),
          props: node.props,
          edges: node.edges.map((e) => ({ type: e.type, to: e.to })),
          inbound: Snapshot.inbound(snap, id).map((e) => ({ from: e.from, type: e.edge.type })),
        }
      }),
    neighbors: ({ id: raw, k }) =>
      Effect.gen(function* () {
        const id = bare(raw)
        const snap = yield* ctx.snapshot
        const visible = scopeSet(snap, ctx.scope)
        if (visible !== undefined && !visible.has(id)) return yield* Effect.fail(outOfScope(id))
        return Snapshot.neighbors(snap, id, k).filter((n) => visible === undefined || visible.has(n))
      }),
  })

const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
const camel = (s: string) => {
  const p = pascal(s)
  return p[0]!.toLowerCase() + p.slice(1)
}

const CallResult = Schema.Struct({
  message: Schema.String,
  added: Schema.Array(Schema.String),
  changed: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.Struct({ severity: Schema.String, code: Schema.String, message: Schema.String, about: Schema.Array(Schema.String) })),
})

/** Methods the host calls on graph plugins; never offered to agents. */
const RESERVED = new Set(["validate", "lint", "agenda", "suggest", "render", "affected"])

/**
 * A plugin's agent methods as a yieldable service, named by its manifest: plugin "gherkin" (service
 * "Gherkin") with method "add-scenario" becomes `Gherkin.addScenario(params)`. Types come from the manifest's JSON
 * Schema; the plugin validates params itself. Every call runs through the PluginHost write pipeline.
 * A write whose params name an existing node outside the RLM's graph scope is refused before it runs.
 */
export const pluginService = (manifest: Manifest, ctx: GraphContext): Bound | undefined => {
  const tools = Object.entries(manifest.methods)
    .filter(([name, spec]) => spec.agents && !RESERVED.has(name))
    .map(([name, spec]) => ({ name, description: spec.doc, params: spec.params, success: spec.success }))
  if (tools.length === 0) return undefined
  const result = Schema.toJsonSchemaDocument(CallResult)
  const methods = Object.fromEntries(
    tools.map((t) => [camel(t.name), { doc: t.description, params: Schema.Unknown, success: Schema.Unknown, json: { params: t.params, success: manifest.archetype !== "graph" ? t.success : result } }]),
  )
  const def = defineService(manifest.service, `Graph writes for the ${manifest.name} plugin (through lints and the write pipeline).`, methods)
  const handlers = Object.fromEntries(
    tools.map((t) => [
      camel(t.name),
      (params: unknown) =>
        Effect.gen(function* () {
          const snap = yield* ctx.snapshot
          const visible = scopeSet(snap, ctx.scope)
          // Only strings that are ids of existing nodes count; "ISO-8601" in a title is just text.
          const touched = (JSON.stringify(params).match(/\b[A-Za-z]+-\d{4,}\b/g) ?? []).filter((id) => snap.nodes.has(id))
          const outside = visible === undefined ? [] : touched.filter((id) => !visible.has(id))
          if (outside.length > 0) return yield* Effect.fail(outOfScope(outside.join(", ")))
          // A service plugin's tools are plain calls; a graph plugin's go through the write pipeline.
          if (manifest.archetype === "service" || manifest.archetype === "agent") {
            return yield* ctx.host.invoke(manifest.name, t.name, params).pipe(Effect.mapError((e): ServiceFailure => ({ _tag: e._tag, message: e.message })))
          }
          return yield* ctx.host.call(`${manifest.name}/${t.name}`, params).pipe(
            Effect.mapError((e): ServiceFailure => {
              if (e._tag === "LintFailed") return { _tag: "LintFailed", message: e.findings.map((f) => f.message).join("; ") }
              const tagged = e as { readonly _tag: string; readonly message?: unknown }
              return { _tag: tagged._tag, message: tagged.message === undefined ? tagged._tag : String(tagged.message) }
            }),
          )
        }),
    ]),
  )
  return bind(def, handlers as never)
}
