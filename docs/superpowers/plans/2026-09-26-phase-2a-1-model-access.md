# Phase 2a-1: Model Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give zarg typed, leak-guarded access to its environment, config, secrets, models and decisions: `@zarg/model` (Env, Config, Secrets, Model, OpenRouter-wire client), the zarg-router and OpenRouter provider plugins, and `@zarg/decisions`.

**Architecture:** varlock resolves the environment from `.env.schema` files (provider packages ship fragments; secrets are device-encrypted). The config loader expands `${VAR}` against that environment, and anything built from a sensitive variable stays `Redacted`. Provider plugins turn their config table into a client for the OpenRouter-compatible wire; `Model` routes `provider:model` references to them. `Decisions` answers choice / yes-no / score questions natively through zarg-router's `/systemone` or through a structured-output fallback.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117`, varlock `1.20.0`, TypeScript 7, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` (sections Providers, Model, Decisions, Config, Environment and secrets, Errors, Testing; build steps 1-4). Plan 2a-2 covers the kernel, plugin services and RLM.

## Global Constraints

- Run bun only as `mise x -- bun ...`. A global bun in `~/.bun/bin` shadows the pinned 1.4.2 even inside `mise run` tasks; Task 1 makes every task immune to that.
- Effect is the `rc` tag (`effect@rc`, `@effect/platform-bun@rc`, resolved `4.0.0-rc.117`). Services use `Context.Service<Self, Shape>()("key")`; errors use `Data.TaggedError`.
- varlock is pinned to exactly `1.20.0`: the loader zarg uses (`internal.loadVarlockEnvGraph`) is not part of varlock's public API.
- Every package: `package.json` named `@zarg/<name>`, `"type": "module"`, `tsconfig.json` extending `../../tsconfig.base.json`, `mise.toml` with `typecheck` and `test` tasks.
- **Secrets:** never print, log or commit a secret value. Tests use variable names unique to the test (`ZARGTEST_*`, `ZTS_*`, `ZT_*`) so a developer's real environment can neither override them nor leak into output. A real `OPENROUTER_API_KEY` may be set in the shell; no test may depend on it or echo it.
- User-level files live in `~/.config/zarg/` (`config.toml`, `.env.local`). `~/.zarg/` belongs to zarg v1 and is never read.
- No test touches the network except fake servers on `localhost` started by the test.
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes against the versions above (120 tests in `mise run verify`). If an API differs, read `node_modules/.bun/effect@*/node_modules/effect/src/` or `packages/model/node_modules/varlock/dist/*.d.mts` before changing the approach.

### Deliberate differences from the spec

- `Env.fields` takes variable names, not a provider name. A provider plugin declares its `envKeys`; the login form (2b) asks `Env.fields(provider.envKeys)`. varlock does not expose which fragment an item came from.
- The per-role output-token cap and the "reasoning hit the cap, continue once with double" rule belong to the turn loop, so they move to plan 2a-2 (`@zarg/rlm`). `Model` stays a thin router.
- The `Decisions` fallback uses the `driver` role's model (configurable per `Decisions.layer({ fallbackRole })`).
- Tool support is read strictly from `supported_parameters`. zarg-router does not advertise `tools` yet; fixing the router is tracked outside this plan.

## Review Focus

1. A malformed `.env.schema` (for example an `@import` of a file not named `.env.*`) must fail with varlock's reason, not a generic message (Task 2).
2. A config value built from a sensitive variable (`"Bearer ${KEY}"`) must stay `Redacted`, including when stringified (Task 3).
3. A plain-text `api_key` in config (not from a sensitive variable) must be refused, naming the key (Task 7).
4. A multi-line value passed to `Secrets.setPlain` must be refused; it could inject extra variables into `.env.local` (Task 4).
5. A cold router model that only sends `: warming` comments must hit the first-output timeout, not hang (Task 5).

Known limit, not covered: `Secrets.set` depends on varlock's device key (a file-based TPM backend on Linux). On a machine where `varlock encrypt` cannot run, the `Secrets` round-trip test fails with a `SecretError` that says so.

---

### Task 1: Toolchain uses the pinned bun

**Files:**
- Modify: `packages/graph/mise.toml`, `packages/plugin/mise.toml`, `packages/plugin-gherkin/mise.toml`, `packages/cli/mise.toml`, `mise.toml`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: every package `mise.toml` in the form below; later tasks copy it.

- [ ] **Step 1: Show the problem**

Run: `mise x -- bun --version` then add a temporary root task and run it:

```bash
printf '\n[tasks.bunversion]\nrun = "bun --version"\n' >> mise.toml && mise run -q bunversion
```

