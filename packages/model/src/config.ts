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

const KNOWN = new Set(["providers", "roles", "rlm", "reconcile", "plugins", "agents"])
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

/** Roles as every reader sees them: a role's own model, else `roles.default`; updated in place by `reload`. */
const liveRoles = (own: Record<string, string>) => {
  let current = own
  const view = new Proxy({} as Record<string, string>, {
    get: (_t, k) => (typeof k === "string" ? (current[k] ?? current.default) : undefined),
    has: (_t, k) => typeof k === "string" && k in current,
    ownKeys: () => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && k in current ? { value: current[k], enumerable: true, configurable: true, writable: false } : undefined),
  })
  return { view, set: (next: Record<string, string>) => void (current = next) }
}
/** Each loaded config's in-place updater (for `reload`). */
const setters = new WeakMap<ZargConfig, (next: ZargConfig) => void>()
/** A config whose providers, roles and extra sections `reload` updates in place: every holder sees the change. */
const live = (providers: Record<string, Record<string, ConfigValue>>, roles: Record<string, string>, extra: Record<string, unknown>): ZargConfig => {
  const r = liveRoles(roles)
  const p = { ...providers }
  const e = { ...extra }
  const config: ZargConfig = { providers: p, roles: r.view, extra: e }
  setters.set(config, (next) => {
    for (const k of Object.keys(p)) delete p[k]
    Object.assign(p, next.providers)
    for (const k of Object.keys(e)) delete e[k]
    Object.assign(e, next.extra)
    r.set({ ...next.roles })
  })
  return config
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
    return live(providers, roles, extra)
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

/** The model for a role: its own, else the default; a ConfigError pointing at /models when there is neither. */
export const roleModel = (config: ZargConfig, role: string) => {
  const ref = config.roles[role] ?? config.roles.default
  return ref === undefined ? Effect.fail(new ConfigError({ message: `no model for role "${role}" (set a default with /models)`, key: `roles.${role}` })) : Effect.succeed(ref)
}

/** Re-read both config files and update this config object in place (every holder sees the change). */
export const reload = (config: ZargConfig, opts: { readonly userDir: string; readonly projectDir: string }) =>
  Effect.flatMap(load(opts), (next) => Effect.sync(() => setters.get(config)?.(next)))

/** Edit the user config: `roles.default`, and a provider section only when it is missing. Other lines stay as they are; the write is atomic. */
export const setUserConfig = (file: string, edit: { readonly default?: string; readonly provider?: { readonly name: string; readonly settings: Readonly<Record<string, string>> } }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const io = (e: { message: string }) => new ConfigError({ message: e.message, file })
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
    let lines = exists ? (yield* fs.readFileString(file).pipe(Effect.mapError(io))).replace(/\n$/, "").split("\n") : []
    if (lines.length === 1 && lines[0] === "") lines = []
    const header = (name: string) => lines.findIndex((l) => l.trim() === `[${name}]`)
    const sectionEnd = (start: number) => {
      const next = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l))
      return next < 0 ? lines.length : next
    }
    if (edit.default !== undefined) {
      const line = `default = ${JSON.stringify(edit.default)}`
      const at = header("roles")
      if (at < 0) lines = [...lines, ...(lines.length > 0 ? [""] : []), "[roles]", line]
      else {
        const end = sectionEnd(at)
        const k = lines.findIndex((l, i) => i > at && i < end && /^\s*default\s*=/.test(l))
        if (k >= 0) lines[k] = line
        else lines.splice(at + 1, 0, line)
      }
    }
    if (edit.provider !== undefined && header(`providers.${edit.provider.name}`) < 0) {
      while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop()
      lines = [...lines, ...(lines.length > 0 ? [""] : []), `[providers.${edit.provider.name}]`, ...Object.entries(edit.provider.settings).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)]
    }
    const dir = file.slice(0, file.lastIndexOf("/"))
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(io))
    const tmp = `${file}.${process.pid}.tmp`
    yield* fs.writeFileString(tmp, `${lines.join("\n")}\n`).pipe(Effect.mapError(io))
    yield* fs.rename(tmp, file).pipe(Effect.mapError(io))
  })
