import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Redacted, Ref } from "effect"
import { internal } from "varlock"
import { EnvError } from "./errors"
import type { SensitiveValue } from "./redact"

/** One variable from the env schema, as a login form or a checker needs it. */
export interface EnvField {
  readonly name: string
  readonly type: string | undefined
  readonly description: string | undefined
  readonly sensitive: boolean
  readonly required: boolean
  /** Validation errors for the current value (empty when valid). */
  readonly errors: ReadonlyArray<string>
}

interface Snapshot {
  readonly values: ReadonlyMap<string, string>
  readonly fields: ReadonlyMap<string, EnvField>
  readonly sensitive: ReadonlyArray<SensitiveValue>
}

export class Env extends Context.Service<
  Env,
  {
    /** The resolved value; sensitive values come back Redacted. */
    readonly get: (name: string) => Effect.Effect<string | Redacted.Redacted<string>, EnvError>
    /** Like `get`, but `undefined` when the variable has no value. */
    readonly lookup: (name: string) => Effect.Effect<string | Redacted.Redacted<string> | undefined>
    readonly fields: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<EnvField>, EnvError>
    readonly sensitive: Effect.Effect<ReadonlyArray<SensitiveValue>>
    readonly reload: Effect.Effect<void, EnvError>
  }
>()("@zarg/model/Env") {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Load `<projectDir>/.env.schema` with varlock: follows `@import`, decrypts `varlock("local:...")`,
 * and lets process env values override files (varlock's precedence).
 * Uses varlock's `internal` loader, the one its CLI uses (the plain loader lacks the `varlock()` resolver).
 */
export interface EnvOptions {
  /** The operator's own settings (`~/.config/zarg`): their logins, for every project. */
  readonly userDir?: string
  /** Providers' `.env.schema` fragments (zarg's own install). */
  readonly schemas?: ReadonlyArray<string>
}

/** Where env is read from, later winning: the providers' schemas, the user dir, the project (each only when it has a schema). */
const entries = (projectDir: string, opts: EnvOptions) => [
  ...new Set((opts.schemas ?? []).map((f) => dirname(f))),
  ...(opts.userDir !== undefined && existsSync(join(opts.userDir, ".env.schema")) ? [opts.userDir] : []),
  ...(existsSync(join(projectDir, ".env.schema")) || (opts.userDir === undefined && opts.schemas === undefined) ? [projectDir] : []),
]

const loadSnapshot = (projectDir: string, opts: EnvOptions = {}) =>
  Effect.tryPromise({
    try: async (): Promise<Snapshot> => {
      const paths = entries(projectDir, opts)
      if (paths.length === 0) return { values: new Map(), fields: new Map(), sensitive: [] }
      const graph = await internal.loadVarlockEnvGraph({ entryFilePaths: paths, skipCache: true })
      const schemaErrors = graph.sortedDataSources.flatMap((s) => s.errors.map((e) => e.message))
      if (schemaErrors.length > 0) throw new Error(schemaErrors.join("; "))
      await graph.resolveEnvValues()
      const values = new Map<string, string>()
      const fields = new Map<string, EnvField>()
      const sensitive: Array<SensitiveValue> = []
      for (const [name, item] of Object.entries(graph.configSchema)) {
        const raw = item.resolvedValue
        const value = raw === undefined || raw === null ? undefined : String(raw)
        if (value !== undefined) values.set(name, value)
        if (item.isSensitive && value !== undefined && value !== "") {
          sensitive.push({ name, value: Redacted.make(value) })
        }
        fields.set(name, {
          name,
          type: item.effectiveDataType?.name,
          description: item.description,
          sensitive: item.isSensitive,
          required: item.isRequired,
          errors: item.errors.map((e) => e.message),
        })
      }
      return { values, fields, sensitive }
    },
    catch: (e) => new EnvError({ message: `could not load env schema in ${projectDir}: ${message(e)}` }),
  })

export const layer = (projectDir: string, opts: EnvOptions = {}): Layer.Layer<Env, EnvError> =>
  Layer.effect(
    Env,
    Effect.gen(function* () {
      const ref = yield* Ref.make(yield* loadSnapshot(projectDir, opts))
      const wrap = (s: Snapshot, name: string, value: string) =>
        s.fields.get(name)?.sensitive === true ? Redacted.make(value) : value

      const lookup = (name: string) =>
        Effect.map(Ref.get(ref), (s) => {
          const v = s.values.get(name)
          return v === undefined ? undefined : wrap(s, name, v)
        })

      return {
        lookup,
        get: (name) =>
          Effect.flatMap(lookup(name), (v) =>
            v === undefined
              ? Effect.fail(new EnvError({ message: `${name} is not set`, variable: name }))
              : Effect.succeed(v),
          ),
        fields: (names) =>
          Effect.flatMap(Ref.get(ref), (s) =>
            Effect.forEach(names, (name) => {
              const f = s.fields.get(name)
              return f === undefined
                ? Effect.fail(new EnvError({ message: `${name} is not declared in any .env.schema`, variable: name }))
                : Effect.succeed(f)
            }),
          ),
        sensitive: Effect.map(Ref.get(ref), (s) => s.sensitive),
        reload: Effect.flatMap(loadSnapshot(projectDir, opts), (s) => Ref.set(ref, s)),
      }
    }),
  )

/** An in-memory Env for tests and for callers that already resolved their values. */
export const layerTest = (
  values: Readonly<Record<string, string>>,
  sensitiveNames: ReadonlyArray<string> = [],
): Layer.Layer<Env> => {
  const fields = new Map<string, EnvField>(
    Object.keys(values).map((name) => [
      name,
      { name, type: undefined, description: undefined, sensitive: sensitiveNames.includes(name), required: false, errors: [] },
    ]),
  )
  const snapshot: Snapshot = {
    values: new Map(Object.entries(values)),
    fields,
    sensitive: sensitiveNames.flatMap((name) =>
      values[name] === undefined ? [] : [{ name, value: Redacted.make(values[name]) }],
    ),
  }
  const wrap = (name: string, v: string) => (sensitiveNames.includes(name) ? Redacted.make(v) : v)
  const lookup = (name: string) =>
    Effect.succeed(snapshot.values.has(name) ? wrap(name, snapshot.values.get(name)!) : undefined)
  return Layer.succeed(Env, {
    lookup,
    get: (name) =>
      Effect.flatMap(lookup(name), (v) =>
        v === undefined ? Effect.fail(new EnvError({ message: `${name} is not set`, variable: name })) : Effect.succeed(v),
      ),
    fields: (names) =>
      Effect.forEach(names, (n) => {
        const f = fields.get(n)
        return f === undefined
          ? Effect.fail(new EnvError({ message: `${n} is not declared in any .env.schema`, variable: n }))
          : Effect.succeed(f)
      }),
    sensitive: Effect.succeed(snapshot.sensitive),
    reload: Effect.void,
  })
}
