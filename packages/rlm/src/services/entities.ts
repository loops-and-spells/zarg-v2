import { Effect, Schema } from "effect"
import { parseRef } from "@zarg/entities"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { type GraphContext, scopeSet } from "./graph"

const fail = (e: { readonly tag?: string; readonly _tag?: string; readonly message: string }): ServiceFailure => ({ _tag: e.tag ?? e._tag ?? "EntityError", message: e.message })
const doc = (schema: unknown, definitions: Record<string, unknown> = {}) => ({ schema, definitions })

/** Any plugin's data by ref. Typed per kind from the loaded manifests; graph refs honour the RLM's scope. */
export const entitiesService = (ctx: GraphContext, opts: { readonly write: boolean }): Bound => {
  const kinds = ctx.host.entities.types()
  const defs: Record<string, unknown> = {}
  const variants = kinds.map((k) => {
    const d = k.data as { schema?: unknown; definitions?: Record<string, unknown> } | undefined
    Object.assign(defs, d?.definitions ?? {})
    return { type: "object", properties: { type: { const: k.type }, id: { type: "string" }, ref: { type: "string" }, version: { type: "string" }, label: { type: "object", properties: { text: { type: "string" }, tone: { type: "string" }, glyph: { type: "string" } }, required: ["text", "tone", "glyph"] }, data: d?.schema ?? {} }, required: ["type", "id", "ref", "version", "label", "data"] }
  })
  const entity = { anyOf: variants.length > 0 ? variants : [{}] }
  const refParam = doc({ type: "object", properties: { ref: { type: "string", description: "<plugin>/<kind>:<id>[@<version>], e.g. gherkin/card:UX-0062" } }, required: ["ref"] })
  const m = (d: string, params: unknown, success: unknown) => ({ doc: d, params: Schema.Unknown, success: Schema.Unknown, json: { params, success } })
  const methods = {
    get: m("One entity by ref (narrow on `type` to read its data).", refParam, doc(entity, defs)),
    many: m("Several entities; failures listed, not thrown.", doc({ type: "object", properties: { refs: { type: "array", items: { type: "string" } } }, required: ["refs"] }), doc({ type: "object", properties: { entities: { type: "array", items: entity }, failed: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, _tag: { type: "string" }, message: { type: "string" } } } } } }, defs)),
    query: m("Entities of one type, by field equality and/or ranked text.", doc({ type: "object", properties: { type: { enum: kinds.map((k) => k.type) }, where: { type: "object", additionalProperties: true }, text: { type: "string" }, limit: { type: "number" } }, required: ["type"] }), doc({ type: "array", items: entity }, defs)),
    version: m("The entity's current version; null when it is gone.", refParam, doc({ anyOf: [{ type: "string" }, { type: "null" }] })),
    changed: m("True when ref@version is no longer the current version (or the entity is gone).", refParam, doc({ type: "boolean" })),
    label: m("How the entity is shown.", refParam, doc({ type: "object", properties: { text: { type: "string" }, tone: { type: "string" }, glyph: { type: "string" } } })),
    context: m("Agent-ready text for the entity (Markdown).", refParam, doc({ type: "string" })),
    types: m("Every entity type, its commands and doc.", doc({ type: "object", properties: {} }), doc({ type: "array", items: { type: "object", properties: { type: { type: "string" }, doc: { type: "string" }, commands: { type: "array", items: { type: "string" } } } } })),
    ...(opts.write ? { command: m("Run a type's named command (the owner's own checks apply).", doc({ type: "object", properties: { ref: { type: "string" }, name: { type: "string" }, args: {} }, required: ["ref", "name"] }), doc({})) } : {}),
  }
  const def = defineService("Entities", "Any plugin's data by reference: fetch, find, check versions, show; commands go to the owner.", methods)
  const inScope = (ref: string) =>
    Effect.gen(function* () {
      const r = parseRef(ref)
      const k = r === undefined ? undefined : kinds.find((x) => x.type === r.type)
      if (r === undefined || k === undefined) return
      const snap = yield* Effect.orElseSucceed(ctx.snapshot, () => undefined)
      const visible = snap === undefined ? undefined : scopeSet(snap, ctx.scope)
      if (visible !== undefined && snap!.nodes.has(r.id) && !visible.has(r.id)) return yield* Effect.fail({ _tag: "OutOfScope", message: `${ref} is outside this RLM's graph scope; hand the work to a child RLM` } satisfies ServiceFailure)
    })
  const e = ctx.host.entities
  const handlers = {
    get: ({ ref }: { ref: string }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.get(ref), fail)),
    many: ({ refs }: { refs: ReadonlyArray<string> }) => Effect.flatMap(Effect.forEach(refs, inScope), () => e.many(refs)),
    query: (q: never) => Effect.mapError(e.query(q), fail),
    version: ({ ref }: { ref: string }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.version(ref), fail)),
    changed: ({ ref }: { ref: string }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.changed(ref), fail)),
    label: ({ ref }: { ref: string }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.label(ref), fail)),
    context: ({ ref }: { ref: string }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.context(ref), fail)),
    types: () => Effect.succeed(kinds.map((k) => ({ type: k.type, doc: k.doc, commands: k.commands }))),
    ...(opts.write ? { command: ({ ref, name, args }: { ref: string; name: string; args?: unknown }) => Effect.flatMap(inScope(ref), () => Effect.mapError(e.command(ref, name, args ?? {}), fail)) } : {}),
  }
  return bind(def, handlers as never)
}
