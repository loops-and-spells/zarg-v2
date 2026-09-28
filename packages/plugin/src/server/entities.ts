import { Cause, Data, Effect } from "effect"
import { type Entity, formatRef, type Label, parseRef, type Query, refProblem, versionOf } from "@zarg/entities"
import { rank } from "@zarg/bm25"
import { hash, Snapshot } from "@zarg/graph"
import type { Manifest } from "./loaded"

export class EntityError extends Data.TaggedError("EntityError")<{ readonly tag: "NotFound" | "UnknownType" | "NotAllowed" | "ProviderFailed" | "OutOfScope"; readonly message: string }> {}
export interface Kind { readonly type: string; readonly owner: string; readonly ownerGraph: boolean; readonly doc: string; readonly tone: string; readonly glyph: string; readonly commands: Readonly<Record<string, string>>; readonly open?: string; readonly data: unknown; readonly ops: ReadonlySet<string>; readonly graph: boolean }

/** Every type the loaded plugins own: declared kinds plus graph node kinds (the owner's declaration overrides). A type is `<plugin>/<kind>`, so one plugin owns it (the host already refuses a second plugin of one name). */
export const registry = (manifests: ReadonlyArray<Manifest>): ReadonlyMap<string, Kind> => {
  const kinds = new Map<string, Kind>()
  for (const m of manifests) {
    const graphKinds = Object.keys(m.graph?.nodes ?? {})
    const declared = m.entities ?? {}
    for (const k of new Set([...graphKinds, ...Object.keys(declared)])) {
      const type = `${m.name}/${k}`
      const d = declared[k]
      const graph = graphKinds.includes(k)
      const doc = (d?.data ?? m.graph?.nodes[k]) as { readonly schema?: unknown; readonly definitions?: Record<string, unknown> } | undefined
      // A graph kind is served as the node's props and edges: its data is typed that way.
      const data = graph
        ? { schema: { type: "object", properties: { props: doc?.schema ?? {}, edges: { type: "array", items: { type: "object", properties: { type: { type: "string" }, to: { type: "string" } }, required: ["type", "to"] } } }, required: ["props", "edges"] }, definitions: doc?.definitions ?? {} }
        : doc
      kinds.set(type, { type, owner: m.name, ownerGraph: m.archetype === "graph", doc: d?.doc ?? `${k} nodes of ${m.name}`, tone: d?.tone ?? "dim", glyph: d?.glyph ?? "·", commands: d?.commands ?? {}, ...(d?.open !== undefined ? { open: d.open } : {}), data, ops: new Set(d?.ops ?? []), graph })
    }
  }
  return kinds
}

/** A type pattern: `plugin/kind` or `plugin/*`. */
export const typeMatches = (pattern: string, type: string) => pattern === type || (pattern.endsWith("/*") && type.startsWith(pattern.slice(0, -1)))

