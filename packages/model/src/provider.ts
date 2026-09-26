import { Effect, Redacted } from "effect"
import type { ConfigValue } from "./config"
import { ConfigError } from "./errors"
import type { ModelError, ModelInfo, WireClient } from "./wire"

/**
 * A provider plugin: how zarg reaches one model host.
 * Its env schema fragment declares `envKeys`; login forms are built from them.
 */
export interface Provider {
  readonly name: string
  /** Variables this provider reads, declared in its `.env.schema` fragment. */
  readonly envKeys: ReadonlyArray<string>
  /** Absolute path of the provider's `.env.schema` fragment, imported by the project schema. */
  readonly schemaFile: string
  /** Build a client from the provider's config table (`[providers.<name>]`, already `${VAR}`-expanded). */
  readonly connect: (settings: Readonly<Record<string, ConfigValue>>) => Effect.Effect<ProviderClient, ConfigError>
}

export interface ProviderClient extends WireClient {
  /** Load a cold model before the first turn (zarg-router). */
  readonly warm?: (model: string) => Effect.Effect<void, ModelError>
  /** Native decision endpoint (zarg-router `POST /systemone`), for models with the "decision" capability. */
  readonly systemone?: (body: unknown) => Effect.Effect<unknown, ModelError>
}

/** A required plain setting, or a ConfigError naming the key. */
export const plain = (provider: string, settings: Readonly<Record<string, ConfigValue>>, key: string) => {
  const v = settings[key]
  if (v === undefined) {
    return Effect.fail(new ConfigError({ message: `providers.${provider}.${key} is not set`, key: `providers.${provider}.${key}` }))
  }
  return Effect.succeed(Redacted.isRedacted(v) ? Redacted.value(v) : v)
}

/** An optional setting that must be secret when present (API keys). */
export const secret = (provider: string, settings: Readonly<Record<string, ConfigValue>>, key: string) => {
  const v = settings[key]
  if (v === undefined) return Effect.succeed(undefined)
  return Redacted.isRedacted(v)
    ? Effect.succeed(v)
    : Effect.fail(
        new ConfigError({
          message: `providers.${provider}.${key} must come from a @sensitive variable, e.g. "\${OPENROUTER_API_KEY}"`,
          key: `providers.${provider}.${key}`,
        }),
      )
}

export type { ModelInfo }
