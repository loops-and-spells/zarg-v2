import { Effect, Layer, Schema, Stream } from "effect"
import type { Contract } from "./contract"
import { Agenda, Clock, Config, Decisions, Files, Graph, Http, Models, PluginFailure, type RawPowers, Secrets, servicesFrom } from "./services"

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
}
export interface MethodSpec {
  readonly doc: string
  readonly params: Schema.Codec<any, any>
  readonly success: Schema.Codec<any, any>
  readonly agents?: boolean
  readonly deadlineMs?: number
  readonly stream?: boolean
}
export interface EdgeSpec { readonly from: string; readonly to: string; readonly min?: number; readonly max?: number }
type Handlers<M extends Record<string, MethodSpec>> = {
  readonly [K in keyof M]: (p: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, PluginFailure> | Stream.Stream<unknown, PluginFailure>
}
export interface PluginDef<M extends Record<string, MethodSpec>> {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service"
  readonly config: Schema.Codec<any, any>
  /** The contract this plugin serves to plugins that depend on it (its public read methods). */
  readonly implements?: Contract
  /** Contracts of the plugins this one needs: it loads only when they are loaded, and yields them as services. */
  readonly pluginDependencies?: ReadonlyArray<Contract>
  readonly scopes: Scopes
  readonly optional?: Scopes
  readonly methods: M
  readonly graph?: { readonly nodes: Readonly<Record<string, Schema.Codec<any, any>>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
  readonly make: Effect.Effect<Handlers<M>, never, any>
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
  const serve = (raw: RawPowers) => {
    const s = servicesFrom(raw)
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
      Layer.succeed(Secrets, s.secrets), Layer.succeed(Http, s.http), Layer.succeed(Files, s.files), Layer.succeed(Graph, s.graph),
      Layer.succeed(Decisions, s.decisions), Layer.succeed(Models, s.models), Layer.succeed(Clock, s.clock), Layer.succeed(Agenda, s.agenda),
      Layer.effect(Config, Effect.map(Effect.promise(() => raw.call("config.get", {})), (value) => Config.of({ value }))),
      ...deps,
    )
    // Handlers are built once, on the first call, so a plugin with a broken config fails that call and not the load.
    let built: Promise<Handlers<M>> | undefined
    const handlers = () => (built ??= Effect.runPromise(def.make.pipe(Effect.provide(layer)) as Effect.Effect<Handlers<M>>))
    return Object.fromEntries(
      Object.entries(def.methods).map(([name, spec]) => [
        name,
        async (raw: unknown) => {
          const h = (await handlers())[name]!
          const params = await Effect.runPromise(Schema.decodeUnknownEffect(spec.params)(raw).pipe(Effect.mapError((e) => new PluginFailure({ tag: "PluginError", message: `${def.name}.${name}: ${e.message}` }))))
          const out = h(params as never)
          if (Stream.isStream(out)) return Stream.toAsyncIterable(Stream.mapEffect(out, (v) => Schema.encodeEffect(spec.success)(v)))
          return Effect.runPromise((out as Effect.Effect<unknown, PluginFailure>).pipe(Effect.flatMap((v) => Schema.encodeEffect(spec.success)(v))))
        },
      ]),
    )
  }
  return { ...def, serve }
}