export interface Backend {
  readonly kinds: ReadonlyMap<string, Kind>
  /** The owner's `$entity` method. */
  readonly provider: (owner: string, p: { readonly op: string; readonly kind: string; readonly ids?: ReadonlyArray<string>; readonly query?: unknown }) => Effect.Effect<unknown, { readonly message: string }>
  /** A graph plugin's command: through the write pipeline (validate, lints, commit), like any tool call. */
  readonly write: (owner: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>
  /** The owner's command method. */
  readonly invoke: (owner: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>
  readonly snapshot: Effect.Effect<Snapshot.Snapshot, unknown>
  readonly render: (ids: ReadonlySet<string>) => Effect.Effect<string, unknown>
  /** A caller's read and command patterns; undefined caller: everything. */
  readonly scopeOf: (caller: string) => { readonly read: ReadonlyArray<string>; readonly command: ReadonlyArray<string> }
}

const graphLabel = (props: Readonly<Record<string, unknown>>, id: string) => String(props.title ?? props.name ?? props.text ?? id)

export const makeEntities = (b: Backend) => {
  const err = (tag: EntityError["tag"], message: string) => new EntityError({ tag, message })
  const allowed = (caller: string | undefined, type: string, what: "read" | "command") =>
    caller === undefined || b.kinds.get(type)?.owner === caller || b.scopeOf(caller)[what].some((p) => typeMatches(p, type))
  const kindOf = (type: string) => { const k = b.kinds.get(type); return k === undefined ? Effect.fail(err("UnknownType", `no plugin serves ${type}`)) : Effect.succeed(k) }
  const local = (k: Kind) => k.type.slice(k.owner.length + 1)
  const ask = <A>(k: Kind, op: string, ids: ReadonlyArray<string>) =>
    Effect.mapError(b.provider(k.owner, { op, kind: local(k), ids }) as Effect.Effect<A, { message: string }>, (e) => err("ProviderFailed", `${k.type}: ${e.message}`))

  /** One type's entities for these ids: graph ops from the snapshot unless the owner serves them. */
  const fetch = (k: Kind, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const snap = k.graph ? yield* Effect.orElseSucceed(b.snapshot, () => undefined) : undefined
      const nodes = k.graph && snap !== undefined ? ids.flatMap((id) => { const n = snap.nodes.get(id); return n !== undefined && n.type === k.type ? [n] : [] }) : []
      const got: ReadonlyArray<{ id: string; data: unknown }> = k.ops.has("get") || !k.graph ? yield* ask<ReadonlyArray<{ id: string; data: unknown }>>(k, "get", ids) : nodes.map((n) => ({ id: n.id, data: { props: n.props, edges: n.edges.map((e) => ({ type: e.type, to: e.to })) } }))
      const present = got.map((g) => g.id)
      const labels = k.ops.has("label") ? new Map((yield* ask<Array<{ id: string; text: string }>>(k, "label", present)).map((x) => [x.id, x.text])) : new Map(nodes.map((n) => [n.id, graphLabel(n.props, n.id)]))
      const versions = k.ops.has("version") ? new Map((yield* ask<Array<{ id: string; version: string }>>(k, "version", present)).map((x) => [x.id, x.version])) : new Map(nodes.map((n) => [n.id, hash(n)]))
      // An owner that versions its kind and has no version for an id no longer has it: gone, not versioned another way.
      return got.filter((g) => !k.ops.has("version") || versions.has(g.id)).map((g): Entity => {
        const version = versions.get(g.id) ?? versionOf(g.data)
        const label: Label = { text: labels.get(g.id) ?? g.id, tone: k.tone, glyph: k.glyph }
        return { ref: formatRef({ type: k.type, id: g.id, version }), type: k.type, id: g.id, version, label, data: g.data }
      })
    })

  const many = (refs: ReadonlyArray<string>, caller?: string) =>
    Effect.gen(function* () {
      const failed: Array<{ ref: string; _tag: string; message: string }> = []
      const byType = new Map<string, Array<{ ref: string; id: string }>>()
      for (const ref of refs) {
        const r = parseRef(ref)
        if (r === undefined) { failed.push({ ref, _tag: "NotFound", message: refProblem(ref)! }); continue }
        if (!b.kinds.has(r.type)) { failed.push({ ref, _tag: "UnknownType", message: `no plugin serves ${r.type}` }); continue }
        if (!allowed(caller, r.type, "read")) { failed.push({ ref, _tag: "NotAllowed", message: `${caller} may not read ${r.type}` }); continue }
        byType.set(r.type, [...(byType.get(r.type) ?? []), { ref, id: r.id }])
      }
      const parts = yield* Effect.forEach([...byType], ([type, wanted]) =>
        // A reply of the wrong shape (a defect, not a failure) fails its own refs only.
        Effect.match(fetch(b.kinds.get(type)!, wanted.map((w) => w.id)).pipe(Effect.catchCause((c) => Effect.fail(Cause.hasFails(c) ? Cause.squash(c) as EntityError : err("ProviderFailed", `${type}: its provider answered with the wrong shape`)))), {
          onFailure: (e) => (wanted.forEach((w) => failed.push({ ref: w.ref, _tag: e.tag, message: e.message })), [] as ReadonlyArray<Entity>),
          onSuccess: (es) => (wanted.filter((w) => !es.some((e) => e.id === w.id)).forEach((w) => failed.push({ ref: w.ref, _tag: "NotFound", message: `no ${w.ref}` })), es),
        }), { concurrency: "unbounded" })
      // Failures in the order the refs were given.
      failed.sort((x, y) => refs.indexOf(x.ref) - refs.indexOf(y.ref))
      return { entities: parts.flat(), failed }
    })
  const get = (ref: string, caller?: string) =>
    Effect.flatMap(many([ref], caller), (r) => (r.entities[0] !== undefined ? Effect.succeed(r.entities[0]) : Effect.fail(err(r.failed[0]!._tag as EntityError["tag"], r.failed[0]!.message))))
  const version = (ref: string, caller?: string) =>
    Effect.catchIf(Effect.map(get(ref, caller), (e) => e.version as string | null), (e: EntityError) => e.tag === "NotFound" && parseRef(ref) !== undefined, () => Effect.succeed(null))
  const changed = (ref: string, caller?: string) =>
    Effect.map(version(ref, caller), (v) => v === null || v !== parseRef(ref)?.version)
  const context = (ref: string, caller?: string) =>
    Effect.gen(function* () {
      const e = yield* get(ref, caller)
      const k = b.kinds.get(e.type)!
      if (k.ops.has("context")) return ((yield* ask<Array<{ text: string }>>(k, "context", [e.id]))[0]?.text ?? "")
      if (k.graph) return yield* Effect.mapError(b.render(new Set([e.id])), () => err("ProviderFailed", `${k.type}: render failed`))
      return JSON.stringify(e.data, null, 2)
    })
  const query = (q: Query, caller?: string) =>
    Effect.gen(function* () {
      const k = yield* kindOf(q.type)
      if (!allowed(caller, k.type, "read")) return yield* Effect.fail(err("NotAllowed", `${caller} may not read ${k.type}`))
      // An owner's own query is its answer (its filter, its order); the host only fetches what it named.
      if (k.ops.has("query")) {
        const ids = yield* Effect.mapError(b.provider(k.owner, { op: "query", kind: local(k), query: { ...(q.where !== undefined ? { where: q.where } : {}), ...(q.text !== undefined ? { text: q.text } : {}), ...(q.limit !== undefined ? { limit: q.limit } : {}) } }) as Effect.Effect<ReadonlyArray<string>, { message: string }>, (e) => err("ProviderFailed", `${k.type}: ${e.message}`))
        const es = yield* fetch(k, q.limit !== undefined ? ids.slice(0, q.limit) : ids)
        return [...es].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id))
      }
      if (!k.graph) return []
      // A graph kind: filter on the nodes' props first, so only what is kept is fetched.
      const snap = yield* Effect.orElseSucceed(b.snapshot, () => Snapshot.empty)
      const nodes = Snapshot.byType(snap, k.type).filter((n) => q.where === undefined || Object.entries(q.where).every(([f, v]) => JSON.stringify(n.props[f]) === JSON.stringify(v)))
      const plain = q.text === undefined || q.text.trim().length === 0
      if (plain) return yield* fetch(k, (q.limit !== undefined ? nodes.slice(0, q.limit) : nodes).map((n) => n.id))
      let es = yield* fetch(k, nodes.map((n) => n.id))
      const scores = rank(es.map((e) => `${e.label.text} ${JSON.stringify(e.data)}`), q.text!)
      es = es.map((e, i) => [e, scores[i] ?? 0] as const).filter(([, sc]) => sc > 0).sort((x, y) => y[1] - x[1]).map(([e]) => e)
      return q.limit !== undefined ? es.slice(0, q.limit) : es
    })
  const command = (ref: string, name: string, args: unknown, caller?: string) =>
    Effect.gen(function* () {
      const r = parseRef(ref)
      if (r === undefined) return yield* Effect.fail(err("NotFound", refProblem(ref)!))
      const k = yield* kindOf(r.type)
      if (!allowed(caller, k.type, "command")) return yield* Effect.fail(err("NotAllowed", `${caller} may not command ${k.type}`))
      const method = k.commands[name]
      if (method === undefined) return yield* Effect.fail(err("NotFound", `${k.type} has no command ${name}; it has ${Object.keys(k.commands).join(", ") || "none"}`))
      const params = { ...(args as object), id: r.id }
      return yield* Effect.mapError(k.ownerGraph ? b.write(k.owner, method, params) : b.invoke(k.owner, method, params), (e) => err("ProviderFailed", `${k.type}.${name}: ${e.message}`))
    })
  const label = (ref: string, caller?: string) => Effect.map(get(ref, caller), (e) => e.label)
  const types = () => [...b.kinds.values()].map((k) => ({ type: k.type, doc: k.doc, tone: k.tone, glyph: k.glyph, commands: Object.keys(k.commands), ...(k.open !== undefined ? { open: k.open } : {}), data: k.data }))
  return { types, many, get, query, version, changed, label, context, command }
}

/** The `entities.call` power: one op for a plugin, under its scope. */
export const entityPower = (e: ReturnType<typeof makeEntities>, caller: string, a: { readonly op: string; readonly ref?: string; readonly refs?: ReadonlyArray<string>; readonly query?: Query; readonly name?: string; readonly args?: unknown }): Effect.Effect<unknown, EntityError> => {
  const ref = String(a.ref ?? "")
  switch (a.op) {
    case "get": return e.get(ref, caller)
    case "many": return e.many(a.refs ?? [], caller)
    case "query": return a.query === undefined ? Effect.fail(new EntityError({ tag: "NotFound", message: "query needs a type" })) : e.query(a.query, caller)
    case "version": return e.version(ref, caller)
    case "changed": return e.changed(ref, caller)
    case "label": return e.label(ref, caller)
    case "context": return e.context(ref, caller)
    case "command": return e.command(ref, String(a.name ?? ""), a.args ?? {}, caller)
    default: return Effect.fail(new EntityError({ tag: "NotFound", message: `no entities op ${a.op}` }))
  }
}