Expected: the first prints `1.4.2`. The task prints whatever `bun` is first on `PATH` (on the author's machine `1.3.14`). If it also prints `1.4.2`, the machine does not have the problem; do the rest of the task anyway.

- [ ] **Step 2: Make every task call the pinned bun**

Remove the temporary `bunversion` task. In each package `mise.toml` (graph, plugin, plugin-gherkin, cli) use exactly:

```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

In the root `mise.toml`, change the `zarg` task's `run` line to:

```toml
run = "mise x -- bun packages/cli/src/main.ts"
```

In `packages/cli/test/cli.test.ts`, spawn the running bun instead of whatever `bun` is on `PATH`:

```ts
  const p = Bun.spawnSync([process.execPath, main, ...args], { cwd: root, env: { ...process.env, ZARG_ROOT: root } })
```

In `AGENTS.md`, replace the first Rules bullet with:

```markdown
- Run tools through mise (`mise x -- bun ...`). A globally installed bun can shadow the pinned one even inside `mise run`, so every task calls `mise x -- bun`, and tests spawn `process.execPath`, never a bare `bun`.
```

- [ ] **Step 3: Gate and commit**

Run: `mise run verify`
Expected: exit 0, 73 tests (graph 22, plugin 19, plugin-gherkin 19, cli 13), now on bun 1.4.2.

```bash
git add mise.toml packages/*/mise.toml packages/cli/test/cli.test.ts AGENTS.md
git commit -m "fix(toolchain): run the pinned bun in every task and test subprocess

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `@zarg/model` with Env (varlock) and the leak-guard helpers

**Files:**
- Create: `packages/model/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/model/src/{errors.ts,redact.ts,env.ts,index.ts}`
- Create: `packages/model/test/env.test.ts`

**Interfaces:**
- Produces:
  - `Env` service: `get(name): Effect<string | Redacted<string>, EnvError>`, `lookup(name): Effect<string | Redacted<string> | undefined>`, `fields(names): Effect<EnvField[], EnvError>`, `sensitive: Effect<SensitiveValue[]>`, `reload: Effect<void, EnvError>`
  - `layer(projectDir): Layer<Env, EnvError>`, `layerTest(values, sensitiveNames?): Layer<Env>`
  - `EnvField { name, type, description, sensitive, required, errors }`
  - `redact(text, sensitive): string`, `scrubEnv(env, sensitive): Record<string, string>`, `SensitiveValue { name, value: Redacted<string> }`
  - Errors: `EnvError{message, variable?}`, `ConfigError{message, key?, file?}`, `SecretError{message, name?}`

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/model/src packages/model/test
cp packages/graph/tsconfig.json packages/graph/mise.toml packages/model/
```

`packages/model/package.json`:

```json
{
  "name": "@zarg/model",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```bash
cd packages/model && mise x -- bun add effect@rc varlock@1.20.0 && mise x -- bun add -d @effect/platform-bun@rc && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/model/test/env.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { Env, layer, redact, scrubEnv } from "../src"

// Variable names are unique to these tests so a developer's real environment can never override them.
let dir = ""
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zarg-env-"))
  mkdirSync(join(dir, "providers"))
  writeFileSync(
    join(dir, ".env.schema"),
    "# @defaultSensitive=false\n# @import(./providers/)\n# ---\n",
  )
  writeFileSync(
    join(dir, "providers", ".env.schema"),
    [
      "# @defaultSensitive=false",
      "# ---",
      "# the test provider key",
      "# @required @sensitive @type=string(startsWith=zt-)",
      "ZARGTEST_KEY=",
      "# @type=url",
      "ZARGTEST_URL=http://default.test/api",
      "",
    ].join("\n"),
  )
  writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = <A, E>(eff: Effect.Effect<A, E, Env>) => Effect.runPromise(Effect.provide(eff, layer(dir)))

describe("Env (varlock)", () => {
  test("reads values through @import; sensitive values come back Redacted", async () => {
    const out = await run(
      Effect.gen(function* () {
        const env = yield* Env
        return { key: yield* env.get("ZARGTEST_KEY"), url: yield* env.get("ZARGTEST_URL") }
      }),
    )
    expect(Redacted.isRedacted(out.key)).toBe(true)
    expect(Redacted.value(out.key as Redacted.Redacted<string>)).toBe("zt-secret-value")
    expect(out.url).toBe("http://default.test/api")
  })

  test("fields describe the schema items for a login form", async () => {
    const fields = await run(Env.use((e) => e.fields(["ZARGTEST_KEY", "ZARGTEST_URL"])))
    expect(fields.map((f) => [f.name, f.sensitive, f.required, f.errors.length])).toEqual([
      ["ZARGTEST_KEY", true, true, 0],
      ["ZARGTEST_URL", false, true, 0], // varlock: an item with a default counts as required
    ])
    expect(fields[0]?.description).toBe("the test provider key")
  })

  test("an undeclared variable is an EnvError naming it", async () => {
    const err = await run(Effect.flip(Env.use((e) => e.fields(["ZARGTEST_NOPE"]))))
    expect(err.variable).toBe("ZARGTEST_NOPE")
  })

  test("a value that breaks its schema type is reported on the field", async () => {
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=wrong-prefix\n")
    const fields = await run(
      Effect.gen(function* () {
        const env = yield* Env
        yield* env.reload
        return yield* env.fields(["ZARGTEST_KEY"])
      }),
    )
    expect(fields[0]?.errors[0]).toContain("zt-")
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
  })

  test("reload picks up a changed file", async () => {
    const out = await run(
      Effect.gen(function* () {
        const env = yield* Env
        writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-rotated\n")
        yield* env.reload
        return yield* env.get("ZARGTEST_KEY")
      }),
    )
    expect(Redacted.value(out as Redacted.Redacted<string>)).toBe("zt-rotated")
    writeFileSync(join(dir, ".env.local"), "ZARGTEST_KEY=zt-secret-value\n")
  })
})

describe("leak guard helpers", () => {
  const sensitive = [
    { name: "A_KEY", value: Redacted.make("sk-short") },
    { name: "B_KEY", value: Redacted.make("sk-short-and-longer") },
  ]
  test("redact replaces every occurrence, longest value first", () => {
    expect(redact("x sk-short-and-longer y sk-short z", sensitive)).toBe("x <redacted:B_KEY> y <redacted:A_KEY> z")
  })
  test("scrubEnv drops sensitive variables and keeps the rest", () => {
    expect(scrubEnv({ A_KEY: "sk-short", PATH: "/bin", B_KEY: undefined }, sensitive)).toEqual({ PATH: "/bin" })
  })
})

describe("Env schema errors", () => {
  test("a broken schema fails with varlock's reason, not a generic message", async () => {
    const bad = mkdtempSync(join(tmpdir(), "zarg-env-bad-"))
    writeFileSync(join(bad, "not-dotenv.schema"), "X=1\n")
    writeFileSync(join(bad, ".env.schema"), "# @import(./not-dotenv.schema)\n# ---\n")
    const err = await Effect.runPromise(Effect.flip(Effect.provide(Env.use((e) => e.lookup("X")), layer(bad))))
    expect(err.message).toContain("imported file must be a .env.* file")
    rmSync(bad, { recursive: true, force: true })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/model && mise x -- bun test`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 4: Implement**

`packages/model/src/errors.ts`:

```ts
import { Data } from "effect"

export class EnvError extends Data.TaggedError("EnvError")<{
  readonly message: string
  readonly variable?: string
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly key?: string
  readonly file?: string
}> {}

export class SecretError extends Data.TaggedError("SecretError")<{
  readonly message: string
  readonly name?: string
}> {}
```

`packages/model/src/redact.ts`:

```ts
import { Redacted } from "effect"

export interface SensitiveValue {
  readonly name: string
  readonly value: Redacted.Redacted<string>
}

/** Replace every sensitive value found in `text` with `<redacted:NAME>`. Longest values first. */
export const redact = (text: string, sensitive: ReadonlyArray<SensitiveValue>): string => {
  let out = text
  const byLength = [...sensitive].sort((a, b) => Redacted.value(b.value).length - Redacted.value(a.value).length)
  for (const s of byLength) {
    const raw = Redacted.value(s.value)
    if (raw.length > 0) out = out.split(raw).join(`<redacted:${s.name}>`)
  }
  return out
}

/** A copy of `env` without any variable whose name is sensitive. */
export const scrubEnv = (
  env: Readonly<Record<string, string | undefined>>,
  sensitive: ReadonlyArray<SensitiveValue>,
): Record<string, string> => {
  const names = new Set(sensitive.map((s) => s.name))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !names.has(k)) out[k] = v
  return out
}
```

`packages/model/src/env.ts`:

```ts
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
const loadSnapshot = (projectDir: string) =>
  Effect.tryPromise({
    try: async (): Promise<Snapshot> => {
      const graph = await internal.loadVarlockEnvGraph({ entryFilePaths: [projectDir], skipCache: true })
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

export const layer = (projectDir: string): Layer.Layer<Env, EnvError> =>
  Layer.effect(
    Env,
    Effect.gen(function* () {
      const ref = yield* Ref.make(yield* loadSnapshot(projectDir))
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
        reload: Effect.flatMap(loadSnapshot(projectDir), (s) => Ref.set(ref, s)),
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
```

`packages/model/src/index.ts` (later tasks add exports):

```ts
export * from "./env"
export * from "./errors"
export * from "./redact"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/model && mise x -- bun test`
Expected: PASS, 8 tests.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/model bun.lock
git commit -m "feat(model): Env over varlock with redaction and env scrubbing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Config loader

**Files:**
- Create: `packages/model/src/config.ts`, `packages/model/test/config.test.ts`
- Modify: `packages/model/src/index.ts`

**Interfaces:**
- Consumes: Task 2 `Env`, `layerTest`, `ConfigError`.
- Produces (namespace `Config` from `@zarg/model`):
  - `Config.Config` service holding `ZargConfig { providers: Record<name, Record<key, ConfigValue>>, roles: Record<role, "provider:model">, extra: Record<section, unknown> }`
  - `Config.load({ userDir, projectDir }): Effect<ZargConfig, ConfigError, FileSystem | Path | Env>`, `Config.layer(opts)`
  - `Config.expand(text, key, env)`, `Config.roleModel(config, role): Effect<string, ConfigError>`
  - `ConfigValue = string | Redacted<string>`
- Known sections: `providers`, `roles`, `rlm` (kept in `extra` for plan 2a-2). Any other section is an error.

- [ ] **Step 1: Write the failing tests**

`packages/model/test/config.test.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Config, layerTest } from "../src"

const setup = (user: string | undefined, project: string | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "zarg-config-"))
  const userDir = join(root, "home")
  const projectDir = join(root, "repo")
  mkdirSync(userDir)
  mkdirSync(join(projectDir, ".zarg"), { recursive: true })
  if (user !== undefined) writeFileSync(join(userDir, "config.toml"), user)
  if (project !== undefined) writeFileSync(join(projectDir, ".zarg", "config.toml"), project)
  return { userDir, projectDir }
}

const envLayer = layerTest({ ZT_URL: "http://router.test/api/v1", ZT_KEY: "zt-secret" }, ["ZT_KEY"])

const load = (user: string | undefined, project: string | undefined) =>
  Effect.runPromise(
    Config.load(setup(user, project)).pipe(Effect.provide(Layer.merge(envLayer, BunServices.layer))),
  )
const fail = (user: string | undefined, project: string | undefined) =>
  Effect.runPromise(
    Effect.flip(Config.load(setup(user, project))).pipe(Effect.provide(Layer.merge(envLayer, BunServices.layer))),
  )

describe("config loader", () => {
  test("no files gives an empty config", async () => {
    expect(await load(undefined, undefined)).toEqual({ providers: {}, roles: {}, extra: {} })
  })

  test("expands ${VAR} and ${VAR:-default}; $${ stays literal", async () => {
    const c = await load(
      '[providers.r]\nbase_url = "${ZT_URL}"\nfallback = "${ZT_MISSING:-http://d.test}"\nliteral = "$${NOT_A_VAR}"\n',
      undefined,
    )
    expect(c.providers.r).toEqual({ base_url: "http://router.test/api/v1", fallback: "http://d.test", literal: "${NOT_A_VAR}" })
  })

  test("a value built from a sensitive variable is Redacted", async () => {
    const c = await load(undefined, '[providers.o]\napi_key = "Bearer ${ZT_KEY}"\n')
    const key = c.providers.o?.api_key
    expect(Redacted.isRedacted(key)).toBe(true)
    expect(Redacted.value(key as Redacted.Redacted<string>)).toBe("Bearer zt-secret")
    expect(String(key)).not.toContain("zt-secret")
  })

  test("project config overrides user config table by table", async () => {
    const c = await load(
      '[roles]\ndriver = "r:small"\nsync = "r:big"\n',
      '[roles]\ndriver = "r:local"\n',
    )
    expect(c.roles).toEqual({ driver: "r:local", sync: "r:big" })
  })

  test("a missing variable without a default names the variable and the key", async () => {
    const e = await fail(undefined, '[providers.o]\napi_key = "${ZT_NOPE}"\n')
    expect(e.message).toBe("providers.o.api_key: ${ZT_NOPE} is not set")
    expect(e.key).toBe("providers.o.api_key")
  })

  test("unknown sections and malformed roles are errors", async () => {
    expect((await fail(undefined, "[nonsense]\na = 1\n")).message).toBe('unknown config section "nonsense"')
    expect((await fail(undefined, '[roles]\ndriver = "no-colon"\n')).key).toBe("roles.driver")
  })

  test("invalid TOML names the file", async () => {
    const e = await fail(undefined, "[roles\n")
    expect(e.file).toContain(".zarg/config.toml")
  })

  test("roleModel explains which key to set", async () => {
    const e = await Effect.runPromise(Effect.flip(Config.roleModel({ providers: {}, roles: {}, extra: {} }, "driver")))
    expect(e.message).toBe('no model for role "driver"; set roles.driver in .zarg/config.toml')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/model && mise x -- bun test test/config.test.ts`
Expected: FAIL, `Config` is not exported.

- [ ] **Step 3: Implement**

`packages/model/src/config.ts`:

```ts
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
```

`packages/model/src/index.ts`:

```ts
export * as Config from "./config"
export * from "./env"
export * from "./errors"
export * from "./redact"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/model && mise x -- bun test`
Expected: PASS, 16 tests. (The "invalid TOML names the file" test fails on bun 1.3.14, which parses `[roles` leniently. That is the canary for Task 1.)

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/model
git commit -m "feat(model): config loader with \${VAR} expansion and redacted secrets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Secrets with device-bound encryption

**Files:**
- Create: `packages/model/src/secrets.ts`, `packages/model/test/secrets.test.ts`
- Modify: `packages/model/src/index.ts`

**Interfaces:**
- Consumes: Task 2 `Env` (`reload`), `SecretError`.
- Produces (namespace `Secrets`):
  - `Secrets.Secrets` service: `set(name, value: Redacted<string>)`, `setPlain(name, value: string)`, `has(name)`, `remove(name)`, all `Effect<_, SecretError>`
  - `Secrets.layer(userDir): Layer<Secrets, never, Env | FileSystem | Path>`
- Behavior: `set` pipes the value to `varlock encrypt` on stdin and stores `NAME=varlock("local:...")` in `<userDir>/.env.local` (mode 600, atomic rename), then reloads `Env`. The plaintext never touches disk or argv.

- [ ] **Step 1: Write the failing tests**

`packages/model/test/secrets.test.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Env, layer as envLayer, Secrets } from "../src"

// A project whose schema imports a fake user dir. Unique variable names keep the real environment out.
let root = ""
let userDir = ""
let projectDir = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zarg-secrets-"))
  userDir = join(root, "home", ".zarg")
  projectDir = join(root, "repo")
  mkdirSync(userDir, { recursive: true })
  mkdirSync(join(projectDir, "providers"), { recursive: true })
  writeFileSync(
    join(projectDir, ".env.schema"),
    `# @defaultSensitive=false\n# @import(./providers/)\n# @import(${userDir}/, allowMissing=true)\n# ---\n`,
  )
  writeFileSync(
    join(projectDir, "providers", ".env.schema"),
    "# @defaultSensitive=false\n# ---\n# @sensitive\nZTS_KEY=\nZTS_URL=\n",
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = <A, E>(eff: Effect.Effect<A, E, Env | Secrets.Secrets>) => {
  const base = Layer.merge(envLayer(projectDir), BunServices.layer)
  return Effect.runPromise(Effect.provide(eff, Layer.provideMerge(Secrets.layer(userDir), base)))
}

describe("Secrets", () => {
  test("set encrypts on this device; the file never holds the plaintext; Env reads it back", async () => {
    const value = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        yield* secrets.set("ZTS_KEY", Redacted.make("zts-plaintext-value"))
        return yield* (yield* Env).get("ZTS_KEY")
      }),
    )
    const file = readFileSync(join(userDir, ".env.local"), "utf8")
    expect(file).toMatch(/^ZTS_KEY=varlock\("local:[^"]+"\)\n$/)
    expect(file).not.toContain("zts-plaintext-value")
    expect(Redacted.value(value as Redacted.Redacted<string>)).toBe("zts-plaintext-value")
  }, 20_000)

  test("setPlain stores a plain value and replaces an earlier one", async () => {
    const url = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        yield* secrets.setPlain("ZTS_URL", "http://a.test")
        yield* secrets.setPlain("ZTS_URL", "http://b.test")
        return yield* (yield* Env).get("ZTS_URL")
      }),
    )
    expect(url).toBe("http://b.test")
    expect(readFileSync(join(userDir, ".env.local"), "utf8").match(/ZTS_URL=/g)?.length).toBe(1)
  })

  test("remove deletes the line; has reflects it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        const before = yield* secrets.has("ZTS_URL")
        yield* secrets.remove("ZTS_URL")
        return { before, after: yield* secrets.has("ZTS_URL"), value: yield* (yield* Env).lookup("ZTS_URL") }
      }),
    )
    expect(out).toEqual({ before: true, after: false, value: undefined })
  })

  test("invalid names and multi-line plain values are refused", async () => {
    const errs = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets.Secrets
        const a = yield* Effect.flip(secrets.setPlain("BAD NAME", "x"))
        const b = yield* Effect.flip(secrets.setPlain("ZTS_URL", "a\nEVIL=1"))
        return [a.message, b.message]
      }),
    )
    expect(errs).toEqual(['invalid variable name "BAD NAME"', "ZTS_URL: value must be one line"])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/model && mise x -- bun test test/secrets.test.ts`
Expected: FAIL, `Secrets` is not exported.

- [ ] **Step 3: Implement**

`packages/model/src/secrets.ts`:

```ts
import { dirname, join } from "node:path"
import { Context, Effect, FileSystem, Layer, Path, Redacted } from "effect"
import { Env } from "./env"
import { SecretError } from "./errors"

