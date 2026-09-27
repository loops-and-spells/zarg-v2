import { Effect, Layer, Schema, Stream } from "effect"
import { Config, Files, Graph, Http, PluginFailure, type RawPowers, Secrets, servicesFrom } from "./services"

export interface Scopes {
  readonly net?: ReadonlyArray<string> | "ask"
  readonly secrets?: ReadonlyArray<string>
  readonly graph?: "read" | "write"
  readonly fs?: { readonly read?: ReadonlyArray<string> | "ask"; readonly write?: ReadonlyArray<string> | "ask" }
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
  readonly archetype: "graph" | "provider"
  readonly config: Schema.Codec<any, any>
  readonly scopes: Scopes
  readonly optional?: Scopes
  readonly methods: M
  readonly graph?: { readonly nodes: Readonly<Record<string, Schema.Codec<any, any>>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
  readonly make: Effect.Effect<Handlers<M>, never, Secrets | Http | Files | Graph | Config>
}
export interface Plugin<M extends Record<string, MethodSpec> = Record<string, MethodSpec>> extends PluginDef<M> {
  /** Called by the runner inside the plugin's Compartment. */
  readonly serve: (raw: RawPowers) => Record<string, (p: unknown) => Promise<unknown> | AsyncIterable<unknown>>
}

const NAME = /^[a-z][a-z0-9-]*$/
const SERVICE = /^[A-Z][A-Za-z0-9]*$/

export const definePlugin = <const M extends Record<string, MethodSpec>>(def: PluginDef<M>): Plugin<M> => {
  if (!NAME.test(def.name)) throw new Error(`plugin name "${def.name}" must be kebab-case`)
  if (!SERVICE.test(def.service)) throw new Error(`plugin service "${def.service}" must be PascalCase`)
  const serve = (raw: RawPowers) => {
    const s = servicesFrom(raw)
    const layer = Layer.mergeAll(
      Layer.succeed(Secrets, s.secrets), Layer.succeed(Http, s.http), Layer.succeed(Files, s.files), Layer.succeed(Graph, s.graph),
      Layer.effect(Config, Effect.map(Effect.promise(() => raw.call("config.get", {})), (value) => Config.of({ value }))),
    )
    // Handlers are built once, on the first call, so a plugin with a broken config fails that call and not the load.
    let built: Promise<Handlers<M>> | undefined
    const handlers = () => (built ??= Effect.runPromise(def.make.pipe(Effect.provide(layer))))
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
