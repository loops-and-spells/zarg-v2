# Service Plugins and the Rehearse Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins gain typed dependencies, a `service` archetype, powers for models, decisions, agents, clock and agenda, self-drawn agent bodies with actions, and plugin slash commands; rehearse moves out of the core into `@zarg/plugin-rehearse`, where the developer picks which findings to apply.

**Architecture:** The SDK gets `pluginContract` (an Effect `Context.Service` class per plugin's public read methods) and `pluginDependencies`; the host loads plugins in dependency order, checks contract digests and serves the new powers from host callbacks the core provides. Plugin agents are activity nodes in main's agents pane (own stream per plugin, ids `<plugin>:<id>`); bodies come from the plugin's reserved `body` method and actions go to `act`. The core keeps the findings gate (`Findings.take` / `Findings.resolve`) for any plugin that answers `finding`. Rehearse is ported module by module into the plugin, talking to Gherkin through its contract.

**Tech Stack:** Bun, Effect 4 (rc.117), SES (plugin processes), `@zarg/plugin-sdk`, `@zarg/plugin`, OpenTUI.

**Spec:** `docs/superpowers/specs/2026-09-27-service-plugins-rehearse-design.md` (and `docs/superpowers/specs/2026-09-27-rehearse-design.md` for rehearse's behaviour)

## Global Constraints

- `mise run verify` must pass before every commit; run tools as `mise x -- bun …`; tests spawn `process.execPath`.
- Plugin code runs only in its own locked-down process; no package imports a plugin package except `/contract` subpaths, which must be code-free (Schemas and the contract tag).
- A plugin never opens the driver's write gate, never writes the graph outside the write pipeline, never commits.
- New power scopes: `decisions: true`, `models: ReadonlyArray<string>` (roles), `agents: true`; `Clock`, `Agenda.changed` and `Plugins.call` need no scope beyond the rules below. YOLO passes declared scopes only.
- Plugin agent ids in the pane are `<plugin>:<id>`; their activity stream is `main-<plugin>-agents`.
- `auto_apply` (rehearse config) defaults to `false`.
- Per-plugin budget for `Models` and `Decisions`: `[plugins.<name>] budget = { decisions_per_hour = 20000, tokens_per_hour = 2000000 }` by default; past it, `BudgetExceeded`.
- No live model in `verify`; tests must not write `~/.config/zarg`; test-unique names.

## Review Focus

1. A dependency that loads but whose process later crashes for good: its dependents must be disabled too, with an agenda item, and their calls fail typed. → Task 1, test "a dependency disabled at runtime disables its dependents".
2. A plugin calling a dependency method that exists but is not in the contract (a write tool): refused. → Task 1, test "Plugins.call reaches only contract methods of declared dependencies".
3. A plugin agent id that collides with an RLM id or another plugin's agent: impossible by construction (prefix); a plugin sending an id with `:` or `/` is refused. → Task 3, test "agent ids are namespaced and checked".
4. The developer applies findings, restarts zarg before the driver takes them up: the chosen findings are still on the agenda (the plugin's record). → Task 7, test "chosen findings survive a restart".
5. A body action for an agent whose plugin is gone (disabled or not loaded): a typed failure shown as a notice, never a crash. → Task 4, test "an action on a gone plugin's agent is a notice".

---

## File structure

- `packages/plugin-sdk/src/contract.ts` (new): `pluginContract`, contract digest.
- `packages/plugin-sdk/src/define.ts`, `services.ts`, `manifest.ts`, `build.ts`: dependencies, archetype, new powers (clients), commands in the manifest.
- `packages/plugin/src/runtime/powers.ts`: new powers (host side), budget.
- `packages/plugin/src/server/host.ts`: dependency order and checks, `invoke`, agenda from any plugin, `body`/`act`/`finding`/`resolved`/`stop` routing, commands.
- `packages/plugin-gherkin/src/contract.ts` (new), `package.json` (`./contract` export).
- `scripts/build-plugins.ts` (new, repo root): builds first-party plugins and writes every hash.
- `packages/core/src/plugin-agents.ts` (new): the `Agents` power's host side (activity streams).
- `packages/core/src/findings.ts` (new): `Findings.take` / `Findings.resolve` driver service.
- `packages/core/src/server.ts`, `live.ts`, `main.ts`: body/action/command routes; wiring.
- `packages/client/src/client.ts`, `session.ts`; `packages/cli/src/tui/view.ts`, `app.tsx`, `commands.ts`: bodies, tables, plugin commands.
- `packages/plugin-rehearse/` (new package): the rehearse plugin (ported from `packages/core/src/rehearse/`).
- Removed: `packages/core/src/rehearse/`, its tests, the `Rehearse` service and `RehearseControl`.

---

### Task 1: Plugin contracts and pluginDependencies

**Files:**
- Create: `packages/plugin-sdk/src/contract.ts`, `packages/plugin-gherkin/src/contract.ts`, `scripts/build-plugins.ts`
- Modify: `packages/plugin-sdk/src/define.ts`, `manifest.ts`, `services.ts`, `index.ts`; `packages/plugin/src/runtime/powers.ts`; `packages/plugin/src/server/host.ts`; `packages/plugin-gherkin/src/index.ts`, `package.json`, `scripts/build.ts`, `mise.toml`; `packages/plugin/test/import-rule.test.ts`
- Test: `packages/plugin-sdk/test/contract.test.ts`, `packages/plugin/test/dependencies.test.ts`, `packages/plugin/test/import-rule.test.ts`

**Interfaces:**
- Produces:
  - `pluginContract<const M extends Record<string, { params: Schema.Codec<any, any>; success: Schema.Codec<any, any> }>>(name: string, methods: M)`: a class to extend; the class is a `Context.Service` whose service shape is `{ [K in keyof M]: (p: Type<M[K]["params"]>) => Effect<Type<M[K]["success"]>, PluginFailure> }`, with static `pluginName: string`, `methods: M`, `digest: string` (sha256 of the canonical JSON Schemas of `methods`).
  - `PluginDef.pluginDependencies?: ReadonlyArray<Contract>`; `Manifest.pluginDependencies: ReadonlyArray<{ name: string; methods: string }>`.
  - Power `plugins.call` `{ name, method, params }`.
  - `@zarg/plugin-gherkin/contract` exporting `class Gherkin extends pluginContract("gherkin", { stories, step })`.
  - `mise run build:plugins` (root) building `plugin-gherkin` and `plugin-rehearse` (when present) and writing every first-party hash.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/plugin-sdk/test/contract.test.ts
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { pluginContract } from "../src"

class Notes extends pluginContract("notes", {
  count: { params: Schema.Struct({ prefix: Schema.String }), success: Schema.Number },
}) {}

test("a contract is a typed service tag carrying its plugin's name and a digest of its methods", async () => {
  expect(Notes.pluginName).toBe("notes")
  expect(Notes.digest).toMatch(/^[0-9a-f]{64}$/)
  class Same extends pluginContract("notes", { count: { params: Schema.Struct({ prefix: Schema.String }), success: Schema.Number } }) {}
  expect(Same.digest).toBe(Notes.digest)
  class Changed extends pluginContract("notes", { count: { params: Schema.Struct({ prefix: Schema.Number }), success: Schema.Number } }) {}
  expect(Changed.digest).not.toBe(Notes.digest)
  const n = await Effect.runPromise(Effect.gen(function* () {
    const notes = yield* Notes
    return yield* notes.count({ prefix: "a" })
  }).pipe(Effect.provideService(Notes, Notes.of({ count: () => Effect.succeed(3) }))))
  expect(n).toBe(3)
  // @ts-expect-error: not in the contract
  const _never = (s: Notes["Service"]) => s.remove
})
```

```ts
// packages/plugin/test/dependencies.test.ts
// Uses the existing fixture helpers in packages/plugin/test/fixtures.ts that build a plugin bundle and manifest
// from inline source (as host.test.ts does); add two helpers there if missing: `fixturePlugin(source)` and
// `hostWith(plugins, opts)`.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "../src/server"
import { fixturePlugin, hostWith } from "./fixtures"

const base = (name: string, extra = "") => `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
export class Base extends pluginContract("${name}", { hello: { params: Schema.Struct({}), success: Schema.String } }) {}
export default definePlugin({ name: "${name}", service: "Base${name.replace(/[^a-z]/g, "")}", archetype: "service", config: Schema.Struct({}), scopes: {},
  methods: { hello: { doc: "hi", params: Schema.Struct({}), success: Schema.String }, write: { doc: "w", params: Schema.Struct({}), success: Schema.String, agents: true } },
  make: Effect.succeed({ hello: () => Effect.succeed("hi from ${name}"), write: () => Effect.succeed("x") }) ${extra} })`

const dependent = (on: string, method = "hello") => `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
class Base extends pluginContract("${on}", { ${method}: { params: Schema.Struct({}), success: Schema.String } }) {}
export default definePlugin({ name: "user", service: "User", archetype: "service", config: Schema.Struct({}), scopes: {}, pluginDependencies: [Base],
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String, agents: true } },
  make: Effect.gen(function* () { const b = yield* Base; return { go: () => b.${method}({}) } }) })`

describe("plugin dependencies", () => {
  test("a dependent calls its dependency through the contract", async () => {
    const out = await Effect.runPromise(hostWith([await fixturePlugin(base("base")), await fixturePlugin(dependent("base"))], (h) => h.invoke("user", "go", {})))
    expect(out).toBe("hi from base")
  })

  test("a missing dependency, a mismatched contract and a cycle each keep the dependent from loading, with a reason on the agenda", async () => {
    const missing = await Effect.runPromise(hostWith([await fixturePlugin(dependent("nobody"))], (h) => h.agenda()))
    expect(missing.map((i) => i.title)).toContain("Plugin user needs nobody, which is not loaded")
    const mismatch = await Effect.runPromise(hostWith([await fixturePlugin(base("base")), await fixturePlugin(dependent("base", "goodbye"))], (h) => h.agenda()))
    expect(mismatch.map((i) => i.detail).join("\n")).toContain("built against a different base")
  })

  test("Plugins.call reaches only contract methods of declared dependencies", async () => {
    const sneaky = `
import { Effect, Schema } from "effect"
import { definePlugin, pluginContract } from "@zarg/plugin-sdk"
class Base extends pluginContract("base", { hello: { params: Schema.Struct({}), success: Schema.String } }) {}
export default definePlugin({ name: "user", service: "User", archetype: "service", config: Schema.Struct({}), scopes: {}, pluginDependencies: [Base],
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.String, agents: true } },
  make: Effect.succeed({ go: () => Effect.tryPromise({ try: () => (globalThis as any).__rawCall("plugins.call", { name: "base", method: "write", params: {} }), catch: (e) => e as never }) }) })`
    const r = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(base("base")), await fixturePlugin(sneaky)], (h) => h.invoke("user", "go", {}))))
    expect(JSON.stringify(r)).toContain("not in the base contract")
  })

  test("a dependency disabled at runtime disables its dependents", async () => {
    const crashing = base("base").replace('hello: () => Effect.succeed("hi from base")', "hello: () => Effect.die(new Error(\"boom\"))")
    const items = await Effect.runPromise(hostWith([await fixturePlugin(crashing), await fixturePlugin(dependent("base"))], (h) =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) yield* Effect.exit(h.invoke("base", "hello", {}))
        yield* h.disableCrashed("base") // test hook: marks base disabled as three restarts would
        return yield* h.agenda()
      })))
    expect(items.map((i) => i.title)).toContain("Plugin user was disabled: base, which it needs, was disabled")
  })
})
```

Add to `packages/plugin/test/import-rule.test.ts`:

```ts
test("other packages may import only a plugin's /contract, and a contract carries no plugin code", () => {
  const offenders = readdirSync(root)
    .filter((pkg) => !pkg.startsWith("plugin-"))
    .flatMap((pkg) => files(join(root, pkg)).filter((f) => /from ["']@zarg\/plugin-(?!sdk)[a-z-]+(?!\/contract)["']/.test(readFileSync(f, "utf8"))))
  expect(offenders).toEqual([])
  const contract = readFileSync(join(root, "plugin-gherkin", "src", "contract.ts"), "utf8")
  expect(contract).not.toMatch(/from ["']\.\/(?!schemas)/)
  expect(contract).not.toContain("definePlugin")
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/plugin-sdk && mise x -- bun test test/contract.test.ts; cd ../plugin && mise x -- bun test test/dependencies.test.ts test/import-rule.test.ts`
Expected: FAIL (`pluginContract` missing; fixtures and host methods missing).

- [ ] **Step 3: Implement the SDK side**

```ts
// packages/plugin-sdk/src/contract.ts
import { createHash } from "node:crypto"
import { Context, Effect, Schema } from "effect"
import type { PluginFailure } from "./services"

export type ContractMethods = Readonly<Record<string, { readonly params: Schema.Codec<any, any>; readonly success: Schema.Codec<any, any> }>>
type Shape<M extends ContractMethods> = { readonly [K in keyof M]: (p: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, PluginFailure> }

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

/** The digest a dependent was built against: every method's params and success JSON Schemas. */
export const contractDigest = (methods: ContractMethods) =>
  createHash("sha256")
    .update(canonical(Object.fromEntries(Object.entries(methods).map(([k, m]) => [k, { params: Schema.toJsonSchemaDocument(m.params), success: Schema.toJsonSchemaDocument(m.success) }]))))
    .digest("hex")

/**
 * A plugin's public read surface for other plugins: an Effect service tag with its name and method Schemas.
 * `class Gherkin extends pluginContract("gherkin", { stories: { params, success } }) {}`
 */
export const pluginContract = <const M extends ContractMethods>(name: string, methods: M) => {
  const Tag = Context.Service<any, Shape<M>>()(`@zarg/plugin-contract/${name}`)
  return class extends (Tag as unknown as new () => object) {
    static readonly pluginName = name
    static readonly methods = methods
    static readonly digest = contractDigest(methods)
  } as unknown as typeof Tag & { readonly pluginName: string; readonly methods: M; readonly digest: string; new (): { readonly Service: Shape<M> } }
}
export type Contract = { readonly pluginName: string; readonly methods: ContractMethods; readonly digest: string; readonly key: string }
```

`build.ts` runs under Bun, so `node:crypto` in `contract.ts` is fine at build time; the bundle (browser target) must not carry it: compute the digest lazily only in `manifestOf` (Bun) and in the host, never in the plugin runtime. If `node:crypto` breaks the bundle, move `contractDigest` to `packages/plugin-sdk/src/tools-digest.ts` imported only by `manifest.ts`, and keep `digest` a getter there. Ledger which you did.

`define.ts`: add `readonly pluginDependencies?: ReadonlyArray<Contract>` to `PluginDef`; widen `archetype` to `"graph" | "provider" | "service"`; the `make` requirement type gains the dependency tags (`Context` requirement union of `InstanceType` of each contract). In `serve`, for each dependency add `Layer.succeed(dep, dep.of(Object.fromEntries(Object.entries(dep.methods).map(([m, spec]) => [m, (p) => power(raw, "plugins.call", { name: dep.pluginName, method: m, params: Schema.encodeSync(spec.params)(p) }).pipe(Effect.flatMap((v) => Schema.decodeUnknownEffect(spec.success)(v)), Effect.mapError(asFailure))]))))`.

`manifest.ts`: `Manifest.archetype` widens; `pluginDependencies: (p.pluginDependencies ?? []).map((c) => ({ name: c.pluginName, methods: contractDigest(c.methods) }))`. `index.ts` exports `pluginContract`, `Contract`.

- [ ] **Step 4: Implement the host side**

`powers.ts`: `makePowers` opts gain `callPlugin?: (name: string, method: string, params: unknown) => Promise<unknown>` and `dependencies: ReadonlyArray<{ name: string; methods: ReadonlyArray<string> }>`; add the power:

```ts
    "plugins.call": async (args) => {
      const a = args as { name?: unknown; method?: unknown; params?: unknown }
      const dep = opts.dependencies.find((d) => d.name === a.name)
      if (dep === undefined) throw notGranted(`${opts.plugin}: ${printable(String(a.name))} is not one of its pluginDependencies`)
      if (!dep.methods.includes(String(a.method))) throw notGranted(`${opts.plugin}: ${printable(String(a.method))} is not in the ${dep.name} contract`)
      if (opts.callPlugin === undefined) throw pluginError(`${opts.plugin}: no plugin calls in this host`)
      return await opts.callPlugin(dep.name, String(a.method), a.params)
    },
```

`host.ts`:
- `manifestProblem` accepts `archetype === "service"`.
- Before starting: order `plugins` topologically by `manifest.pluginDependencies`; plugins in a cycle get `failed(m, "its pluginDependencies form a cycle: a → b → a")`.
- Start in dependency order (a plugin waits for its dependencies' start): a plugin whose dependency did not start, or whose dependency's manifest methods do not include every method the contract digest covers, gets an agenda item: title `Plugin <name> needs <dep>, which is not loaded`, or detail `it was built against a different <dep> (…); rebuild it`. The contract's method names travel in the manifest as `pluginDependencies[].methodNames` (add it next to `methods`), and the digest of the dependency's actual method Schemas is recomputed from its manifest (`contractDigest` over the same JSON Schemas; store the per-method JSON Schemas in the manifest already).
- `makePowers` gets `dependencies` (names and method names from the manifest) and `callPlugin: (name, method, params) => Effect.runPromise(invoke(running.get(name)!, method, params))` (looked up at call time).
- `onExit` disabling: after a plugin is disabled, disable every running plugin whose `pluginDependencies` name it (transitively), each with the item `Plugin <name> was disabled: <dep>, which it needs, was disabled`.
- Add to `PluginHost`: `invoke(plugin, method, params)` (any loaded plugin, any method; used by the core for reserved methods) and, for tests, `disableCrashed(name)`.
- `RESERVED` gains `body`, `act`, `finding`, `resolved`, `stop`.

- [ ] **Step 5: Gherkin's contract and the shared build**

```ts
// packages/plugin-gherkin/src/contract.ts
import { Schema } from "effect"
import { pluginContract } from "@zarg/plugin-sdk"

export const StoriesParams = Schema.Struct({ strategy: Schema.Literals(["edge-pair", "teleport"]), focus: Schema.optionalKey(Schema.Array(Schema.String)) })
export const StoriesResult = Schema.Struct({ stories: Schema.Array(Schema.Array(Schema.String)), unreachable: Schema.Number })
export const StepParams = Schema.Struct({ card: Schema.String, via: Schema.optionalKey(Schema.String) })
export const StepView = Schema.NullOr(
  Schema.Struct({
    card: Schema.String, title: Schema.String, given: Schema.String, when: Schema.String, thens: Schema.Array(Schema.String),
    via: Schema.optionalKey(Schema.Struct({ card: Schema.String, when: Schema.String })),
    fork: Schema.Array(Schema.Struct({ card: Schema.String, when: Schema.String })),
    hasFailure: Schema.Boolean,
  }),
)

/** Gherkin's read surface for other plugins: story planning and step views for testers. */
export class Gherkin extends pluginContract("gherkin", {
  stories: { params: StoriesParams, success: StoriesResult },
  step: { params: StepParams, success: StepView },
}) {}
```

`index.ts` uses these same Schemas for its `stories`/`step` methods. `package.json` exports `"./contract": "./src/contract.ts"`.

```ts
// scripts/build-plugins.ts
// Build zarg's own plugins for the runtime and record every first-party hash (zarg ships them).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bundleHash } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

const root = join(import.meta.dir, "..", "packages")
const FIRST_PARTY = ["plugin-gherkin", "plugin-rehearse"]
const only = process.argv[2]
for (const pkg of FIRST_PARTY.filter((p) => existsSync(join(root, p)) && (only === undefined || only === p))) {
  const r = await buildPlugin(join(root, pkg, "src/index.ts"))
  if (!r.ok) {
    console.error(`${pkg}:\n${r.errors.join("\n")}`)
    process.exit(1)
  }
  mkdirSync(join(root, pkg, "dist"), { recursive: true })
  writeFileSync(join(root, pkg, "dist/zarg-plugin.js"), r.bundle)
  writeFileSync(join(root, pkg, "dist/zarg-plugin.json"), `${JSON.stringify(r.manifest, null, 2)}\n`)
  console.error(`${pkg}: ${(r.bundle.length / 1024).toFixed(0)} KiB`)
}
// Every first-party bundle on disk, not only the ones built now.
const hashes = FIRST_PARTY.map((p) => join(root, p, "dist/zarg-plugin.js")).filter(existsSync).map((f) => bundleHash(readFileSync(f, "utf8")))
writeFileSync(join(root, "plugin/src/server/first-party-hashes.ts"), `// generated by scripts/build-plugins.ts — do not edit\nexport const KNOWN_FIRST_PARTY: ReadonlySet<string> = new Set(${JSON.stringify(hashes)})\n`)
```

`packages/plugin-gherkin/mise.toml` build: `run = "mise x -- bun ../../scripts/build-plugins.ts plugin-gherkin"`; delete `packages/plugin-gherkin/scripts/build.ts`. Root `mise.toml` gains `[tasks."build:plugins"] run = "mise x -- bun scripts/build-plugins.ts"`.

- [ ] **Step 6: Run the tests**

Run: `mise run -q build:plugins && cd packages/plugin-sdk && mise x -- bun test && cd ../plugin && mise x -- bun test && cd ../plugin-gherkin && mise x -- bun test`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

Run: `mise run verify` (Expected: PASS), then `git add -A packages scripts mise.toml && git commit -m "feat(plugins): typed contracts and pluginDependencies"`.

---

### Task 2: The service archetype and the Decisions, Models, Clock, Files.list and Agenda powers

**Files:**
- Modify: `packages/plugin-sdk/src/define.ts` (Scopes), `services.ts` (clients), `index.ts`; `packages/plugin/src/runtime/powers.ts`; `packages/plugin/src/server/host.ts` (`HostOptions`, agenda over every plugin with an `agenda` method, `Agenda.changed`); `packages/core/src/plugins.ts`, `live.ts` (host callbacks)
- Test: `packages/plugin/test/service-powers.test.ts`

**Interfaces:**
- Produces:
  - `Scopes.decisions?: boolean`, `Scopes.models?: ReadonlyArray<string>`, `Scopes.agents?: boolean`.
  - SDK services: `Decisions` (`decide(req)`), `Models` (`complete({ role, messages, outputSchema?, maxTokens? }) → { text, promptTokens, completionTokens }`), `Clock` (`now: Effect<number>`, `uuid: Effect<string>`), `Agenda` (`changed: Effect<void>`), `Files.list(dir) → string[]` (file names in a granted folder).
  - `HostOptions` gains `decide?`, `complete?` (role, messages, outputSchema, maxTokens), `agendaChanged?(plugin)`, `budget?(plugin) → { decisionsPerHour, tokensPerHour }`.
  - Power names: `decisions.decide`, `models.complete`, `clock.now`, `clock.uuid`, `agenda.changed`, `fs.list`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/plugin/test/service-powers.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fixturePlugin, hostWith } from "./fixtures"

const plugin = (scopes: string, body: string) => `
import { Effect, Schema } from "effect"
import { Agenda, Clock, Decisions, definePlugin, Models } from "@zarg/plugin-sdk"
export default definePlugin({ name: "svc", service: "Svc", archetype: "service", config: Schema.Struct({}), scopes: ${scopes},
  methods: { go: { doc: "go", params: Schema.Struct({}), success: Schema.Unknown, agents: true }, agenda: { doc: "a", params: Schema.Struct({}), success: Schema.Unknown } },
  make: Effect.gen(function* () { const d = yield* Decisions; const m = yield* Models; const c = yield* Clock; const a = yield* Agenda
    return { go: () => Effect.gen(function* () { ${body} }), agenda: () => Effect.succeed([{ id: "svc:1", title: "t", detail: "d", about: [], priority: 3 }]) } }) })`

describe("service powers", () => {
  test("decisions, models (declared roles only), clock and agenda.changed reach the host", async () => {
    const seen: Array<string> = []
    const out = await Effect.runPromise(hostWith([await fixturePlugin(plugin(`{ decisions: true, models: ["rehearse"] }`, `
      const x = yield* d.decide({ state: "s", questions: { q: { type: "noul", instructions: "i" } } })
      const y = yield* m.complete({ role: "rehearse", messages: [{ role: "user", content: "hi" }] })
      const t = yield* c.now
      yield* a.changed
      return { x, y: y.text, t: t > 0 }`))], (h) => h.invoke("svc", "go", {}), {
      decide: () => Effect.succeed({ q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }),
      complete: (role) => Effect.succeed({ text: `from ${role}`, promptTokens: 3, completionTokens: 2 }),
      agendaChanged: (p) => void seen.push(p),
    }))
    expect(out).toEqual({ x: { q: { type: "noul", answer: true, probability: 0.9, confidence: 0.5 } }, y: "from rehearse", t: true })
    expect(seen).toEqual(["svc"])
  })

  test("undeclared scopes and undeclared roles are refused; a spent budget is BudgetExceeded", async () => {
    const noScope = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{}`, `return yield* d.decide({ state: "s", questions: {} })`))], (h) => h.invoke("svc", "go", {}), { decide: () => Effect.succeed({}) })))
    expect(JSON.stringify(noScope)).toContain("decisions")
    const role = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{ models: ["rehearse"] }`, `return yield* m.complete({ role: "driver", messages: [] })`))], (h) => h.invoke("svc", "go", {}), { complete: () => Effect.succeed({ text: "", promptTokens: 0, completionTokens: 0 }) })))
    expect(JSON.stringify(role)).toContain("driver")
    const budget = await Effect.runPromise(Effect.exit(hostWith([await fixturePlugin(plugin(`{ decisions: true }`, `yield* d.decide({ state: "s", questions: {} }); return yield* d.decide({ state: "s", questions: {} })`))], (h) => h.invoke("svc", "go", {}), { decide: () => Effect.succeed({}), budget: () => ({ decisionsPerHour: 1, tokensPerHour: 1 }) })))
    expect(JSON.stringify(budget)).toContain("BudgetExceeded")
  })

  test("a service plugin's agenda reaches the host agenda", async () => {
    const items = await Effect.runPromise(hostWith([await fixturePlugin(plugin(`{}`, `return 1`))], (h) => h.agenda()))
    expect(items.map((i) => i.id)).toContain("svc:1")
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/plugin && mise x -- bun test test/service-powers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
- SDK `services.ts`: the four services as `Context.Service` classes over `power(raw, name, args)`; `servicesFrom` returns them; `define.ts` provides them in `serve`'s layer; `make`'s requirement union includes them. `Files` gains `list: (dir) => power<ReadonlyArray<string>>(raw, "fs.list", { dir })`.
- `powers.ts`: opts gain `decide?`, `complete?`, `agendaChanged?`, `budget: { decisionsPerHour: number; tokensPerHour: number }`. Powers:
  - `decisions.decide`: requires `manifest.scopes.decisions === true` (else `notGranted("… has no decisions scope")`), counts one call in a sliding hour window (else `{ tag: "BudgetExceeded" }`), then `opts.decide(req)`.
  - `models.complete`: requires `role` in `manifest.scopes.models ?? []` (else `notGranted("… may not use the model role <role>")`), checks the token window, calls `opts.complete`, adds `promptTokens + completionTokens`.
  - `clock.now`: `Date.now()`; `clock.uuid`: `crypto.randomUUID()` (no scope).
  - `agenda.changed`: `opts.agendaChanged?.()`, no scope.
  - `fs.list`: `checkedPath("fs-read", dir)` for the folder, then `readdirSync(dir)` files only, names only.
- `host.ts`: pass the new opts into `makePowers` (budget from `opts.budget?.(m.name) ?? DEFAULT_BUDGET`); `agenda` collects `agenda` from every running plugin that has the method (not only graph ones); `describeScopes` words: "use the decision model", "use the model roles …", "show agents".
- Core `plugins.ts`/`live.ts`: `HostOptions.decide` = the core's `Decisions.decide`; `complete` = `Model.stream` with `roles[role]` collecting text and usage; `agendaChanged` = `main.wake`; `budget` from `config.extra.plugins?.[name]?.budget`.

- [ ] **Step 4: Run the test**

Run: `cd packages/plugin && mise x -- bun test test/service-powers.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `mise run verify` (Expected: PASS); `git commit -m "feat(plugins): service archetype; Decisions, Models, Clock, Agenda and Files.list powers"`.

---

### Task 3: The Agents power: plugin agents in the agents pane

**Files:**
- Create: `packages/core/src/plugin-agents.ts`
- Modify: SDK `services.ts` (`Agents`), `powers.ts` (`agents.*`), `host.ts` (`HostOptions.agents`), `packages/core/src/plugins.ts`, `live.ts`
- Test: `packages/core/test/plugin-agents.test.ts`, `packages/plugin/test/service-powers.test.ts` (one case)

**Interfaces:**
- Produces:
  - SDK `Agents`: `start({ id, parent?, title, task }) / status({ id, progress?, text? }) / step({ id, text }) / end({ id, ok, message? })`, each `Effect<void, PluginFailure>`.
  - Power `agents.event` `{ event: "start" | "status" | "step" | "end", … }`; requires `scopes.agents === true`.
  - `HostOptions.agents?: (plugin: string, e: AgentEvent) => void`.
  - `pluginAgents(log: ThreadLog, threadId: string) → (plugin: string, e: AgentEvent) => void`: maps each plugin's events to `makeActivity(log, threadId, \`${threadId}-${plugin}-agents\`)` with ids `${plugin}:${id}` (and parents likewise), `step` → a transcript `step` line, `status` → the `status` RlmEvent.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/plugin-agents.test.ts
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { pluginAgents } from "../src/plugin-agents"

test("agent ids are namespaced and checked; events become main's activity in the plugin's stream and its history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zarg-pa-"))
  const log = await Effect.runPromise(makeLog(dir, (t) => t))
  const sink = pluginAgents(log, "main")
  sink("rehearse", { event: "start", id: "run", title: "rehearse", task: "run r-1" })
  sink("rehearse", { event: "start", id: "tester-1", parent: "run", title: "tester", task: "The developer" })
  sink("rehearse", { event: "step", id: "tester-1", text: "UX-0001: feel 1.80" })
  sink("rehearse", { event: "status", id: "tester-1", progress: { done: 1, total: 4 }, text: "1/4 steps" })
  expect(() => sink("rehearse", { event: "start", id: "a:b", title: "x", task: "y" })).toThrow("agent id")
  const events = readFileSync(join(dir, "main.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const paths = events.filter((e) => e.type === "ACTIVITY_DELTA").map((e) => [e.messageId, e.patch[0].path, e.patch[0].value.parent])
  expect(paths[0]).toEqual(["main-rehearse-agents", "/rlms/rehearse:run", null])
  expect(paths[1]).toEqual(["main-rehearse-agents", "/rlms/rehearse:tester-1", "rehearse:run"])
  expect(log.history("main", "rehearse:tester-1").map((l) => l.type)).toEqual(["start", "step"])
})
```

- [ ] **Step 2: Run to see it fail** — `cd packages/core && mise x -- bun test test/plugin-agents.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/plugin-agents.ts
import type { Rlm } from "@zarg/rlm"
import { makeActivity } from "./activity"
import type { ThreadLog } from "./log"

export type AgentEvent =
  | { readonly event: "start"; readonly id: string; readonly parent?: string; readonly title: string; readonly task: string }
  | { readonly event: "status"; readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  | { readonly event: "step"; readonly id: string; readonly text: string }
  | { readonly event: "end"; readonly id: string; readonly ok: boolean; readonly message?: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/

/** A plugin's agents in a thread's agents pane: their own stream, ids `<plugin>:<id>`, `step` lines as history. */
export const pluginAgents = (log: ThreadLog, threadId: string) => {
  const streams = new Map<string, ReturnType<typeof makeActivity>>()
  return (plugin: string, e: AgentEvent) => {
    if (!ID.test(e.id) || ("parent" in e && e.parent !== undefined && !ID.test(e.parent))) throw new Error(`agent id "${e.id}" must be letters, digits, dot, dash or underscore`)
    let a = streams.get(plugin)
    if (a === undefined) streams.set(plugin, (a = makeActivity(log, threadId, `${threadId}-${plugin}-agents`)))
    const id = `${plugin}:${e.id}`
    const ev: Rlm.RlmEvent =
      e.event === "start"
        ? { type: "start", id, parent: e.parent === undefined ? undefined : `${plugin}:${e.parent}`, preset: e.title, task: e.task, scope: {}, depth: e.parent === undefined ? 0 : 1, budget: { turns: 1, tokens: 0, wallMs: 0 } }
        : e.event === "status"
          ? { type: "status", id, ...(e.progress !== undefined ? { progress: e.progress } : {}), ...(e.text !== undefined ? { text: e.text } : {}) }
          : e.event === "step"
            ? { type: "step", id, turn: 0, text: e.text, cells: [] }
            : e.ok
              ? { type: "end", id, ok: true, turns: 1, tokens: 0 }
              : { type: "end", id, ok: false, kind: "result", message: e.message ?? "failed" }
    a.observe(ev)
  }
}
```

`makeActivity` receives prefixed ids already; the `start` event with a prefixed parent needs no `prefix` argument. SDK `Agents` over power `agents.event`; `powers.ts` checks `scopes.agents === true` and forwards to `opts.agents?.(event)`; host passes `agents: (e) => opts.agents?.(m.name, e)`; core wires `agents: pluginAgents(log, "main")` (the log exists before the host: construct the host options with a late-bound sink, as `ask` is).

- [ ] **Step 4: Run** — PASS. **Step 5:** `mise run verify`; commit `feat(plugins): the Agents power: plugin agents in the agents pane`.

---

### Task 4: Agent bodies and actions

**Files:**
- Modify: `packages/core/src/server.ts` (routes), `live.ts`, `main.ts`; `packages/plugin/src/server/host.ts` (nothing new: `invoke` covers `body`/`act`); `packages/client/src/client.ts`, `session.ts`; `packages/cli/src/tui/view.ts`, `app.tsx`
- Test: `packages/core/test/server.test.ts`, `packages/client/test/client.test.ts`, `packages/cli/test/view.test.ts`, `packages/cli/test/app.test.tsx`

**Interfaces:**
- Produces:
  - `Body = { parts: ReadonlyArray<BodyPart> }`, `BodyPart = { kind: "history"; lines?: TranscriptLine[] } | { kind: "lines"; lines: { text: string; tone?: "zarg" | "dim" | "error" | "accent" }[] } | { kind: "tabs"; tabs: { title: string; columns: string[]; rows: { id: string; cells: string[] }[] }[]; actions: { id: string; label: string; key: string }[] }` (in `@zarg/client` `state.ts`, re-exported).
  - `GET /threads/:id/agents/:agent/body` → `Body`: an `rlm-N` agent → `{ parts: [{ kind: "history", lines: log.history(thread, agent) }] }`; `<plugin>:<id>` → the plugin's `body({ agent: id })` with each `history` part's `lines` filled from `log.history(thread, agent)`; a plugin not loaded → 404 `{ error }`.
  - `POST /threads/:id/agents/:agent/actions/:action` `{ rows }` → the plugin's `act({ agent: id, action, rows })` → `{ notice }`.
  - Client `body(threadId, agent)`, `act(threadId, agent, action, rows)`; session `body(agent)`, `act(agent, action, rows)` (notice set on the session).
  - TUI: `Ui.viewing` stays; new `Ui.body?: { tab: number; row: number; selected: ReadonlyArray<string> }`; `bodyKeys(ui, body, key) → { ui, action? }`: ↑↓ row, Space toggle, Tab next tab (only while viewing), an action key → `{ type: "act", action, rows }`; Esc closes (as now). The old `history` endpoint and `historyView` stay for the `history` part.

- [ ] **Step 1: Write the failing tests** (server: an RLM body is its history; a plugin agent body comes from the plugin with its history filled; an action returns the plugin's notice; a gone plugin → 404. Client: `body` and `act` send the right requests. View: `bodyKeys` moves, selects, switches tabs and emits `{ type: "act", action: "apply", rows: [...] }` on `a`; a pending question still takes arrows and Enter (same rule as today). App frame: opening a plugin agent draws the history, the tab titles `Feedback | Likes`, the table rows with `[x]` marks, and the action hints `a Apply · d Dismiss`.) Write them in the files' existing styles, with a fake host plugin in the server test (`Layer.succeed(PluginHost, …)` stub whose `invoke` answers `body`/`act`).

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** the routes (`agent` param decoded; plugin name before the first `:`); the client and session methods; `view.ts` `bodyKeys` and a `bodyView(body, ui.body)` that returns lines (history via `historyView`, tables as padded columns with `▸` on the cursor row and `[x]`/`[ ]`), and `app.tsx` fetching the body instead of the history (refresh every second while open) and posting actions; the notice shows on the status line.

- [ ] **Step 4: Run; Step 5: verify and commit** `feat: agents draw their bodies; tables with actions on selected rows`.

---

### Task 5: The findings gate in the core

**Files:**
- Create: `packages/core/src/findings.ts`
- Modify: `packages/core/src/live.ts` (driver factory `Findings`), `packages/rlm/src/presets.ts` (driver layer: `Findings` in place of `Rehearse`), `packages/core/src/driver.ts` (unchanged `openFor`/`touched`)
- Test: `packages/core/test/findings.test.ts`

**Interfaces:**
- Consumes: `PluginHost.invoke`, `askFirst` (`openFor`, `touched`), `commitGraph` (moved from `rehearse/service.ts` into `findings.ts`).
- Produces: `FindingsDef` (`take({ plugin, finding }) → { id, card, notes }`, `resolve({ plugin, run, applied, dismissed }) → { commit? }`), `findingsService(ctx: { invoke: PluginHost["invoke"]; guard; stepNow; neighbors; commit }) : Bound`. The plugin's reserved `finding({ id })` answers `{ run, card, chosen, hash, notes } | null`; `resolved({ run, ids })` is told after the commit. Touched ids come from the guard's `onTouched`, and the core keeps them per `(plugin, run)` in `.zarg/findings/<plugin>-<run>.json` (gitignored), so a triage spread over driver items commits everything.

- [ ] **Step 1: Write the failing tests**: port `packages/core/test/rehearse-service.test.ts` to `findings.test.ts` against `findingsService` with a stub `invoke` answering `finding` (`chosen: false` → `NotChosen`; card gone or hash differs → `Stale`; writes scoped to card, states and added ids; `resolve` commits touched ids across two service instances sharing the same `.zarg/findings` dir and calls `resolved`), keeping the `commitGraph` git test.
- [ ] **Step 2:** fail. **Step 3:** implement (port of `rehearse/service.ts` with `invoke(plugin, "finding"|"resolved", …)` in place of the direct record calls). **Step 4:** pass. **Step 5:** verify, commit `feat(core): a findings gate for any plugin that reports findings`.

---

### Task 6: Plugin slash commands

**Files:**
- Modify: SDK `define.ts`/`manifest.ts` (`commands`), `packages/plugin/src/server/host.ts` (`commands()` list), `packages/core/src/server.ts` (`GET /commands`, `POST /plugins/:name/commands/:cmd`), `packages/client/src/client.ts`/`session.ts`, `packages/cli/src/tui/commands.ts`/`app.tsx`
- Test: `packages/plugin/test/service-powers.test.ts` (manifest carries commands), `packages/core/test/server.test.ts`, `packages/client/test/session.test.ts`, `packages/cli/test/commands.test.ts`

**Interfaces:**
- Produces: `PluginDef.commands?: ReadonlyArray<{ cmd: string; desc: string; method: string; arg: SlashArgSpec }>` (the method must exist; it answers `{ notice: string }`); `PluginHost.commands(): { plugin, cmd, desc, arg, method }[]`; `GET /commands` → that list; `POST /plugins/:name/commands/:cmd` `{ args: string[] }` → `{ notice }`; the TUI table = core commands + `/commands` (fetched at start); session `command()` routes a plugin command to the route.

- [ ] Steps: failing tests (a plugin command appears in the table with its hint; running it posts to the route and shows the notice; an unknown plugin command is the existing "unknown command" notice), fail, implement, pass, verify, commit `feat: plugins declare slash commands`.

---

### Task 7: The rehearse plugin

**Files:**
- Create: `packages/plugin-rehearse/` with `package.json` (`@zarg/plugin-rehearse`, deps `@zarg/plugin-sdk`, `@zarg/plugin-gherkin` for `./contract` only, `effect`), `mise.toml` (typecheck, test, build via `scripts/build-plugins.ts plugin-rehearse`), `tsconfig.json`, `bunfig.toml` (the `ZARG_USER_DIR` preload like the others), `src/index.ts`, and ported modules `src/{types,settings,screen,findings,triage,run,calibration}.ts`
- Move: `packages/core/src/rehearse/{types,screen,findings,triage,calibration}.ts` → plugin `src/` (unchanged except imports); `settings.ts` → the plugin's config Schema; `run.ts` → rewritten on powers (below); `packages/core/calibration/` and `scripts/calibrate-rehearse.ts` → the plugin package
- Delete: `packages/core/src/rehearse/`, core rehearse tests (moved), `RehearseControl`, `/rehearse` in the core's slash table, the rehearse wiring in `live.ts`/`main.ts`/`threads.ts` (`alsoStop` becomes: invoke `stop` on every loaded service plugin that has it)
- Test: `packages/plugin-rehearse/test/*.test.ts` (the moved tests, adapted), plus new ones below

**Interfaces:**
- Consumes: `Gherkin` contract; SDK `Decisions`, `Models`, `Agents`, `Clock`, `Agenda`, `Files`, `Config`.
- Produces: plugin `rehearse`, `archetype: "service"`, `service: "Rehearse"`, `pluginDependencies: [Gherkin]`, scopes `{ decisions: true, models: ["rehearse"], agents: true, fs: { read: [".zarg/rehearse/**", "intent/**"], write: [".zarg/rehearse/**"] } }`, config `{ auto_apply?: boolean, feel_below?, fail_at?, fork_below?, seam_below?, real_keep?, real_drop?, in_flight? }`, methods `run` (agents: true; `{ strategy?, focus?, personas? }` → started or `{ refused }`), `agenda`, `body`, `act`, `finding`, `resolved`, `stop`, and command `/rehearse` (method `command`, answers `{ notice }`).

- [ ] **Step 1: Move the pure modules and their tests** (`types`, `screen`, `findings`, `triage`, `calibration`, stories-free parts) into the plugin package; run their tests there: PASS unchanged (only import paths change).

- [ ] **Step 2: Write the failing run tests** by adapting `packages/core/test/rehearse-run.test.ts` to a `testPlugin` harness (`@zarg/plugin-sdk/tools` `testPlugin`) that serves the powers from stubs: `Decisions` (scripted), `Models` (stub), `Agents` (collected events), `Clock` (fixed now, counter uuid), `Files` (an in-memory map), `Config` (the settings), and the `Gherkin` contract (stories `[["A","B","C"],["A","B","D"]]`, step views). Keep every existing case (shared prefixes once, unscreened counted, resume from record, stop, one at a time, no testers refuses, unique personas, value-by-value redaction becomes "records hold no secret values the host redacts", progress only up, root row), with the agents pane assertions now on collected `Agents` events. Add:
  - "by default a finished run applies nothing; the tables list its findings; apply sends only the chosen ones to the agenda and calls Agenda.changed; finding() answers chosen" (from the stashed WIP test).
  - "dismissed findings stay dismissed on a rerun while the card is unchanged".
  - "auto_apply sends the decision model's local fixes to the agenda on its own".
  - "chosen findings survive a restart" (Review Focus 4: a new plugin instance over the same `Files` map still lists them).
  - "the tester's body is its history then Feedback and Likes tables; the run's body is the table over all testers".

- [ ] **Step 3: Implement the plugin**
  - `run.ts` keeps its structure; replace: `deps.stories`/`deps.step` → `gherkin.stories`/`gherkin.step`; `deps.decide` → `Decisions.decide`; `deps.model` → `Models.complete` (the `findings.ts` `textOf` helper takes a `complete` function); records via `Files.read`/`Files.write` under `.zarg/rehearse/` with an index file `index.json` (run ids) since there is no directory listing of records needed beyond it; dismissed in `.zarg/rehearse/dismissed.json`; `intent` via `Files.list("intent")` + `Files.read`; ids and times via `Clock`; `activity.observe` → `Agents.start/status/step/end` (ids `run`, `tester-N`); `announce` → the run's `status` text (no chat line); `wake` → `Agenda.changed`; `built` → dropped (the developer picks now; the route is a suggestion).
  - `index.ts`: `definePlugin` with the methods above; `body` and `act` as in the stashed WIP (`git stash show -p stash@{0}` has `body`, `act`, `chosen`, `isDismissed`, `rowsOf`); `finding({ id })` → `{ run, card, chosen, hash, notes } | null`; `resolved({ run, ids })` → marks resolved; `stop` interrupts the active run; `command({ args })` → parses `edge-pair|teleport` and `focus=` and calls `run`, answering `{ notice }`.
  - Core: the driver's `Findings` service (Task 5) asks `invoke("rehearse", "finding", …)`; `Rehearse.run` is the plugin's agent tool (the existing `pluginService` exposes it as `Rehearse.run`).
  - Build: `mise run build:plugins` builds both plugins and writes both hashes.

- [ ] **Step 4: Run the plugin's tests; delete the core's rehearse code and tests; run `mise run verify`.**

- [ ] **Step 5: Commit** `feat: rehearse is a plugin; the developer picks findings to apply`.

---

### Task 8: Calibration and docs

**Files:**
- Modify: root `mise.toml` (`calibrate:rehearse` runs `packages/plugin-rehearse/scripts/calibrate.ts`), `AGENTS.md` (packages list: `plugin-rehearse`, `build:plugins`), the rehearse spec's pointers (a line at the top: "moved into `@zarg/plugin-rehearse`; triage by the developer, see the service plugins spec")
- Test: `packages/plugin-rehearse/test/calibration.test.ts` (moved)

- [ ] Steps: move the calibration script to the plugin package (it runs `screenStep` with the live `Decisions` layer from the core, as before); update `mise.toml` and `AGENTS.md`; run `mise run verify`; commit `docs: plugin-rehearse, build:plugins, calibration path`.

---

## Deviations from the spec (for review)

- **No chat line when a run ends:** plugins cannot post messages; the run's row says the result ("7 findings to review"), and applied findings reach the driver through the agenda. A `Say` power can come later.
- **`built` (the "card has code" check) is dropped:** a plugin cannot run `git grep`, and with the developer picking findings the route is only a suggestion.
- **Clock power:** the plugin sandbox has no clock or randomness (SES), so `Clock.now`/`Clock.uuid` are host powers; the spec did not list them.
- **`Files.list`:** added to read `intent/*.md` without knowing file names.