export class Secrets extends Context.Service<
  Secrets,
  {
    /** Encrypt with varlock's device-bound encryption and store as `NAME=varlock("local:...")`. */
    readonly set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void, SecretError>
    /** Store a non-sensitive value as plain text (e.g. a base URL entered at login). */
    readonly setPlain: (name: string, value: string) => Effect.Effect<void, SecretError>
    readonly has: (name: string) => Effect.Effect<boolean, SecretError>
    readonly remove: (name: string) => Effect.Effect<void, SecretError>
  }
>()("@zarg/model/Secrets") {}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const varlockCli = join(dirname(Bun.resolveSync("varlock/package.json", import.meta.dir)), "bin", "cli.js")

/** `echo value | varlock encrypt` → `varlock("local:...")`. The value only travels over stdin. */
const encrypt = (name: string, value: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([process.execPath, varlockCli, "encrypt"], {
        stdin: new TextEncoder().encode(Redacted.value(value)),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      const ref = /varlock\("local:[^"]+"\)/.exec(out)?.[0]
      if (code !== 0 || ref === undefined) throw new Error(`varlock encrypt exited with ${code}`)
      return ref
    },
    catch: (e) => new SecretError({ message: `could not encrypt ${name}: ${e instanceof Error ? e.message : String(e)}`, name }),
  })

/** Secrets live in `<userDir>/.env.local`, one `NAME=...` line each. */
export const layer = (userDir: string): Layer.Layer<Secrets, never, Env | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const env = yield* Env
      const file = path.join(userDir, ".env.local")
      const io = (e: { message: string }) => new SecretError({ message: `${file}: ${e.message}` })

      const readLines = Effect.gen(function* () {
        const exists = yield* fs.exists(file).pipe(Effect.mapError(io))
        if (!exists) return [] as Array<string>
        return (yield* fs.readFileString(file).pipe(Effect.mapError(io))).split("\n").filter((l) => l.length > 0)
      })
      const writeLines = (lines: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(userDir, { recursive: true }).pipe(Effect.mapError(io))
          const tmp = `${file}.${process.pid}.tmp`
          yield* fs.writeFileString(tmp, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 }).pipe(Effect.mapError(io))
          yield* fs.rename(tmp, file).pipe(Effect.mapError(io))
        })
      const checkName = (name: string) =>
        NAME.test(name) ? Effect.void : Effect.fail(new SecretError({ message: `invalid variable name "${name}"`, name }))
      const upsert = (name: string, rhs: string) =>
        Effect.gen(function* () {
          const lines = (yield* readLines).filter((l) => !l.startsWith(`${name}=`))
          yield* writeLines([...lines, `${name}=${rhs}`])
          yield* env.reload.pipe(Effect.mapError((e) => new SecretError({ message: e.message, name })))
        })

      return {
        set: (name, value) =>
          Effect.flatMap(checkName(name), () => Effect.flatMap(encrypt(name, value), (ref) => upsert(name, ref))),
        setPlain: (name, value) =>
          Effect.flatMap(checkName(name), () =>
            /[\n\r]/.test(value)
              ? Effect.fail(new SecretError({ message: `${name}: value must be one line`, name }))
              : upsert(name, value),
          ),
        has: (name) => Effect.map(readLines, (lines) => lines.some((l) => l.startsWith(`${name}=`))),
        remove: (name) =>
          Effect.gen(function* () {
            const lines = yield* readLines
            yield* writeLines(lines.filter((l) => !l.startsWith(`${name}=`)))
            yield* env.reload.pipe(Effect.mapError((e) => new SecretError({ message: e.message, name })))
          }),
      }
    }),
  )
```

`packages/model/src/index.ts`:

```ts
export * as Config from "./config"
export * from "./env"
export * from "./errors"
export * from "./redact"
export * as Secrets from "./secrets"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/model && mise x -- bun test`
Expected: PASS, 20 tests. The first `Secrets` test runs real device encryption and can take a few seconds.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/model
git commit -m "feat(model): Secrets stored with varlock device-bound encryption

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: OpenRouter-wire client (ported from zarg v1)

**Files:**
- Create: `packages/model/src/wire/{types.ts,serialize.ts,sse.ts,client.ts,index.ts}`
- Create: `packages/model/test/{fake-server.ts,wire.test.ts}`
- Modify: `packages/model/src/index.ts`

**Interfaces:**
- Produces:
  - Types: `ChatMessage`, `ToolCall`, `ToolDef`, `Usage`, `StreamEvent` (`text | reasoning | toolCall | usage | done{finishReason?}`), `WireRequest`, `ModelInfo { id, contextLength, maxOutputTokens, supportsTools, reasoningEfforts, capabilities, state }`
  - `ModelError { kind: "transport" | "status" | "timeout" | "first-output" | "stream" | "limits" | "config", message, status? }`
  - `buildRequestBody(req): string`, `mapUsage(u): Usage`, `parseSse(response, timeouts)`, `parseModelRow(row): ModelInfo`
  - `openRouterWire(opts: WireOptions): WireClient` where `WireClient = { stream(req), models, verify }` and `WireOptions = { baseUrl, apiKey?, headers?, timeouts?: { idleMs, firstOutputMs }, retries?, backoffMs?, fetch? }`
- Test helper: `fakeServer(handler)`, `sse(parts)`, `delta(d, finish?)` in `test/fake-server.ts`, used again in Task 6.

- [ ] **Step 1: Write the failing tests**

`packages/model/test/fake-server.ts`:

```ts
/** A throwaway HTTP server for provider tests. Each handler gets the request and its body. */
export const fakeServer = (handler: (req: Request, body: string) => Response | Promise<Response>) => {
  const requests: Array<{ path: string; body: string; auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      requests.push({ path: new URL(req.url).pathname, body, auth: req.headers.get("authorization") })
      return handler(req, body)
    },
  })
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) }
}

