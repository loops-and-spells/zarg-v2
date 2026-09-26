import { Context, Effect, FileSystem, Layer, Path, Redacted } from "effect"
import { Env } from "./env"
import { ConfigError } from "./errors"

/** A config string after `${VAR}` expansion: Redacted when any part came from a sensitive variable. */
export type ConfigValue = string | Redacted.Redacted<string>

export interface ZargConfig {
  /** Provider name → its settings (validated by the provider plugin). */
  readonly providers: Readonly<Record<string, Readonly<Record<string, ConfigValue>>>>
  /** Role name → `provider:model`. */
  readonly roles: Readonly<Record<string, string>>
  /** Sections owned by other packages (e.g. `rlm`), passed through after expansion. */
  readonly extra: Readonly<Record<string, unknown>>
}

export class Config extends Context.Service<Config, ZargConfig>()("@zarg/model/Config") {}

const KNOWN = new Set(["providers", "roles", "rlm"])
const VAR = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Expand `${VAR}` / `${VAR:-default}` in one string; `$${` stays a literal `${`. */
export const expand = (text: string, key: string, env: Env["Service"]) =>
  Effect.gen(function* () {
    let sensitive = false
    const parts: Array<string> = []
    let last = 0
    for (const m of text.matchAll(VAR)) {
      parts.push(text.slice(last, m.index))
      last = m.index + m[0].length
      if (m[0] === "$${") {
        parts.push("${")
        continue
      }
      const name = m[1]!
      const value = yield* env.lookup(name)
      if (value === undefined) {
        if (m[2] !== undefined) {
          parts.push(m[2])
          continue
        }
        return yield* new ConfigError({ message: `${key}: \${${name}} is not set`, key })
      }
      if (Redacted.isRedacted(value)) {
        sensitive = true
        parts.push(Redacted.value(value))
      } else parts.push(value)
    }
    parts.push(text.slice(last))
    const joined = parts.join("")
    return sensitive ? Redacted.make(joined) : joined
  })

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)

const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] = isTable(prev) && isTable(v) ? merge(prev, v) : v
  }
  return out
}

const expandDeep = (value: unknown, key: string, env: Env["Service"]): Effect.Effect<unknown, ConfigError> => {
  if (typeof value === "string") return expand(value, key, env)
  if (Array.isArray(value)) return Effect.forEach(value, (v, i) => expandDeep(v, `${key}[${i}]`, env))
  if (isTable(value)) {
    return Effect.map(
      Effect.forEach(Object.entries(value), ([k, v]) =>
        Effect.map(expandDeep(v, key === "" ? k : `${key}.${k}`, env), (x) => [k, x] as const),
      ),
      Object.fromEntries,
    )
  }
  return Effect.succeed(value)
}

const decode = (raw: Record<string, unknown>): Effect.Effect<ZargConfig, ConfigError> =>
  Effect.gen(function* () {
    for (const k of Object.keys(raw)) {
      if (!KNOWN.has(k)) return yield* new ConfigError({ message: `unknown config section "${k}"`, key: k })
    }
    const providers: Record<string, Record<string, ConfigValue>> = {}
    for (const [name, table] of Object.entries(raw.providers ?? {})) {
      if (!isTable(table)) return yield* new ConfigError({ message: `providers.${name} must be a table`, key: `providers.${name}` })
      const settings: Record<string, ConfigValue> = {}
      for (const [k, v] of Object.entries(table)) {
        if (typeof v !== "string" && !Redacted.isRedacted(v)) {
          return yield* new ConfigError({ message: `providers.${name}.${k} must be a string`, key: `providers.${name}.${k}` })
        }
        settings[k] = v as ConfigValue
      }
      providers[name] = settings
    }
    const roles: Record<string, string> = {}
    for (const [role, ref] of Object.entries(raw.roles ?? {})) {
      if (typeof ref !== "string" || !/^[^:\s]+:\S+$/.test(ref)) {
        return yield* new ConfigError({ message: `roles.${role} must look like "provider:model"`, key: `roles.${role}` })
      }
      roles[role] = ref
    }
    const { providers: _p, roles: _r, ...extra } = raw
    return { providers, roles, extra }
  })

/** Read `<userDir>/config.toml` then `<projectDir>/.zarg/config.toml` (project wins), expand, validate. */
export const load = (opts: { readonly userDir: string; readonly projectDir: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const env = yield* Env
    let merged: Record<string, unknown> = {}
    for (const file of [path.join(opts.userDir, "config.toml"), path.join(opts.projectDir, ".zarg", "config.toml")]) {
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
      if (!exists) continue
      const text = yield* fs.readFileString(file).pipe(
        Effect.mapError((e) => new ConfigError({ message: e.message, file })),
      )
      const parsed = yield* Effect.try({
        try: () => Bun.TOML.parse(text) as Record<string, unknown>,
        catch: (e) => new ConfigError({ message: `invalid TOML: ${e instanceof Error ? e.message : String(e)}`, file }),
      })
      merged = merge(merged, parsed)
    }
    const expanded = (yield* expandDeep(merged, "", env)) as Record<string, unknown>
    return yield* decode(expanded)
  })

export const layer = (opts: { readonly userDir: string; readonly projectDir: string }) =>
  Layer.effect(Config, load(opts))

/** The model reference configured for a role, or a ConfigError naming the key to set. */
export const roleModel = (config: ZargConfig, role: string) =>
  config.roles[role] === undefined
    ? Effect.fail(new ConfigError({ message: `no model for role "${role}"; set roles.${role} in .zarg/config.toml`, key: `roles.${role}` }))
    : Effect.succeed(config.roles[role]!)
