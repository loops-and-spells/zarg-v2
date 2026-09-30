import { Effect, Layer, Schema, Stream } from "effect"
import type { Contract } from "./contract"
import { entitiesProblem, layoutOf, opensProblem, type Surface, surfacesProblem, tonesProblem, type ViewDef } from "@zarg/view"
import { conversations } from "./conversation"
import { type EntityDecl, type EntityHandlers, opsOf, serveEntity } from "./entities"
import { Agenda, Agents, Attention, Inbox, Clock, Conversation, Config, Decisions, Entities, Files, Graph, Http, Models, PluginFailure, type RawPowers, Secrets, servicesFrom, Surfaces, Views } from "./services"

export interface Scopes {
  readonly net?: ReadonlyArray<string> | "ask"
  readonly secrets?: ReadonlyArray<string>
  readonly graph?: "read" | "write"
  readonly fs?: { readonly read?: ReadonlyArray<string> | "ask"; readonly write?: ReadonlyArray<string> | "ask" }
  /** The decision model. */
  readonly decisions?: boolean
  /** Model roles it may run. */
  readonly models?: ReadonlyArray<string>
  /** Agents in the agents pane. */
  readonly agents?: boolean
  /** The operator's inbox: topics to ask, post, settle and update. */
  readonly inbox?: boolean
  /** Other plugins' entity types it reads or commands (patterns: `plugin/kind`, `plugin/*`); its own always. */
  readonly entities?: { readonly read?: ReadonlyArray<string>; readonly command?: ReadonlyArray<string> }
}
export interface MethodSpec {
  readonly doc: string
  readonly params: Schema.Codec<any, any>
  readonly success: Schema.Codec<any, any>
  readonly agents?: boolean
  readonly deadlineMs?: number
  readonly stream?: boolean
}
/** A slash command a plugin adds (the TUI's command-table shape, plus the method it calls). */
export interface PluginCommand {
  readonly cmd: string
  readonly desc: string
  readonly method: string
  readonly arg: {
    readonly kind: "none" | "choice" | "text" | "path"
    readonly hint?: string
    readonly choices?: ReadonlyArray<string>
    readonly required?: boolean
    readonly params?: { readonly keys: ReadonlyArray<string>; readonly flags?: ReadonlyArray<string> }
  }
}
export interface EdgeSpec { readonly from: string; readonly to: string; readonly min?: number; readonly max?: number }
type Handlers<M extends Record<string, MethodSpec>> = {
  readonly [K in keyof M]: (p: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, PluginFailure> | Stream.Stream<unknown, PluginFailure>
}
export interface PluginDef<M extends Record<string, MethodSpec>> {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service" | "agent"
  /** Agents only: where it runs. A bundle is always sandboxed; `trusted` agents are zarg's own packages, loaded by the core. */
  readonly runtime?: "sandboxed" | "trusted"
  readonly config: Schema.Codec<any, any>
  /** The contract this plugin serves to plugins that depend on it (its public read methods). */
  readonly implements?: Contract
  /** Slash commands for the TUI: each calls `method` with `{ args }` and shows its `{ notice }`. */
  readonly commands?: ReadonlyArray<PluginCommand>
  /** Contracts of the plugins this one needs: it loads only when they are loaded, and yields them as services. */
  readonly pluginDependencies?: ReadonlyArray<Contract>
  /** Views its agents draw (`Agents.start({ view })`, then `Views.set` / `Views.append`). */
  readonly views?: ReadonlyArray<ViewDef<any>>
  /** Where its views show (`Surfaces.open`): tiles, panels, popovers, sheets. */
  readonly surfaces?: ReadonlyArray<Surface>
  readonly scopes: Scopes
  readonly optional?: Scopes
  readonly methods: M
  readonly graph?: { readonly nodes: Readonly<Record<string, Schema.Codec<any, any>>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
  /** Entity kinds it serves (`<name>/<kind>`), implemented by `entities` in what `make` returns. */
  readonly entities?: Readonly<Record<string, EntityDecl>>
  readonly make: Effect.Effect<Handlers<M> & { readonly entities?: Readonly<Record<string, EntityHandlers>> }, never, any>
}
export interface Plugin<M extends Record<string, MethodSpec> = Record<string, MethodSpec>> extends PluginDef<M> {
  /** Called by the runner inside the plugin's Compartment. */
  readonly serve: (raw: RawPowers) => Record<string, (p: unknown) => Promise<unknown> | AsyncIterable<unknown>>
}

// Same rule as the host (@zarg/plugin/runtime PLUGIN_NAME): no doubled or trailing dash, so secret namespaces never collide.
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const SERVICE = /^[A-Z][A-Za-z0-9]*$/

export const definePlugin = <const M extends Record<string, MethodSpec>>(def: PluginDef<M>): Plugin<M> => {
  if (!NAME.test(def.name)) throw new Error(`plugin name "${def.name}" must be kebab-case`)
  if (!SERVICE.test(def.service)) throw new Error(`plugin service "${def.service}" must be PascalCase`)
  for (const c of def.commands ?? []) {
    if (!/^\/[a-z][a-z0-9-]*$/.test(c.cmd)) throw new Error(`plugin command "${c.cmd}" must be /kebab-case`)
    if (!(c.method in def.methods)) throw new Error(`plugin command ${c.cmd} calls ${c.method}, which is not a method`)
  }
  const names = (def.views ?? []).map((v) => v.name)
  const twice = names.find((n, i) => names.indexOf(n) !== i)
  if (twice !== undefined) throw new Error(`plugin ${def.name}: view ${twice} is defined twice`)
  const surfaces = surfacesProblem(def.surfaces, (def.views ?? []).map(layoutOf))
  if (surfaces !== undefined) throw new Error(`plugin ${def.name}: ${surfaces}`)
  const opens = opensProblem((def.views ?? []).map(layoutOf), def.surfaces ?? [])
  if (opens !== undefined) throw new Error(`plugin ${def.name}: ${opens}`)
  const tones = tonesProblem((def.views ?? []).map(layoutOf))
  if (tones !== undefined) throw new Error(`plugin ${def.name}: ${tones}`)
  const ents = entitiesProblem(def.name, def.entities, Object.keys(def.methods))
  if (ents !== undefined) throw new Error(ents)
  const serve = (raw: RawPowers) => {
    const s = servicesFrom(raw)
    const talks = conversations(raw)
    // Each dependency is its contract's service, over the plugins.call power, encoded with the contract's Schemas.
    const deps = (def.pluginDependencies ?? []).map((dep) =>
      Layer.succeed(
        dep,
        Object.fromEntries(
          Object.entries(dep.methods).map(([m, spec]) => [
            m,
            (p: unknown) =>
              Effect.tryPromise({
                try: () => raw.call("plugins.call", { name: dep.pluginName, method: m, params: Schema.encodeSync(spec.params)(p) }),
                catch: (e) => new PluginFailure({ tag: String((e as { tag?: string }).tag ?? "PluginError"), message: String((e as Error).message ?? e) }),
              }).pipe(
                Effect.flatMap((v) => Schema.decodeUnknownEffect(spec.success)(v)),
                Effect.mapError((e) => (e instanceof PluginFailure ? e : new PluginFailure({ tag: "PluginError", message: `${dep.pluginName}.${m}: ${e.message}` }))),
              ),
          ]),
        ) as never,
      ),
    )
    const layer = Layer.mergeAll(
      Layer.succeed(Secrets, s.secrets), Layer.succeed(Http, s.http), Layer.succeed(Files, s.files), Layer.succeed(Graph, s.graph), Layer.succeed(Entities, s.entities),
      Layer.succeed(Decisions, s.decisions), Layer.succeed(Models, s.models), Layer.succeed(Clock, s.clock), Layer.succeed(Agenda, s.agenda), Layer.succeed(Agents, s.agents), Layer.succeed(Views, s.views), Layer.succeed(Surfaces, s.surfaces), Layer.succeed(Attention, s.attention), Layer.succeed(Inbox, s.inbox), Layer.succeed(Conversation, talks.service),
      Layer.effect(Config, Effect.map(Effect.promise(() => raw.call("config.get", {})), (value) => Config.of({ value }))),
      ...deps,
    )
    // Handlers are built once, on the first call, so a plugin with a broken config fails that call and not the load.
    let built: Promise<Handlers<M>> | undefined
    const handlers = () => (built ??= Effect.runPromise(def.make.pipe(Effect.provide(layer)) as Effect.Effect<Handlers<M>>))
    // Every op a kind declares needs its handler (a label defaults to the id): a mismatch fails loudly, naming both.
    const checkedEntities = async () => {
      const h = ((await handlers()) as unknown as { readonly entities?: Readonly<Record<string, EntityHandlers>> }).entities
      for (const [kind, d] of Object.entries(def.entities ?? {})) {
        const served = opsOf(h?.[kind])
        const ops = d.ops ?? (def.archetype === "graph" ? [] : ["get", "label", "version"])
        // label, version and context are answered over get's data: they need a get handler too.
        const needs = [...ops, ...(ops.some((op) => op !== "query") ? ["get" as const] : [])]
        const missing = needs.find((op) => op !== "label" && !served.includes(op))
        if (missing !== undefined) throw new Error(`plugin ${def.name}: entity ${kind} declares ${missing} but has no ${missing} handler`)
      }
      return h
    }
    return Object.fromEntries([
      // The host calls this when the plugin loads: its services start then (a run a restart cut short resumes).
      // Not a method name a plugin can declare (those start with a letter).
      // The host starts service and agent plugins; graph plugins are checked on their first entity call.
      ["$start", async () => (await checkedEntities(), null)],
      // The host asks for this plugin's entities (get, query, label, context, version) by kind.
      ["$entity", async (p: unknown) => Effect.runPromise(serveEntity(await checkedEntities())(p as never) as Effect.Effect<unknown, PluginFailure>)],
      // The operator answered or wrote to one of its agents (the core routes these; plugins cannot declare `$` names).
      ["$answer", async (p: unknown) => talks.answer(p as never)],
      [
        "$message",
        async (p: unknown) => {
          await talks.message(p as never)
          const h = (await handlers()) as Record<string, (p: unknown) => unknown>
          const out = h.message?.(p)
          if (out !== undefined && Effect.isEffect(out)) await Effect.runPromise(out as Effect.Effect<unknown>)
          return null
        },
      ],
      ...Object.entries(def.methods).map(([name, spec]) => [
        name,
        async (raw: unknown) => {
          const h = (await handlers())[name]!
          const params = await Effect.runPromise(Schema.decodeUnknownEffect(spec.params)(raw).pipe(Effect.mapError((e) => new PluginFailure({ tag: "PluginError", message: `${def.name}.${name}: ${e.message}` }))))
          const out = h(params as never)
          if (Stream.isStream(out)) return Stream.toAsyncIterable(Stream.mapEffect(out, (v) => Schema.encodeEffect(spec.success)(v)))
          return Effect.runPromise((out as Effect.Effect<unknown, PluginFailure>).pipe(Effect.flatMap((v) => Schema.encodeEffect(spec.success)(v))))
        },
      ]),
    ])
  }
  return { ...def, serve }
}