/** An SSE response from `data:` frames and raw text (comments), with optional pauses in ms. */
export const sse = (parts: ReadonlyArray<object | string | number>) =>
  new Response(
    new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        for (const p of parts) {
          if (typeof p === "number") await Bun.sleep(p)
          else if (typeof p === "string") c.enqueue(enc.encode(p))
          else c.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n\n`))
        }
        c.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

export const delta = (d: object, finish?: string) => ({ choices: [{ delta: d, finish_reason: finish ?? null }] })
```

`packages/model/test/wire.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Redacted, Stream } from "effect"
import { buildRequestBody, openRouterWire, type StreamEvent } from "../src"
import { delta, fakeServer, sse } from "./fake-server"

let stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const serve = (h: Parameters<typeof fakeServer>[0]) => {
  const s = fakeServer(h)
  stops.push(s.stop)
  return s
}
const collect = (s: Stream.Stream<StreamEvent, unknown>) => Effect.runPromise(Stream.runCollect(s))
const collectErr = (s: Stream.Stream<StreamEvent, any>) => Effect.runPromise(Effect.flip(Stream.runCollect(s)))
const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] }

describe("openRouterWire.stream", () => {
  test("text, reasoning, usage and finish reason", async () => {
    const s = serve(() =>
      sse([
        delta({ reasoning_content: "think" }),
        delta({ content: "Hel" }),
        delta({ content: "lo" }, "stop"),
        { usage: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 1 } },
        "data: [DONE]\n\n",
      ]),
    )
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events).toEqual([
      { type: "reasoning", delta: "think" },
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 2, reasoningTokens: 1, cacheHitTokens: 0, cacheMissTokens: 5 } },
      { type: "done", finishReason: "stop" },
    ])
  })

  test("tool calls are assembled across chunks and emitted before done", async () => {
    const s = serve(() =>
      sse([
        delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "exec", arguments: '{"co' } }] }),
        delta({ tool_calls: [{ index: 1, id: "c2", function: { name: "exec", arguments: "{}" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'de":"1"}' } }] }, "tool_calls"),
      ]),
    )
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events).toEqual([
      { type: "toolCall", call: { id: "c1", type: "function", function: { name: "exec", arguments: '{"code":"1"}' } } },
      { type: "toolCall", call: { id: "c2", type: "function", function: { name: "exec", arguments: "{}" } } },
      { type: "done", finishReason: "tool_calls" },
    ])
  })

  test("a stream without finish_reason ends with done and no reason", async () => {
    const s = serve(() => sse([delta({ content: "x" })]))
    const events = await collect(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(events.at(-1)).toEqual({ type: "done" })
  })

  test("an in-band error frame fails the stream", async () => {
    const s = serve(() => sse([delta({ content: "par" }), { error: { message: "engine dropped the socket", code: 502 } }]))
    const err = await collectErr(openRouterWire({ baseUrl: s.url }).stream(req))
    expect(err).toMatchObject({ _tag: "ModelError", kind: "stream", message: "engine dropped the socket", status: 502 })
  })

  test("warming comments keep the connection alive but do not count as output", async () => {
    const ok = serve(() => sse([": warming m\n\n", 30, ": warming m\n\n", 30, delta({ content: "ready" })]))
    const events = await collect(openRouterWire({ baseUrl: ok.url, timeouts: { idleMs: 50, firstOutputMs: 500 } }).stream(req))
    expect(events[0]).toEqual({ type: "text", delta: "ready" })

    const cold = serve(() => sse([": warming m\n\n", 30, ": warming m\n\n", 30, ": warming m\n\n", 30, delta({ content: "late" })]))
    const err = await collectErr(openRouterWire({ baseUrl: cold.url, timeouts: { idleMs: 50, firstOutputMs: 70 } }).stream(req))
    expect(err).toMatchObject({ kind: "first-output" })
  })

  test("silence after output is an idle timeout", async () => {
    const s = serve(() => sse([delta({ content: "a" }), 200, delta({ content: "b" })]))
    const err = await collectErr(openRouterWire({ baseUrl: s.url, timeouts: { idleMs: 50, firstOutputMs: 1000 } }).stream(req))
    expect(err).toMatchObject({ kind: "timeout" })
  })

  test("429 honours Retry-After and succeeds; persistent 500 fails after the retries", async () => {
    let n = 0
    const flaky = serve(() => (++n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : sse([delta({ content: "ok" })])))
    const events = await collect(openRouterWire({ baseUrl: flaky.url }).stream(req))
    expect(events[0]).toEqual({ type: "text", delta: "ok" })
    expect(flaky.requests.length).toBe(3)

    const down = serve(() => new Response("boom", { status: 500 }))
    const err = await collectErr(openRouterWire({ baseUrl: down.url, retries: 2, backoffMs: 1 }).stream(req))
    expect(err).toMatchObject({ kind: "status", status: 500 })
    expect(down.requests.length).toBe(3)
  })

  test("401 is not retried; the key is sent as a bearer token", async () => {
    const s = serve(() => new Response("bad key", { status: 401 }))
    const err = await collectErr(openRouterWire({ baseUrl: s.url, apiKey: Redacted.make("sk-test") }).stream(req))
    expect(err).toMatchObject({ kind: "status", status: 401 })
    expect(s.requests.length).toBe(1)
    expect(s.requests[0]?.auth).toBe("Bearer sk-test")
  })
})

describe("openRouterWire.models", () => {
  test("parses limits, tool support and zarg-router capabilities from /models rows", async () => {
    const s = serve(() =>
      Response.json({
        data: [
          { id: "coder", context_length: 131072, top_provider: { context_length: 131072, max_completion_tokens: 32768 }, supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["low", "high"] }, state: "cold" },
          { id: "jevk5", context_length: 8192, top_provider: { context_length: 8192, max_completion_tokens: 1 }, supported_parameters: [], x_zarg_capabilities: ["decision"] },
        ],
      }),
    )
    const models = await Effect.runPromise(openRouterWire({ baseUrl: s.url }).models)
    expect(models).toEqual([
      { id: "coder", contextLength: 131072, maxOutputTokens: 32768, supportsTools: true, reasoningEfforts: ["low", "high"], capabilities: [], state: "cold" },
      { id: "jevk5", contextLength: 8192, maxOutputTokens: 1, supportsTools: false, reasoningEfforts: [], capabilities: ["decision"], state: undefined },
    ])
  })
})

describe("buildRequestBody", () => {
  test("OpenRouter dialect: tools, reasoning, streaming usage, fixed key order", () => {
    const body = JSON.parse(
      buildRequestBody({
        model: "m",
        messages: [{ role: "assistant", content: null }],
        tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
        maxTokens: 10,
        reasoning: { effort: "low" },
      }),
    )
    expect(Object.keys(body)).toEqual(["model", "messages", "tools", "max_tokens", "stream", "stream_options", "reasoning"])
    expect(body.messages[0]).toEqual({ role: "assistant", content: "" })
    expect(body.reasoning).toEqual({ effort: "low" })
  })

  test("a tool message needs a name; structured output refuses tools", () => {
    expect(() => buildRequestBody({ model: "m", messages: [{ role: "tool", content: "x", toolCallId: "c1" }] })).toThrow("missing name")
    expect(() =>
      buildRequestBody({ model: "m", messages: [], outputSchema: { type: "object" }, tools: [{ name: "t", description: "", parameters: {} }] }),
    ).toThrow("no tools")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/model && mise x -- bun test test/wire.test.ts`
Expected: FAIL, `openRouterWire` is not exported.

- [ ] **Step 3: Implement**

`packages/model/src/wire/types.ts`:

```ts
import { Data } from "effect"

export interface ToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export interface ToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments. */
  readonly parameters: unknown
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string | null
  readonly reasoningContent?: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
  readonly toolCallId?: string
  readonly name?: string
}

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number
  readonly cacheHitTokens: number
  readonly cacheMissTokens: number
  /** Provider-reported cost in USD (OpenRouter's usage.cost), when present. */
  readonly costUsd?: number
  /** False when the provider omitted or garbled the token counters. */
  readonly tokenCountsComplete?: boolean
}

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "toolCall"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: Usage }
  /** `finishReason` is absent when the provider did not say; it is never defaulted. */
  | { readonly type: "done"; readonly finishReason?: string }

export interface WireRequest {
  readonly model: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<ToolDef>
  readonly maxTokens?: number
  readonly temperature?: number
  /** OpenRouter's unified reasoning field; the router translates it per backend. */
  readonly reasoning?: { readonly effort?: string; readonly enabled?: boolean }
  /** Strict JSON-schema response (no tools allowed). */
  readonly outputSchema?: Record<string, unknown>
}

/** What a provider's /models row tells us about a model. Never guessed. */
export interface ModelInfo {
  readonly id: string
  readonly contextLength: number
  readonly maxOutputTokens: number | undefined
  readonly supportsTools: boolean
  readonly reasoningEfforts: ReadonlyArray<string>
  /** zarg-router extensions, e.g. "decision". */
  readonly capabilities: ReadonlyArray<string>
  /** zarg-router warm state ("cold", "warm", ...), when reported. */
  readonly state: string | undefined
}

export type ModelErrorKind = "transport" | "status" | "timeout" | "first-output" | "stream" | "limits" | "config"

export class ModelError extends Data.TaggedError("ModelError")<{
  readonly kind: ModelErrorKind
  readonly message: string
  readonly status?: number
}> {}
```

`packages/model/src/wire/serialize.ts`:

```ts
import type { ChatMessage, WireRequest } from "./types"

// Fixed key insertion order: identical requests serialize to identical bytes (prompt caches key on bytes).
const wireMessage = (m: ChatMessage): Record<string, unknown> => {
  const w: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.reasoningContent !== undefined) w.reasoning_content = m.reasoningContent
  if (m.toolCalls) {
    w.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: c.type,
      function: { name: c.function.name, arguments: c.function.arguments },
    }))
  }
  if (m.toolCallId !== undefined) w.tool_call_id = m.toolCallId
  if (m.role === "tool") {
    if (m.name === undefined) throw new Error("tool message missing name (required by strict backends)")
    w.name = m.name
  } else if (m.name !== undefined) w.name = m.name
  // Strict OpenAI-compatible servers reject a null content that is not a tool-call turn.
  if (m.content === null && !m.toolCalls) w.content = ""
  return w
}

/** OpenRouter-dialect chat-completions body. Always streams and asks for usage. */
export const buildRequestBody = (p: WireRequest): string => {
  if (!p.model) throw new Error("WireRequest.model must be set")
  const body: Record<string, unknown> = { model: p.model, messages: p.messages.map(wireMessage) }
  if (p.outputSchema) {
    if (p.tools?.length || p.outputSchema.type !== "object") {
      throw new Error("structured output requires an object schema and no tools")
    }
    body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: p.outputSchema } }
  }
  if (p.tools) {
    body.tools = p.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens
  if (p.temperature !== undefined) body.temperature = p.temperature
  body.stream = true
  body.stream_options = { include_usage: true }
  if (p.reasoning !== undefined) body.reasoning = { ...p.reasoning }
  return JSON.stringify(body)
}
```

`packages/model/src/wire/sse.ts`:

```ts
import { Effect, Stream } from "effect"
import { ModelError, type StreamEvent, type ToolCall, type Usage } from "./types"

export interface SseTimeouts {
  /** Longest silence between chunks. */
  readonly idleMs: number
  /** Longest wait for the first text, reasoning or tool call. Keep-alive comments do not count. */
  readonly firstOutputMs: number
}

// Two shapes in the wild: OpenAI/OpenRouter nest reasoning_tokens under completion_tokens_details,
// SGLang reports it flat on usage. Ported from zarg v1.
export const mapUsage = (u: any): Usage => ({
  ...([u.prompt_tokens, u.completion_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)
    ? {}
    : { tokenCountsComplete: false }),
  promptTokens: u.prompt_tokens ?? 0,
  completionTokens: u.completion_tokens ?? 0,
  reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
  cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  cacheMissTokens:
    u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0)),
  ...(u.cost !== undefined ? { costUsd: u.cost } : {}),
})

interface State {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly decoder: TextDecoder
  readonly deadline: number
  buf: string
  readonly toolCalls: Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>
  finishReason: string | undefined
  sawOutput: boolean
  done: boolean
  events: Array<StreamEvent>
}

const read = (s: State, t: SseTimeouts) => {
  const ms = s.sawOutput ? t.idleMs : Math.max(0, Math.min(t.idleMs, s.deadline - Date.now()))
  const kind = s.sawOutput || s.deadline - Date.now() > t.idleMs ? "timeout" : "first-output"
  return Effect.tryPromise({
    try: () => s.reader.read(),
    catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: ms,
      orElse: () =>
        Effect.fail(
          new ModelError({
            kind,
            message: kind === "first-output" ? `no output within ${t.firstOutputMs}ms` : `stream idle for ${t.idleMs}ms`,
          }),
        ),
    }),
    Effect.tapError(() => Effect.sync(() => void s.reader.cancel().catch(() => {}))),
  )
}

/** Parse an OpenAI-style SSE body into StreamEvents. Tool calls are emitted, assembled, before `done`. */
export const parseSse = (response: Response, t: SseTimeouts): Stream.Stream<StreamEvent, ModelError> => {
  const state: State = {
    reader: response.body!.getReader(),
    decoder: new TextDecoder(),
    deadline: Date.now() + t.firstOutputMs,
    buf: "",
    toolCalls: new Map(),
    finishReason: undefined,
    sawOutput: false,
    done: false,
    events: [],
  }

  const step = (s: State): Effect.Effect<readonly [StreamEvent, State] | undefined, ModelError> =>
    Effect.gen(function* () {
      while (true) {
        const head = s.events.shift()
        if (head !== undefined) return [head, s] as const
        if (s.done) return undefined
        const chunk = yield* read(s, t)
        if (chunk.done) {
          for (const call of s.toolCalls.values()) s.events.push({ type: "toolCall", call: call as ToolCall })
          s.events.push({ type: "done", ...(s.finishReason !== undefined ? { finishReason: s.finishReason } : {}) })
          s.done = true
          continue
        }
        s.buf += s.decoder.decode(chunk.value, { stream: true })
        let idx: number
        while ((idx = s.buf.indexOf("\n\n")) !== -1) {
          const frame = s.buf.slice(0, idx)
          s.buf = s.buf.slice(idx + 2)
          // Lines starting with ":" are comments (zarg-router sends ": warming <model>").
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("")
          if (!data || data === "[DONE]") continue
          let j: any
          try {
            j = JSON.parse(data)
          } catch (e) {
            return yield* new ModelError({ kind: "stream", message: `bad SSE JSON: ${e instanceof Error ? e.message : String(e)}` })
          }
          // An in-band error frame is a failed stream, never an empty turn.
          if (j.error !== undefined && j.error !== null) {
            const message = typeof j.error === "string" ? j.error : (j.error.message ?? JSON.stringify(j.error))
            return yield* new ModelError({ kind: "stream", message, status: typeof j.error?.code === "number" ? j.error.code : 0 })
          }
          if (j.usage) s.events.push({ type: "usage", usage: mapUsage(j.usage) })
          // Read before the delta guard: some backends send finish_reason on a chunk without a delta.
          const fr = j.choices?.[0]?.finish_reason
          if (fr) s.finishReason = fr
          const delta = j.choices?.[0]?.delta
          if (!delta) continue
          const r = delta.reasoning_content ?? delta.reasoning
          if (r) {
            s.sawOutput = true
            s.events.push({ type: "reasoning", delta: r })
          }
          if (delta.content) {
            s.sawOutput = true
            s.events.push({ type: "text", delta: delta.content })
          }
          for (const tc of delta.tool_calls ?? []) {
            s.sawOutput = true
            const cur = s.toolCalls.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.function.name = tc.function.name
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
            s.toolCalls.set(tc.index, cur)
          }
        }
      }
    })

  return Stream.unfold(state, step)
}
```

`packages/model/src/wire/client.ts`:

```ts
import { Effect, Redacted, Stream } from "effect"
import { buildRequestBody } from "./serialize"
import { parseSse, type SseTimeouts } from "./sse"
import { type ModelInfo, ModelError, type StreamEvent, type WireRequest } from "./types"

/** A provider's connection, as provider plugins build it. */
export interface WireClient {
  readonly stream: (req: WireRequest) => Stream.Stream<StreamEvent, ModelError>
  readonly models: Effect.Effect<ReadonlyArray<ModelInfo>, ModelError>
  /** A cheap authenticated call (GET /models) that fails on bad credentials. */
  readonly verify: Effect.Effect<void, ModelError>
}

export interface WireOptions {
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly timeouts?: Partial<SseTimeouts>
  /** Attempts after the first, for network errors, 429 and 5xx. */
  readonly retries?: number
  /** Base of the jittered exponential backoff when no Retry-After is sent. */
  readonly backoffMs?: number
  readonly fetch?: typeof fetch
}

const DEFAULT_TIMEOUTS: SseTimeouts = { idleMs: 300_000, firstOutputMs: 600_000 }

// Retry-After is delay-seconds or an HTTP date; otherwise full-jitter exponential backoff.
const retryDelay = (res: Response | undefined, attempt: number, backoffMs: number) => {
  const ra = res?.headers.get("retry-after")
  if (ra) {
    const secs = Number(ra)
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(ra)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  return Math.random() * backoffMs * 2 ** attempt + 1
}

export const parseModelRow = (m: any): ModelInfo => ({
  id: String(m.id),
  contextLength: Number(m.top_provider?.context_length ?? m.context_length ?? 0),
  maxOutputTokens: m.top_provider?.max_completion_tokens ?? undefined,
  supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
  reasoningEfforts: m.reasoning?.supported_efforts ?? [],
  capabilities: m.x_zarg_capabilities ?? [],
  state: typeof m.state === "string" ? m.state : undefined,
})

/** A client for any OpenRouter-compatible `/chat/completions` endpoint (OpenRouter, zarg-router). */
export const openRouterWire = (o: WireOptions): WireClient => {
  const f = o.fetch ?? fetch
  const retries = o.retries ?? 3
  const backoffMs = o.backoffMs ?? 100
  const timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts }
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { "content-type": "application/json" } : {}),
    ...(o.apiKey ? { authorization: `Bearer ${Redacted.value(o.apiKey)}` } : {}),
    ...o.headers,
  })

  const send = (path: string, init: RequestInit): Effect.Effect<Response, ModelError> => {
    const attempt = (n: number): Effect.Effect<Response, ModelError> =>
      Effect.tryPromise({
        try: (signal) => f(`${o.baseUrl}${path}`, { ...init, signal }),
        catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
      }).pipe(
        Effect.catch((e) =>
          n < retries ? Effect.flatMap(Effect.sleep(retryDelay(undefined, n, backoffMs)), () => attempt(n + 1)) : Effect.fail(e),
        ),
        Effect.flatMap((res) => {
          if ((res.status === 429 || res.status >= 500) && n < retries) {
            return Effect.flatMap(Effect.sleep(retryDelay(res, n, backoffMs)), () => attempt(n + 1))
          }
          if (!res.ok) {
            return Effect.flatMap(
              Effect.promise(() => res.text().catch(() => "")),
              (body) => Effect.fail(new ModelError({ kind: "status", status: res.status, message: `${res.status} ${body}`.trim() })),
            )
          }
          return Effect.succeed(res)
        }),
      )
    return attempt(0)
  }

  const json = (res: Response) =>
    Effect.tryPromise({
      try: () => res.json() as Promise<any>,
      catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
    })

  const models = Effect.flatMap(send("/models", { method: "GET", headers: headers(false) }), json).pipe(
    Effect.map((body) => (Array.isArray(body?.data) ? body.data.map(parseModelRow) : [])),
  )

  return {
    stream: (req) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const body = yield* Effect.try({
            try: () => buildRequestBody(req),
            catch: (e) => new ModelError({ kind: "config", message: e instanceof Error ? e.message : String(e) }),
          })
          const res = yield* send("/chat/completions", { method: "POST", headers: headers(true), body })
          return parseSse(res, timeouts)
        }),
      ),
    models,
    verify: Effect.asVoid(models),
  }
}
```

`packages/model/src/wire/index.ts`:

```ts
export * from "./client"
export * from "./serialize"
export * from "./sse"
export * from "./types"
```

`packages/model/src/index.ts`:

```ts
export * as Config from "./config"
export * from "./env"
export * from "./errors"
export * from "./redact"
export * as Secrets from "./secrets"
export * from "./wire"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/model && mise x -- bun test`
Expected: PASS, 31 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/model
git commit -m "feat(model): OpenRouter-wire client with retries, idle and first-output timeouts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Provider contract and the Model service

**Files:**
- Create: `packages/model/src/provider.ts`, `packages/model/src/model.ts`, `packages/model/test/model.test.ts`
- Modify: `packages/model/src/index.ts`

**Interfaces:**
- Consumes: Task 3 `ZargConfig`, `Config.Config`; Task 5 wire types and `WireClient`.
- Produces:
  - `Provider { name, envKeys, schemaFile, connect(settings): Effect<ProviderClient, ConfigError> }`
  - `ProviderClient = WireClient & { warm?(model), systemone?(body) }`
  - `plain(provider, settings, key)`, `secret(provider, settings, key)` setting readers
  - Namespace `Model`: `Model.Model` service `{ stream(req: ModelRequest), info(ref), list(provider), warm(ref), client(provider) }`, `Model.make(providers, config)`, `Model.layer(providers): Layer<Model, ConfigError, Config>`, `Model.splitRef(ref)`, `ModelRequest { model: "provider:model", messages, tools?, maxTokens?, reasoning?, outputSchema? }`

- [ ] **Step 1: Write the failing tests**

`packages/model/test/model.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { type Config, Model, openRouterWire, plain, type Provider } from "../src"
import { delta, fakeServer, sse } from "./fake-server"

const server = fakeServer((req) =>
  new URL(req.url).pathname === "/models"
    ? Response.json({ data: [{ id: "coder", context_length: 1000, supported_parameters: ["tools"] }] })
    : sse([delta({ content: "hi" }, "stop")]),
)
afterAll(() => server.stop())

const local: Provider = {
  name: "local",
  envKeys: [],
  schemaFile: "/dev/null",
  connect: (settings) => Effect.map(plain("local", settings, "base_url"), (baseUrl) => openRouterWire({ baseUrl })),
}
const config = (base: string): Config.ZargConfig => ({ providers: { local: { base_url: base } }, roles: {}, extra: {} })
const run = <A, E>(f: (m: Model.Model["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(Model.make([local, { ...local, name: "unused" }], config(server.url)), f))

describe("Model", () => {
  test("routes provider:model to the provider and strips the prefix", async () => {
    const events = await run((m) => Stream.runCollect(m.stream({ model: "local:coder", messages: [{ role: "user", content: "x" }] })))
    expect(events[0]).toEqual({ type: "text", delta: "hi" })
    expect(JSON.parse(server.requests.at(-1)!.body).model).toBe("coder")
  })

  test("info reads the /models row", async () => {
    const info = await run((m) => m.info("local:coder"))
    expect(info).toMatchObject({ id: "coder", contextLength: 1000, supportsTools: true })
  })

  test("errors say what to fix", async () => {
    const msg = (ref: string) => run((m) => Effect.flip(m.info(ref))).then((e) => e.message)
    expect(await msg("local:missing")).toBe('local does not list a model "missing"')
    expect(await msg("unused:x")).toBe('provider "unused" is not configured; add [providers.unused] to .zarg/config.toml')
    expect(await msg("nope:x")).toBe('no provider plugin named "nope"')
    expect(await msg("no-colon")).toBe('model reference "no-colon" must look like "provider:model"')
  })

  test("warm is a no-op for a provider without warm-up", async () => {
    await run((m) => m.warm("local:coder"))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/model && mise x -- bun test test/model.test.ts`
Expected: FAIL, `Model` is not exported.

- [ ] **Step 3: Implement**

`packages/model/src/provider.ts`:

```ts
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
```

`packages/model/src/model.ts`:

```ts
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
```

`packages/model/src/index.ts` (final):

```ts
export * as Config from "./config"
export * from "./env"
export * from "./errors"
export * as Model from "./model"
export * from "./provider"
export * from "./redact"
export * as Secrets from "./secrets"
export * from "./wire"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/model && mise x -- bun test`
Expected: PASS, 35 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/model
git commit -m "feat(model): provider contract and Model service routing provider:model

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Provider plugins: zarg-router and OpenRouter

**Files:**
- Create: `packages/provider-openrouter/{package.json,tsconfig.json,mise.toml,.env.schema}`, `src/index.ts`, `test/openrouter.test.ts`
- Create: `packages/provider-zarg-router/{package.json,tsconfig.json,mise.toml,.env.schema}`, `src/index.ts`, `test/zarg-router.test.ts`

**Interfaces:**
- Consumes: Task 6 `Provider`, `plain`, `secret`, `ModelError`; Task 5 `openRouterWire`.
- Produces: `openrouter: Provider` (`@zarg/provider-openrouter`); `zargRouter: Provider` and `makeZargRouter(fetch?)` (`@zarg/provider-zarg-router`), whose client adds `warm(model)` (`POST <origin>/admin/warm`) and `systemone(body)` (`POST <base_url>/systemone`).
- Each package ships its env fragment as `.env.schema` at the package root (varlock only imports `.env.*` files).

- [ ] **Step 1: Create the packages**

```bash
for n in openrouter zarg-router; do mkdir -p packages/provider-$n/src packages/provider-$n/test; cp packages/graph/tsconfig.json packages/graph/mise.toml packages/provider-$n/; done
```

`packages/provider-openrouter/package.json`:

```json
{
  "name": "@zarg/provider-openrouter",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@zarg/model": "workspace:*" }
}
```

`packages/provider-zarg-router/package.json`: the same with `"name": "@zarg/provider-zarg-router"`.

```bash
for n in openrouter zarg-router; do (cd packages/provider-$n && mise x -- bun add effect@rc); done
```

`packages/provider-openrouter/.env.schema`:

```
# @defaultSensitive=false
# ---
# OpenRouter API key (https://openrouter.ai/keys)
# @required @sensitive @type=string(startsWith=sk-or-)
OPENROUTER_API_KEY=
# OpenRouter API base URL
# @type=url
OPENROUTER_URL=https://openrouter.ai/api/v1
```

`packages/provider-zarg-router/.env.schema`:

```
# @defaultSensitive=false
# ---
# zarg-router API base URL (local models)
# @type=url
ZARG_ROUTER_URL=http://localhost:11435/api/v1
```

- [ ] **Step 2: Write the failing tests**

`packages/provider-openrouter/test/openrouter.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Effect, Redacted } from "effect"
import { openrouter } from "../src"

describe("openrouter provider", () => {
  test("declares its env keys and ships its schema fragment", () => {
    expect(openrouter.envKeys).toEqual(["OPENROUTER_API_KEY", "OPENROUTER_URL"])
    expect(existsSync(openrouter.schemaFile)).toBe(true)
  })

  test("needs base_url; refuses an api_key that did not come from a sensitive variable", async () => {
    const missing = await Effect.runPromise(Effect.flip(openrouter.connect({})))
    expect(missing.key).toBe("providers.openrouter.base_url")
    const plainKey = await Effect.runPromise(Effect.flip(openrouter.connect({ base_url: "http://x", api_key: "sk-or-plain" })))
    expect(plainKey.message).toContain("must come from a @sensitive variable")
  })

  test("connects with a redacted key", async () => {
    const client = await Effect.runPromise(openrouter.connect({ base_url: "http://x", api_key: Redacted.make("sk-or-1") }))
    expect(typeof client.stream).toBe("function")
    expect(client.warm).toBeUndefined()
  })
})
```

`packages/provider-zarg-router/test/zarg-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeZargRouter } from "../src"

const recording = (reply: (url: string, body: any) => Response) => {
  const calls: Array<{ url: string; body: any }> = []
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    return reply(url, body)
  }) as unknown as typeof fetch
  return { calls, provider: makeZargRouter(f) }
}

describe("zarg-router provider", () => {
  test("warm posts the model id to /admin/warm at the router's origin", async () => {
    const r = recording(() => Response.json({ model: "m", state: "running" }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test:11435/api/v1/" }))
    await Effect.runPromise(client.warm!("deepseek-v4.1-flash-exl3"))
    expect(r.calls).toEqual([{ url: "http://router.test:11435/admin/warm", body: { model: "deepseek-v4.1-flash-exl3" } }])
  })

  test("a failed warm-up is a status error with the router's reason", async () => {
    const r = recording(() => Response.json({ error: "boot timed out" }, { status: 504 }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test/api/v1" }))
    const err = await Effect.runPromise(Effect.flip(client.warm!("m")))
    expect(err).toMatchObject({ kind: "status", status: 504 })
    expect(err.message).toContain("boot timed out")
  })

  test("systemone posts to /api/v1/systemone and returns the JSON", async () => {
    const r = recording(() => Response.json({ answers: { q: { type: "noul", noul: 0.9 } } }))
    const client = await Effect.runPromise(r.provider.connect({ base_url: "http://router.test/api/v1" }))
    const out = await Effect.runPromise(client.systemone!({ model: "jevk5", state: "s", questions: {} }))
    expect(out).toEqual({ answers: { q: { type: "noul", noul: 0.9 } } })
    expect(r.calls[0]?.url).toBe("http://router.test/api/v1/systemone")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `for n in openrouter zarg-router; do (cd packages/provider-$n && mise x -- bun test); done`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 4: Implement**

`packages/provider-openrouter/src/index.ts`:

```ts
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { openRouterWire, plain, type Provider, secret } from "@zarg/model"

/**
 * OpenRouter. Config:
 *   [providers.openrouter]
 *   base_url = "${OPENROUTER_URL}"
 *   api_key  = "${OPENROUTER_API_KEY}"
 */
export const openrouter: Provider = {
  name: "openrouter",
  envKeys: ["OPENROUTER_API_KEY", "OPENROUTER_URL"],
  schemaFile: fileURLToPath(new URL("../.env.schema", import.meta.url)),
  connect: (settings) =>
    Effect.gen(function* () {
      const baseUrl = yield* plain("openrouter", settings, "base_url")
      const apiKey = yield* secret("openrouter", settings, "api_key")
      return openRouterWire({ baseUrl, ...(apiKey ? { apiKey } : {}) })
    }),
}
```

`packages/provider-zarg-router/src/index.ts`:

```ts
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { ModelError, openRouterWire, plain, type Provider } from "@zarg/model"

const post = (url: string, body: unknown, f: typeof fetch) =>
  Effect.tryPromise({
    try: (signal) => f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }),
    catch: (e) => new ModelError({ kind: "transport", message: e instanceof Error ? e.message : String(e) }),
  }).pipe(
    Effect.flatMap((res) =>
      Effect.flatMap(
        Effect.promise(() => res.text().catch(() => "")),
        (text) => {
          if (!res.ok) return Effect.fail(new ModelError({ kind: "status", status: res.status, message: `${res.status} ${text}`.trim() }))
          return Effect.try({
            try: () => (text === "" ? {} : JSON.parse(text)) as unknown,
            catch: () => new ModelError({ kind: "stream", message: `bad JSON from ${url}` }),
          })
        },
      ),
    ),
  )

