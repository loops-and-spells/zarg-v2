import { Context, Effect, Layer, Stream } from "effect"
import { Config, type ZargConfig } from "./config"
import type { Provider, ProviderClient } from "./provider"
import { type ChatMessage, ModelError, type ModelInfo, type StreamEvent, type ToolDef } from "./wire"

/** `provider:model`, as roles name models in config. */
export type ModelRef = string

export interface ModelRequest {
  readonly model: ModelRef
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<ToolDef>
  readonly maxTokens?: number
  readonly reasoning?: { readonly effort?: string; readonly enabled?: boolean }
  readonly outputSchema?: Record<string, unknown>
}

export class Model extends Context.Service<
  Model,
  {
    readonly stream: (req: ModelRequest) => Stream.Stream<StreamEvent, ModelError>
    /** Limits and capabilities from the provider's /models row. */
    readonly info: (ref: ModelRef) => Effect.Effect<ModelInfo, ModelError>
    readonly list: (provider: string) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelError>
    /** Load a cold model; a no-op for providers without warm-up. */
    readonly warm: (ref: ModelRef) => Effect.Effect<void, ModelError>
    readonly client: (provider: string) => Effect.Effect<ProviderClient, ModelError>
  }
>()("@zarg/model/Model") {}

export const splitRef = (ref: ModelRef) => {
  const i = ref.indexOf(":")
  return i <= 0 || i === ref.length - 1
    ? Effect.fail(new ModelError({ kind: "config", message: `model reference "${ref}" must look like "provider:model"` }))
    : Effect.succeed({ provider: ref.slice(0, i), model: ref.slice(i + 1) })
}

/** Routes `provider:model` references to provider plugins configured in `[providers.<name>]`. */
export const make = (providers: ReadonlyArray<Provider>, config: ZargConfig) =>
  Effect.gen(function* () {
    const clients = new Map<string, ProviderClient>()
    for (const p of providers) {
      const settings = config.providers[p.name]
      if (settings === undefined) continue
      clients.set(p.name, yield* p.connect(settings))
    }
    const client = (name: string) => {
      const c = clients.get(name)
      return c === undefined
        ? Effect.fail(
            new ModelError({
              kind: "config",
              message: providers.some((p) => p.name === name)
                ? `provider "${name}" is not configured; add [providers.${name}] to .zarg/config.toml`
                : `no provider plugin named "${name}"`,
            }),
          )
        : Effect.succeed(c)
    }
    const cache = new Map<string, ReadonlyArray<ModelInfo>>()
    const list = (name: string) =>
      cache.has(name)
        ? Effect.succeed(cache.get(name)!)
        : Effect.flatMap(client(name), (c) => Effect.tap(c.models, (ms) => Effect.sync(() => cache.set(name, ms))))
    const info = (ref: ModelRef) =>
      Effect.gen(function* () {
        const { provider, model } = yield* splitRef(ref)
        const found = (yield* list(provider)).find((m) => m.id === model)
        if (found === undefined) {
          return yield* new ModelError({ kind: "limits", message: `${provider} does not list a model "${model}"` })
        }
        return found
      })
    return {
      client,
      list,
      info,
      warm: (ref) =>
        Effect.gen(function* () {
          const { provider, model } = yield* splitRef(ref)
          const c = yield* client(provider)
          if (c.warm !== undefined) yield* c.warm(model)
        }),
      stream: (req) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { provider, model } = yield* splitRef(req.model)
            const c = yield* client(provider)
            return c.stream({ ...req, model })
          }),
        ),
    } satisfies Model["Service"]
  })

export const layer = (providers: ReadonlyArray<Provider>) =>
  Layer.effect(Model, Effect.flatMap(Config, (c) => make(providers, c)))