/**
 * zarg-router: local models behind an OpenRouter-compatible API, no key.
 *   [providers.zarg-router]
 *   base_url = "${ZARG_ROUTER_URL}"
 */
export const makeZargRouter = (f: typeof fetch = fetch): Provider => ({
  name: "zarg-router",
  envKeys: ["ZARG_ROUTER_URL"],
  schemaFile: fileURLToPath(new URL("../.env.schema", import.meta.url)),
  connect: (settings) =>
    Effect.gen(function* () {
      const baseUrl = (yield* plain("zarg-router", settings, "base_url")).replace(/\/+$/, "")
      const origin = baseUrl.replace(/\/api\/v1$/, "")
      const wire = openRouterWire({ baseUrl, fetch: f })
      return {
        ...wire,
        warm: (model) => Effect.asVoid(post(`${origin}/admin/warm`, { model }, f)),
        systemone: (body) => post(`${baseUrl}/systemone`, body, f),
      }
    }),
})

export const zargRouter = makeZargRouter()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `for n in openrouter zarg-router; do (cd packages/provider-$n && mise x -- bun test); done`
Expected: PASS, 3 tests each.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/provider-openrouter packages/provider-zarg-router bun.lock
git commit -m "feat(providers): zarg-router and OpenRouter provider plugins

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `@zarg/decisions`

**Files:**
- Create: `packages/decisions/{package.json,tsconfig.json,mise.toml}`, `src/index.ts`, `test/decisions.test.ts`

**Interfaces:**
- Consumes: `Config.Config`, `Model.Model`, `Model.splitRef`, `ProviderClient.systemone`, `ModelError`.
- Produces:
  - `Decisions` service: `decide({ state, questions }): Effect<Record<id, Answer>, DecisionError>`
  - `Question = choice{instructions, criteria} | noul{instructions} | score{instructions, levels}`
  - `Answer = choice{choice, probabilities, confidence} | noul{answer, probability, confidence} | score{score, level, probabilities, confidence}`
  - `DecisionError { kind: "invalid" | "unavailable" | "deadline" | "malformed", message }`
  - `layer({ role?, fallbackRole? })` (defaults `"decision"`, `"driver"`), `confidence(ps)`, `validate(req)`, `answerFrom(q, ps)`, `LIMITS`

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/decisions/src packages/decisions/test
cp packages/graph/tsconfig.json packages/graph/mise.toml packages/decisions/
```

`packages/decisions/package.json`:

```json
{
  "name": "@zarg/decisions",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@zarg/model": "workspace:*" }
}
```

```bash
cd packages/decisions && mise x -- bun add effect@rc && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/decisions/test/decisions.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Config, Model, ModelError, type ModelInfo, type ProviderClient, type StreamEvent } from "@zarg/model"
import { confidence, type DecisionRequest, Decisions, layer } from "../src"

const info = (id: string, capabilities: ReadonlyArray<string>): ModelInfo => ({
  id, contextLength: 8192, maxOutputTokens: 1, supportsTools: false, reasoningEfforts: [], capabilities, state: undefined,
})

interface Fake {
  readonly systemone?: (body: any) => Effect.Effect<unknown, ModelError>
  readonly chat?: (prompt: string) => ReadonlyArray<StreamEvent>
  readonly roles: Readonly<Record<string, string>>
}

const run = <A, E>(fake: Fake, eff: Effect.Effect<A, E, Decisions>) => {
  const calls = { systemone: [] as Array<any>, chat: [] as Array<any> }
  const client: ProviderClient = {
    stream: () => Stream.empty,
    models: Effect.succeed([]),
    verify: Effect.void,
    ...(fake.systemone
      ? { systemone: (b: unknown) => Effect.flatMap(Effect.sync(() => calls.systemone.push(b)), () => fake.systemone!(b)) }
      : {}),
  }
  const model = Layer.succeed(Model.Model, {
    client: () => Effect.succeed(client),
    list: () => Effect.succeed([]),
    info: (ref) => Effect.succeed(info(ref, ref === "r:jevk5" ? ["decision"] : [])),
    warm: () => Effect.void,
    stream: (req) => {
      calls.chat.push(req)
      return Stream.fromIterable(fake.chat?.(String(req.messages[0]?.content)) ?? [])
    },
  })
  const config = Layer.succeed(Config.Config, { providers: {}, roles: fake.roles, extra: {} })
  return Effect.runPromise(Effect.provide(eff, Layer.provide(layer(), Layer.merge(model, config)))).then((out) => ({ out, calls }))
}

const req: DecisionRequest = {
  state: "two threads edited S-0004",
  questions: {
    merge: { type: "choice", instructions: "Can both edits apply?", criteria: { compatible: "yes", conflicting: "no" } },
    ready: { type: "noul", instructions: "Enough evidence?" },
    risk: { type: "score", instructions: "How risky?", levels: ["low", "mid", "high"] },
  },
}
const decide = Decisions.use((d) => d.decide(req))
const text = (s: string): ReadonlyArray<StreamEvent> => [{ type: "text", delta: s }, { type: "done", finishReason: "stop" }]

describe("confidence", () => {
  test("1 for a certain answer, 0 for a uniform one", () => {
    expect(confidence([1, 0, 0])).toBe(1)
    expect(confidence([0.5, 0.5])).toBeCloseTo(0, 12)
    expect(confidence([0.9, 0.1])).toBeGreaterThan(0.5)
  })
})

describe("Decisions", () => {
  test("native: a decision-capable role model answers through /systemone", async () => {
    const { out, calls } = await run(
      {
        roles: { decision: "r:jevk5", driver: "r:chat" },
        systemone: () =>
          Effect.succeed({
            answers: {
              merge: { type: "choice", choice: "compatible", probabilities: { compatible: 0.8, conflicting: 0.2 } },
              ready: { type: "noul", noul: 0.9 },
              risk: { type: "score", score: 0.4, probabilities: [0.6, 0.4, 0] },
            },
          }),
      },
      decide,
    )
    expect(out.merge).toMatchObject({ type: "choice", choice: "compatible", probabilities: { compatible: 0.8, conflicting: 0.2 } })
    expect(out.ready).toMatchObject({ type: "noul", answer: true, probability: 0.9 })
    expect(out.risk).toMatchObject({ type: "score", level: "low" })
    expect((out.risk as { score: number }).score).toBeCloseTo(0.4, 12)
    expect(calls.systemone[0]).toMatchObject({ model: "jevk5", questions: { risk: { type: "score", criteria: ["low", "mid", "high"] } } })
    expect(calls.chat.length).toBe(0)
  })

  test("native unavailable falls back to structured output on the fallback role", async () => {
    const { out, calls } = await run(
      {
        roles: { decision: "r:jevk5", driver: "r:chat" },
        systemone: () => Effect.fail(new ModelError({ kind: "status", status: 503, message: "no capacity" })),
        chat: (prompt) =>
          text(
            prompt.includes("Can both") ? '{"probabilities":[0.3,0.7]}' : prompt.includes("Enough") ? '{"probabilities":[0.2,0.8]}' : '{"probabilities":[0,0,1]}',
          ),
      },
      decide,
    )
    expect(out.merge).toMatchObject({ choice: "conflicting" })
    expect(out.ready).toMatchObject({ answer: false })
    expect(out.risk).toMatchObject({ level: "high", score: 2 })
    expect(calls.chat.length).toBe(3)
    expect(calls.chat[0]).toMatchObject({ model: "r:chat", outputSchema: { type: "object" }, maxTokens: 1024 })
  })

  test("without a decision-capable model the fallback is used directly", async () => {
    const { calls } = await run({ roles: { decision: "r:chat", driver: "r:chat" }, chat: () => text('{"probabilities":[1,0]}') }, Decisions.use((d) => d.decide({ state: "s", questions: { ready: { type: "noul", instructions: "?" } } })))
    expect(calls.chat.length).toBe(1)
  })

  test("malformed, truncated and unavailable are typed errors", async () => {
    const one = Decisions.use((d) => Effect.flip(d.decide({ state: "s", questions: { ready: { type: "noul", instructions: "?" } } })))
    expect((await run({ roles: { driver: "r:chat" }, chat: () => text("not json") }, one)).out).toMatchObject({ kind: "malformed" })
    expect((await run({ roles: { driver: "r:chat" }, chat: () => text('{"probabilities":[1,2,3]}') }, one)).out).toMatchObject({ kind: "malformed" })
    expect(
      (await run({ roles: { driver: "r:chat" }, chat: () => [{ type: "text", delta: '{"prob' }, { type: "done", finishReason: "length" }] }, one)).out,
    ).toMatchObject({ kind: "malformed", message: "ready: answer was truncated" })
    expect((await run({ roles: {} }, one)).out).toMatchObject({ kind: "unavailable", message: "no decision model; set roles.decision or roles.driver" })
  })

  test("limits are checked before any model call", async () => {
    const tooFew = Decisions.use((d) => Effect.flip(d.decide({ state: "s", questions: { q: { type: "choice", instructions: "?", criteria: { only: "one" } } } })))
    const { out, calls } = await run({ roles: { driver: "r:chat" } }, tooFew)
    expect(out).toMatchObject({ kind: "invalid", message: "q: 2 to 16 options allowed, got 1" })
    expect(calls.chat.length).toBe(0)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/decisions && mise x -- bun test`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 4: Implement**

`packages/decisions/src/index.ts`:

```ts
import { Context, Data, Effect, Layer, Stream } from "effect"
import { Config, Model, type ModelError } from "@zarg/model"

export type Question =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "score"; readonly instructions: string; readonly levels: ReadonlyArray<string> }

export type Answer =
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: "noul"; readonly answer: boolean; readonly probability: number; readonly confidence: number }
  /** `score` is the probability-weighted level index (0-based); `level` is the most likely level. */
  | { readonly type: "score"; readonly score: number; readonly level: string; readonly probabilities: ReadonlyArray<number>; readonly confidence: number }

export interface DecisionRequest {
  readonly state: string
  readonly questions: Readonly<Record<string, Question>>
}

export type DecisionErrorKind = "invalid" | "unavailable" | "deadline" | "malformed"

export class DecisionError extends Data.TaggedError("DecisionError")<{
  readonly kind: DecisionErrorKind
  readonly message: string
}> {}

export class Decisions extends Context.Service<
  Decisions,
  { readonly decide: (req: DecisionRequest) => Effect.Effect<Readonly<Record<string, Answer>>, DecisionError> }
>()("@zarg/decisions/Decisions") {}

export const LIMITS = { questions: [1, 8], choiceOptions: [2, 16], scoreLevels: [2, 10], deadlineMs: 30_000 } as const

/** `1 - normalized entropy`: 1 when one option has all the mass, 0 when the mass is uniform. */
export const confidence = (ps: ReadonlyArray<number>): number => {
  if (ps.length < 2) return 1
  const h = -ps.reduce((acc, p) => (p > 0 ? acc + p * Math.log(p) : acc), 0)
  return Math.max(0, Math.min(1, 1 - h / Math.log(ps.length)))
}

export const validate = (req: DecisionRequest) => {
  const ids = Object.keys(req.questions)
  const bad = (message: string) => Effect.fail(new DecisionError({ kind: "invalid", message }))
  if (ids.length < LIMITS.questions[0] || ids.length > LIMITS.questions[1]) return bad(`1 to 8 questions allowed, got ${ids.length}`)
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length
      if (n < LIMITS.choiceOptions[0] || n > LIMITS.choiceOptions[1]) return bad(`${id}: 2 to 16 options allowed, got ${n}`)
    }
    if (q.type === "score" && (q.levels.length < LIMITS.scoreLevels[0] || q.levels.length > LIMITS.scoreLevels[1])) {
      return bad(`${id}: 2 to 10 levels allowed, got ${q.levels.length}`)
    }
  }
  return Effect.void
}

const normalize = (ps: ReadonlyArray<number>) => {
  const sum = ps.reduce((a, b) => a + b, 0)
  return sum > 0 && ps.every((p) => Number.isFinite(p) && p >= 0) ? ps.map((p) => p / sum) : undefined
}

/** Build an Answer from a probability per option; undefined when the numbers are unusable. */
export const answerFrom = (q: Question, raw: ReadonlyArray<number>): Answer | undefined => {
  const ps = normalize(raw)
  if (ps === undefined) return undefined
  const best = ps.indexOf(Math.max(...ps))
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria)
    if (ps.length !== keys.length) return undefined
    return { type: "choice", choice: keys[best]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, ps[i]!])), confidence: confidence(ps) }
  }
  if (q.type === "noul") {
    if (ps.length !== 2) return undefined
    return { type: "noul", answer: ps[0]! >= 0.5, probability: ps[0]!, confidence: confidence(ps) }
  }
  if (ps.length !== q.levels.length) return undefined
  return {
    type: "score",
    score: ps.reduce((acc, p, i) => acc + p * i, 0),
    level: q.levels[best]!,
    probabilities: ps,
    confidence: confidence(ps),
  }
}

// Native: zarg-router's /systemone. Choice → probabilities by key; noul → p(true); score → probabilities by level.
const nativeBody = (model: string, req: DecisionRequest) => ({
  model,
  state: req.state,
  questions: Object.fromEntries(
    Object.entries(req.questions).map(([id, q]) => [
      id,
      q.type === "score" ? { type: "score", instructions: q.instructions, criteria: q.levels } : q,
    ]),
  ),
})

const fromNative = (req: DecisionRequest, body: any): Record<string, Answer> | undefined => {
  const out: Record<string, Answer> = {}
  for (const [id, q] of Object.entries(req.questions)) {
    const a = body?.answers?.[id]
    let ans: Answer | undefined
    if (q.type === "choice" && a?.probabilities) ans = answerFrom(q, Object.keys(q.criteria).map((k) => Number(a.probabilities[k])))
    if (q.type === "noul" && typeof a?.noul === "number") ans = answerFrom(q, [a.noul, 1 - a.noul])
    if (q.type === "score" && Array.isArray(a?.probabilities)) ans = answerFrom(q, a.probabilities.map(Number))
    if (q.type === "score" && ans === undefined && typeof a?.score === "number") {
      // Only the weighted score came back: put the mass on the two nearest levels.
      const i = Math.floor(a.score)
      const frac = a.score - i
      const ps = q.levels.map((_, k) => (k === i ? 1 - frac : k === i + 1 ? frac : 0))
      ans = answerFrom(q, ps)
    }
    if (ans === undefined) return undefined
    out[id] = ans
  }
  return out
}

// Fallback: one structured-output request per question, each in its own context, no tools.
const fallbackSchema = (q: Question) => ({
  type: "object",
  additionalProperties: false,
  required: ["probabilities"],
  properties: {
    probabilities: {
      type: "array",
      items: { type: "number" },
      description:
        q.type === "choice"
          ? `probability of each option, in this order: ${Object.keys(q.criteria).join(", ")}`
          : q.type === "noul"
            ? "probability of true, then probability of false"
            : `probability of each level, in this order: ${q.levels.join(", ")}`,
    },
  },
})

const fallbackPrompt = (state: string, q: Question) =>
  [
    "Judge the question against the state. Answer only with the JSON object.",
    `State:\n${state}`,
    `Question: ${q.instructions}`,
    q.type === "choice"
      ? `Options:\n${Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : q.type === "score"
        ? `Levels (lowest first):\n${q.levels.map((l, i) => `${i}. ${l}`).join("\n")}`
        : "Answer true or false.",
  ].join("\n\n")

export interface DecisionsOptions {
  /** Role whose model answers natively (needs the "decision" capability). */
  readonly role?: string
  /** Chat role used for the structured fallback. */
  readonly fallbackRole?: string
}

export const make = (opts: DecisionsOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* Config.Config
    const model = yield* Model.Model
    const role = opts.role ?? "decision"
    const fallbackRole = opts.fallbackRole ?? "driver"

    const native = (ref: string, req: DecisionRequest) =>
      Effect.gen(function* () {
        const { provider, model: id } = yield* Model.splitRef(ref)
        const client = yield* model.client(provider)
        if (client.systemone === undefined) return yield* new DecisionError({ kind: "unavailable", message: `${provider} has no decision endpoint` })
        const body = yield* client.systemone(nativeBody(id, req))
        const answers = fromNative(req, body)
        if (answers === undefined) return yield* new DecisionError({ kind: "malformed", message: `${ref} returned answers that do not fit the questions` })
        return answers
      })

    const structured = (ref: string, req: DecisionRequest) =>
      Effect.forEach(
        Object.entries(req.questions),
        ([id, q]) =>
          Effect.gen(function* () {
            const events = yield* Stream.runCollect(
              model.stream({
                model: ref,
                messages: [{ role: "user", content: fallbackPrompt(req.state, q) }],
                outputSchema: fallbackSchema(q),
                maxTokens: 1024,
              }),
            )
            const done = events.find((e) => e.type === "done")
            if (done?.type === "done" && done.finishReason === "length") {
              return yield* new DecisionError({ kind: "malformed", message: `${id}: answer was truncated` })
            }
            const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")
            const parsed = yield* Effect.try({
              try: () => JSON.parse(text) as { probabilities?: unknown },
              catch: () => new DecisionError({ kind: "malformed", message: `${id}: fallback answer is not JSON` }),
            })
            const ans = Array.isArray(parsed.probabilities) ? answerFrom(q, parsed.probabilities.map(Number)) : undefined
            if (ans === undefined) return yield* new DecisionError({ kind: "malformed", message: `${id}: fallback probabilities do not fit the question` })
            return [id, ans] as const
          }),
        { concurrency: 8 },
      ).pipe(Effect.map((entries): Record<string, Answer> => Object.fromEntries(entries)))

    const toDecisionError = (e: ModelError | DecisionError) =>
      e._tag === "DecisionError" ? e : new DecisionError({ kind: "unavailable", message: e.message })

    const decide = (req: DecisionRequest) =>
      Effect.gen(function* () {
        yield* validate(req)
        const started = Date.now()
        const nativeRef = config.roles[role]
        const nativeOk =
          nativeRef !== undefined &&
          (yield* model.info(nativeRef).pipe(
            Effect.map((i) => i.capabilities.includes("decision")),
            Effect.orElseSucceed(() => false),
          ))
        const attempt = nativeOk
          ? native(nativeRef!, req).pipe(
              Effect.mapError(toDecisionError),
              Effect.catchTag("DecisionError", (e) =>
                e.kind === "unavailable" && config.roles[fallbackRole] !== undefined
                  ? structured(config.roles[fallbackRole]!, req).pipe(Effect.mapError(toDecisionError))
                  : Effect.fail(e),
              ),
            )
          : config.roles[fallbackRole] !== undefined
            ? structured(config.roles[fallbackRole]!, req).pipe(Effect.mapError(toDecisionError))
            : Effect.fail(new DecisionError({ kind: "unavailable", message: `no decision model; set roles.${role} or roles.${fallbackRole}` }))
        const answers = yield* attempt.pipe(
          Effect.timeoutOrElse({
            duration: LIMITS.deadlineMs,
            orElse: () => Effect.fail(new DecisionError({ kind: "deadline", message: `no decision within ${LIMITS.deadlineMs}ms` })),
          }),
        )
        yield* Effect.logInfo("decision").pipe(
          Effect.annotateLogs({
            transport: nativeOk ? "native" : "structured",
            latencyMs: Date.now() - started,
            confidence: Object.values(answers).map((a) => a.confidence.toFixed(3)).join(","),
          }),
        )
        return answers
      })

    return { decide } satisfies Decisions["Service"]
  })

export const layer = (opts: DecisionsOptions = {}) => Layer.effect(Decisions, make(opts))
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/decisions && mise x -- bun test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/decisions bun.lock
git commit -m "feat(decisions): Decisions service with JEV /systemone and structured fallback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire this repo

**Files:**
- Create: `.env.schema`, `.zarg/config.toml`
- Modify: `.gitignore`, `AGENTS.md`

**Interfaces:**
- Consumes: the provider packages' `.env.schema` fragments; `Env`, `Config.load`.
- Produces: this repo resolves its environment and config: roles point at `zarg-router:deepseek-v4.1-flash-exl3` (driver, sync) and `zarg-router:jevk5` (decision).

- [ ] **Step 1: Write the files**

`.env.schema`:

```
# Environment for zarg in this repo. Values: ~/.config/zarg/.env.local (per user), then ./.env.local (gitignored).
# Later imports win; this file's own .env.local wins over all imports. Never put defaults here.
# @defaultSensitive=false
# @import(./packages/provider-zarg-router/)
# @import(./packages/provider-openrouter/)
# @import(~/.config/zarg/, allowMissing=true)
# ---
```

`.gitignore`:

```
node_modules/
.env.local
.env.*.local
```

`.zarg/config.toml`:

```toml
# zarg configuration for this repo. ${VAR} expands from the varlock-resolved environment.

[providers.zarg-router]
base_url = "${ZARG_ROUTER_URL}"

[providers.openrouter]
base_url = "${OPENROUTER_URL}"
api_key  = "${OPENROUTER_API_KEY:-}"

[roles]
driver   = "zarg-router:deepseek-v4.1-flash-exl3"
sync     = "zarg-router:deepseek-v4.1-flash-exl3"
decision = "zarg-router:jevk5"
```

`AGENTS.md`: replace it with:

````markdown
# Agent Guide

Rules for any agent (Claude, Codex, etc.) working in this repo.

## Toolchain

- **mise** manages every tool version. `mise.toml` is the source of truth.
- **bun** is the JavaScript runtime, package manager, test runner, and script runner.

## Layout

Monorepo. Every module lives in its own package under `packages/<name>/`.

```
mise.toml        # tool versions + monorepo root (config_roots = packages/*)
package.json     # bun workspaces = packages/*
packages/<name>/
  mise.toml      # this package's tasks (build, test, dev, ...)
  package.json   # name: @zarg/<name>
```

- One package = one module. No cross-package imports through relative paths; depend on the package by name (`"@zarg/<name>": "workspace:*"`).
- Tool versions live only in the root `mise.toml`. Package `mise.toml` files define tasks only.
- One `bun.lock` at the root. Run `bun install` from the root.

## Packages

- `packages/graph` (`@zarg/graph`): JSON graph store under `.zarg/graph`: snapshot, queries, diff.
- `packages/plugin` (`@zarg/plugin/server`): plugin contract, `PluginHost` and the write pipeline.
- `packages/plugin-gherkin` (`@zarg/plugin-gherkin/server`): atomic Gherkin user action graph (states and cards).
- `packages/cli` (`@zarg/cli`): the `zarg` CLI. Run it with `mise run -q zarg -- <command>`.
- `packages/model` (`@zarg/model`): `Env` and `Secrets` (varlock), config loader, `Model` service, provider contract, OpenRouter-wire client.
- `packages/provider-zarg-router`, `packages/provider-openrouter`: provider plugins. Each ships its `.env.schema` fragment.
- `packages/decisions` (`@zarg/decisions`): `Decisions` service (JEV `/systemone`, structured fallback).

Design: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md` and `docs/superpowers/specs/2026-09-25-agent-runtime-design.md`.

## Secrets

- The root `.env.schema` declares every variable zarg reads (it imports the provider packages and `~/.config/zarg/`). Values live in gitignored `.env.local` files. Store secrets with varlock's device-bound encryption: `echo "$KEY" | mise x -- bunx varlock encrypt`.
- Never print, log or commit a secret value. In tests, use variable names unique to the test so a developer's real environment cannot override them or leak into output.

## Requirements

This repo's requirements live in its own zarg graph under `.zarg/graph`.

- Use the `zarg-drive` skill (`.claude/skills/zarg-drive/SKILL.md`) to refine requirements. It edits only the graph.
- Use the `zarg-sync` skill (`.claude/skills/zarg-sync/SKILL.md`) to make code match the graph. It edits only code.
- Never edit `.zarg/graph` files by hand. Change them through `zarg tool call`.
- Tag code that implements a card with a `// @card <id>` comment (for example `// @card UX-0003`).

## Tasks

mise orchestrates tasks across packages:

```sh
mise tasks ls --all             # list every task in the monorepo
mise //packages/<name>:test     # one task in one package
mise //...:test                 # the same task in every package
```

A task depends on another package's task with `depends = ["//packages/<other>:build"]`.

## Setup

```sh
mise trust
mise install
```

## Rules

- Run tools through mise (`mise x -- bun ...`). A globally installed bun can shadow the pinned one even inside `mise run`, so every task calls `mise x -- bun`, and tests spawn `process.execPath`, never a bare `bun`.
- Add or change a tool version only in `mise.toml`. Never document a version anywhere else.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm`, or `node`. Use `bunx` in place of `npx`.
- Use `bun add` / `bun remove` to change dependencies. Commit `bun.lock`.
- Use `bun test` for tests and `bun run <script>` for package scripts.
- `mise run verify` typechecks and tests every package. It must pass before any commit.
- Define repeatable project commands as `[tasks]` in `mise.toml`, so humans and agents run the same thing (`mise run <task>`).
````

- [ ] **Step 2: Check the wiring (prints names and flags, never values)**

Create a throwaway script `packages/model/wire-check.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { Config, Env, layer } from "@zarg/model"
const root = process.argv[2]!
const prog = Effect.gen(function* () {
  const env = yield* Env
  const fields = yield* env.fields(["ZARG_ROUTER_URL", "OPENROUTER_URL", "OPENROUTER_API_KEY"])
  console.log(fields.map((f) => `${f.name} sensitive=${f.sensitive} required=${f.required} errors=${f.errors.length}`).join("\n"))
  const c = yield* Config.load({ userDir: `${process.env.HOME}/.config/zarg`, projectDir: root })
  console.log("roles", JSON.stringify(c.roles))
  console.log("router base_url", c.providers["zarg-router"]?.base_url)
  const k = c.providers.openrouter?.api_key
  console.log("openrouter api_key redacted:", k === undefined ? "unset" : Redacted.isRedacted(k))
})
await Effect.runPromise(prog.pipe(Effect.provide(Layer.merge(layer(root), BunServices.layer))))
```

Run: `mise x -- bun packages/model/wire-check.ts "$PWD"; rm packages/model/wire-check.ts`
Expected:

```
ZARG_ROUTER_URL sensitive=false required=true errors=0
OPENROUTER_URL sensitive=false required=true errors=0
OPENROUTER_API_KEY sensitive=true required=true errors=<0, or 1 when no key is set anywhere>
roles {"driver":"zarg-router:deepseek-v4.1-flash-exl3","sync":"zarg-router:deepseek-v4.1-flash-exl3","decision":"zarg-router:jevk5"}
router base_url http://localhost:11435/api/v1
openrouter api_key redacted: <true when a key is set, otherwise unset>
```

- [ ] **Step 3: Gate and commit**

Run: `mise run verify`
Expected: exit 0, 120 tests (graph 22, plugin 19, plugin-gherkin 19, cli 13, model 35, provider-openrouter 3, provider-zarg-router 3, decisions 6).

```bash
git add .env.schema .gitignore .zarg/config.toml AGENTS.md
git commit -m "chore: wire this repo's env schema and model roles

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
