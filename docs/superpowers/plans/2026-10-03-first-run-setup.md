# First-Run Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zarg works in any project. The first run asks you to set up or log in to a provider, then to pick a default model that every role without its own uses. `/login` and `/models` reopen the same Setup view.

**Architecture:**
- **Config:** `config.roles` becomes a live object: a role's own model, else `roles.default`. It is updated in place when config reloads, so every reader (the RLM, decisions, plugin `complete`) sees new choices without a restart.
- **Env:** loads the provider schemas and `~/.config/zarg/` in any project.
- **Setup service:** the core runs one (`core/src/setup.ts`) that serves a core-owned view as agent `core:setup`, through the same events as plugin agents. Its acts write secrets with varlock (`Secrets.set`) and edit `~/.config/zarg/config.toml` with a line-preserving writer.

**Tech Stack:** Bun, Effect 4, varlock, `@zarg/view` (sections), OpenTUI (view-tui), bun test.

**Spec:** `docs/superpowers/specs/2026-10-03-first-run-setup-design.md`

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never print, log or commit a secret value. Tests use variable names unique to each test and temp user dirs, never `~/.config/zarg`.
- Secrets are written only through `Secrets.set` (varlock device-bound encryption). Plain values go through `Secrets.setPlain`.
- Don't start a zarg core in the repo root. Tests use temp dirs.
- Words: "the operator", "default model", "provider", "role".

## Review Focus

1. **A project with its own `[roles] driver`** (zarg-v2 itself): its own choice still wins over `roles.default`. Covered by Task 1's fallback test.
2. **Restart after setup.** A fresh core reads `~/.config/zarg/config.toml` and has a driver, so it opens no Setup view. Covered by Task 6's "already set up" test.
3. **A typed key that is wrong.** `verify` fails; the provider row shows "the key was refused"; the value stays saved (encrypted) for you to fix; no default is set. Covered by Task 6's failed-login test.
4. **A user config written by hand, with comments.** The writer changes only `roles.default` and missing `[providers.X]` sections. Covered by Task 1's writer test.
5. **A secret in the thread log.** Act text is not logged today. The log's redactor must also learn secrets added after the core started. Covered by Task 6's redaction test.

---

## File Structure

- `packages/model/src/config.ts`: `KNOWN` gains `plugins` and `agents`; live roles with the default fallback; `reload(config, opts)`; `setUserConfig(file, edit)`, the line-preserving TOML writer.
- `packages/model/src/env.ts`: `layer(projectDir, opts?: { userDir?, schemas? })` loads every entry that exists.
- `packages/model/src/provider.ts`: `Provider.settings`, the `[providers.X]` template login writes.
- `packages/model/src/model.ts`: an optional `reconnect` on the service.
- `packages/provider-openrouter/src/index.ts` and `packages/provider-zarg-router/src/index.ts`: `settings`.
- `packages/core/src/live.ts`:
  - env with the user dir and the provider schemas;
  - plugin `complete` with no silent stub;
  - `sensitive` refreshable;
  - the setup service wired;
  - `core` as a pseudo-plugin for the setup view's layout, surface and acts.
- `packages/core/src/actions.ts`: `local` handlers for agents of a pseudo-plugin.
- `packages/core/src/setup.ts` (new): the setup service and its view.
- `packages/core/src/server.ts`: `POST /setup/open {at?: "providers" | "models"}`.
- `packages/client/src/client.ts` and `session.ts`: `setup(at)`, and the `/login` and `/models` commands.
- `packages/view/src/schema.ts`, `behaviour.ts`, and `packages/view-tui/src/sections.tsx`: a table row's `secret` masks the input its action opens.
- `packages/rlm/src/rlm.ts`, `packages/decisions/src/index.ts`, `packages/core/src/phases.ts`: the not-set-up messages point at `/models`.

---

### Task 1: Config — the default model, live roles, reload, and the writer

**Files:**
- Modify: `packages/model/src/config.ts`
- Test: `packages/model/test/config.test.ts` (append; create it if missing, following the package's existing test style: `grep -ln "Config.load\|config" packages/model/test/*.ts`)

**Interfaces:**
- Produces:
  - `ZargConfig.roles`: a live object. `roles[r]` is `own[r] ?? own.default`; `Object.keys` lists own keys only.
  - `reload(config, opts) → Effect<void, ConfigError, Env | FileSystem | Path>`: re-reads and updates `config.providers`, `config.roles` and `config.extra` in place.
  - `setUserConfig(file, edit) → Effect<void, ConfigError, FileSystem>`, where `edit = { readonly default?: string; readonly provider?: { readonly name: string; readonly settings: Readonly<Record<string, string>> } }`. It writes `roles.default`, and `[providers.<name>]` only when that section is missing. Comments and everything else stay. The write is atomic.
  - `roleModel` falls back to `roles.default` (via live roles), and its message becomes `no model for role "<r>" (set a default with /models)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Config, layerTest as envTest } from "../src"

const dirs = () => {
  const userDir = mkdtempSync(join(tmpdir(), "zt-cfg-user-"))
  const projectDir = mkdtempSync(join(tmpdir(), "zt-cfg-proj-"))
  mkdirSync(join(projectDir, ".zarg"), { recursive: true })
  return { userDir, projectDir }
}
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(e.pipe(Effect.provide(Layer.merge(envTest({}), BunServices.layer))) as Effect.Effect<A, E>)

describe("the default model", () => {
  test("a role without its own model uses roles.default; a project's own role wins; keys list only set roles", async () => {
    const d = dirs()
    writeFileSync(join(d.userDir, "config.toml"), '[roles]\ndefault = "zarg-router:big"\n')
    writeFileSync(join(d.projectDir, ".zarg", "config.toml"), '[roles]\ndriver = "zarg-router:small"\n')
    const c = await run(Config.load(d))
    expect([c.roles.driver, c.roles.plan, c.roles.rehearse]).toEqual(["zarg-router:small", "zarg-router:big", "zarg-router:big"])
    expect(Object.keys(c.roles).sort()).toEqual(["default", "driver"])
  })
  test("with no default, an unset role is undefined, and roleModel says to set a default with /models", async () => {
    const c = await run(Config.load(dirs()))
    expect(c.roles.driver).toBeUndefined()
    expect((await Effect.runPromise(Effect.flip(Config.roleModel(c, "driver")))).message).toBe('no model for role "driver" (set a default with /models)')
  })
  test("[plugins] and [agents] load", async () => {
    const d = dirs()
    writeFileSync(join(d.projectDir, ".zarg", "config.toml"), '[agents]\nttl = "off"\n[plugins.triage]\nworkers = 3\n')
    const c = await run(Config.load(d))
    expect(c.extra.agents).toEqual({ ttl: "off" })
  })
  test("reload updates the same config object in place", async () => {
    const d = dirs()
    const c = await run(Config.load(d))
    writeFileSync(join(d.userDir, "config.toml"), '[roles]\ndefault = "zarg-router:big"\n')
    await run(Config.reload(c, d))
    expect(c.roles.driver).toBe("zarg-router:big")
  })
})

describe("the user config writer", () => {
  test("sets roles.default and adds a missing provider section; comments and other content stay; an existing provider section is left alone", async () => {
    const d = dirs()
    const file = join(d.userDir, "config.toml")
    writeFileSync(file, '# my zarg\n[providers.zarg-router]\nbase_url = "${ZARG_ROUTER_URL}"  # local\n\n[roles]\ndefault = "zarg-router:old"\nplan = "zarg-router:p"\n')
    await run(Config.setUserConfig(file, { default: "openrouter:x", provider: { name: "openrouter", settings: { base_url: "${OPENROUTER_URL}", api_key: "${OPENROUTER_API_KEY}" } } }))
    await run(Config.setUserConfig(file, { provider: { name: "zarg-router", settings: { base_url: "${OTHER}" } } }))
    expect(readFileSync(file, "utf8")).toBe(
      '# my zarg\n[providers.zarg-router]\nbase_url = "${ZARG_ROUTER_URL}"  # local\n\n[roles]\ndefault = "openrouter:x"\nplan = "zarg-router:p"\n\n[providers.openrouter]\nbase_url = "${OPENROUTER_URL}"\napi_key = "${OPENROUTER_API_KEY}"\n',
    )
  })
  test("a missing file gets a [roles] section", async () => {
    const d = dirs()
    const file = join(d.userDir, "sub", "config.toml")
    await run(Config.setUserConfig(file, { default: "zarg-router:big" }))
    expect(readFileSync(file, "utf8")).toBe('[roles]\ndefault = "zarg-router:big"\n')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/model && mise x -- bun test test/config.test.ts`
Expected: FAIL. `c.roles.plan` is undefined, `reload` and `setUserConfig` don't exist, and `[agents]` is an unknown section.

- [ ] **Step 3: Implement** (`packages/model/src/config.ts`)

- `const KNOWN = new Set(["providers", "roles", "rlm", "reconcile", "plugins", "agents"])`.
- Live roles:
```ts
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
const setters = new WeakMap<ZargConfig, (next: ZargConfig) => void>()
```
- In `decode`, return the config built through a helper that wires the setter:
```ts
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
```
  `decode`'s last line becomes `return live(providers, roles, extra)`.
- `reload`:
```ts
/** Re-read both config files and update this config object in place (every holder sees the change). */
export const reload = (config: ZargConfig, opts: { readonly userDir: string; readonly projectDir: string }) =>
  Effect.flatMap(load(opts), (next) => Effect.sync(() => setters.get(config)?.(next)))
```
  `next.roles` is a live proxy; spreading it with `{ ...next.roles }` copies only the own keys, which is what `set` needs.
- `roleModel`'s message: `` `no model for role "${role}" (set a default with /models)` ``.
- The writer:
```ts
/** Edit the user config: `roles.default`, and a provider section only when missing. Other lines stay as they are; the write is atomic. */
export const setUserConfig = (file: string, edit: { readonly default?: string; readonly provider?: { readonly name: string; readonly settings: Readonly<Record<string, string>> } }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const io = (e: { message: string }) => new ConfigError({ message: e.message, file })
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
    let lines = exists ? (yield* fs.readFileString(file).pipe(Effect.mapError(io))).replace(/\n$/, "").split("\n") : []
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
```
  The test's expected text keeps the blank line that was already before `[roles]`. A trailing blank line before the appended provider section is collapsed to one blank line; check the exact output against the test and adjust the blank-line handling, not the test.

- [ ] **Step 4: Run them and watch them pass**

Run: `cd packages/model && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
Expected: PASS (the old model tests too).

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/model && git commit -m "feat(model): a default model for every role without its own; config reloads in place; a user-config writer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
If verify fails elsewhere because a test expected the old `roleModel` message or an unset role, update those expectations to the new message and record each one in the ledger.

---

### Task 2: Env in any project

**Files:**
- Modify: `packages/model/src/env.ts` (`loadSnapshot`, `layer`)
- Modify: `packages/core/src/live.ts:358` (the env layer's options)
- Test: `packages/model/test/env.test.ts` (append; find the existing env tests with `grep -ln "layer(" packages/model/test/*.ts`)

**Interfaces:**
- Produces: `layer(projectDir, opts?: { readonly userDir?: string; readonly schemas?: ReadonlyArray<string> })`. The entries, in order:
  1. each schema file's directory;
  2. `userDir`, when it holds an `.env.schema`;
  3. `projectDir`, when it holds an `.env.schema`.

  When there is no entry at all, the snapshot is empty and nothing fails.

- [ ] **Step 1: Write the failing test**

```ts
test("a project without .env.schema sees the provider schemas and the user dir's values; the project's own schema still wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "zt-env-"))
  const prov = join(root, "prov"), user = join(root, "user"), proj = join(root, "proj"), proj2 = join(root, "proj2")
  for (const d of [prov, user, proj, proj2]) mkdirSync(d, { recursive: true })
  writeFileSync(join(prov, ".env.schema"), "# @defaultRequired=false\n---\n# @type=url\nZT_ENV_TEST_URL=http://default.invalid\n")
  writeFileSync(join(user, ".env.schema"), "# @defaultRequired=false\n---\n")
  writeFileSync(join(user, ".env.local"), "ZT_ENV_TEST_URL=http://user.invalid\n")
  writeFileSync(join(proj2, ".env.schema"), "# @defaultRequired=false\n---\nZT_ENV_TEST_URL=http://project.invalid\n")
  const get = (projectDir: string) => Effect.runPromise(Effect.flatMap(Env, (e) => e.lookup("ZT_ENV_TEST_URL")).pipe(Effect.provide(layer(projectDir, { userDir: user, schemas: [join(prov, ".env.schema")] }))))
  expect(await get(proj)).toBe("http://user.invalid")
  expect(await get(proj2)).toBe("http://project.invalid")
})
```
Check varlock's precedence rule once (later entry files win; `.env.local` beside a schema overrides that schema). If the run shows a different order, keep the spec's intent (user values over provider defaults, project over user) by ordering the entries, and record the observed rule in the ledger.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/model && mise x -- bun test test/env.test.ts`
Expected: FAIL (`layer` ignores its second argument; the project has no schema, so loading errors or `lookup` is undefined).

- [ ] **Step 3: Implement**

```ts
const entries = (projectDir: string, opts: { readonly userDir?: string; readonly schemas?: ReadonlyArray<string> }) => [
  ...new Set((opts.schemas ?? []).map((f) => dirname(f))),
  ...(opts.userDir !== undefined && existsSync(join(opts.userDir, ".env.schema")) ? [opts.userDir] : []),
  ...(existsSync(join(projectDir, ".env.schema")) ? [projectDir] : []),
]
```
`loadSnapshot(paths: ReadonlyArray<string>)` passes `entryFilePaths: [...paths]`. With no paths it returns an empty snapshot (`{ values: new Map(), fields: new Map(), sensitive: [] }`) without calling varlock. `layer(projectDir, opts = {})` computes the entries at every load and reload, so a user `.env.schema` created after start is picked up.

Login writes `.env.local` into the user dir, and varlock needs a schema next to it. So the setup service (Task 6) creates `<userDir>/.env.schema` with the header `# @defaultRequired=false\n---\n` when it is missing, and this layer then picks it up on reload.

`live.ts:358`: `envLayer(root, { userDir: join(homedir(), ".config", "zarg"), schemas: [zargRouter.schemaFile, openrouter.schemaFile] })`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/model && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && cd ../core && mise x -- bunx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/model packages/core && git commit -m "feat(model): env in any project: the provider schemas and ~/.config/zarg, then the project's own

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Providers say what config they need; the model service reconnects

**Files:**
- Modify: `packages/model/src/provider.ts` (`Provider.settings`)
- Modify: `packages/model/src/model.ts` (`reconnect`)
- Modify: `packages/provider-openrouter/src/index.ts`, `packages/provider-zarg-router/src/index.ts`
- Test: `packages/model/test/model.test.ts` (append; find it with `grep -ln "Model.make\|make(" packages/model/test/*.ts`)

**Interfaces:**
- Produces:
  - `Provider.settings: Readonly<Record<string, string>>`, its `[providers.X]` template:
    - openrouter: `{ base_url: "${OPENROUTER_URL}", api_key: "${OPENROUTER_API_KEY}" }`;
    - zarg-router: `{ base_url: "${ZARG_ROUTER_URL}" }`.
  - Model service: `readonly reconnect?: Effect.Effect<void, ConfigError>`. It connects every provider that now has a `[providers.X]` section in the (live) config, drops the ones that lost theirs, and clears the model-list cache.

- [ ] **Step 1: Write the failing test**

```ts
test("reconnect picks up a provider configured after start, from the same live config", async () => {
  const fake: Provider = { name: "fake", envKeys: [], schemaFile: "/dev/null", settings: { base_url: "x" }, connect: () => Effect.succeed({ models: Effect.succeed([]), verify: Effect.void, stream: () => Stream.empty } as never) }
  const config = { providers: {} as Record<string, Record<string, string>>, roles: {}, extra: {} }
  const out = await Effect.runPromise(Effect.gen(function* () {
    const m = yield* Model.make([fake], config)
    const before = yield* Effect.flip(m.client("fake"))
    config.providers.fake = { base_url: "x" }
    yield* m.reconnect!
    return { before: before.message, after: yield* Effect.map(m.client("fake"), () => "connected") }
  }))
  expect(out).toEqual({ before: 'provider "fake" is not configured; add [providers.fake] to .zarg/config.toml', after: "connected" })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/model && mise x -- bun test test/model.test.ts -t reconnect`
Expected: FAIL (`reconnect` is undefined; `settings` is not on `Provider`, a type error).

- [ ] **Step 3: Implement**

- `provider.ts`: add `/** The \`[providers.<name>]\` section login writes when it is missing. */ readonly settings: Readonly<Record<string, string>>` to `Provider`, and the two providers' values as above.
- `model.ts` `make`: move the connect loop into `const connectAll = Effect.gen(function* () { clients.clear(); cache.clear(); for (const p of providers) { const s = config.providers[p.name]; if (s !== undefined) clients.set(p.name, yield* p.connect(s)) } })`, run it once at make, and return `reconnect: connectAll`. Add the optional `reconnect` to the service's type.
- Add `settings` to every other `Provider` value the typecheck finds (test fakes included).

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/model && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && for p in provider-openrouter provider-zarg-router; do (cd ../$p && mise x -- bunx tsc --noEmit -p . && mise x -- bun test); done`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/model packages/provider-openrouter packages/provider-zarg-router && git commit -m "feat(model): providers name their config section; the model service reconnects after a login

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: No silent stub; messages point at /models

**Files:**
- Modify: `packages/core/src/live.ts:374` (plugin `complete`)
- Modify: `packages/rlm/src/rlm.ts:193-194`
- Modify: `packages/decisions/src/index.ts:230`
- Modify: `packages/core/src/phases.ts:61-62`
- Test: `packages/core/test/phases.test.ts` (the reconcile gate's reason), `packages/rlm/test/*` (the run's error), `packages/decisions/test/decisions.test.ts`

**Interfaces:**
- Produces these messages:
  - RLM: `` `no model for role "${preset.role}" (set a default with /models)` ``;
  - decisions: `no decision model (set a default with /models)`;
  - reconcile gate: `plan and implement are off: set a default model with /models (or roles.plan and roles.implement)`;
  - plugin `complete` with no model: a failure with `` `no model for role "${req.role}" (set a default with /models)` ``, never `STUB_MODEL`.

- [ ] **Step 1: Write the failing tests.** For each message, find the existing test that asserts the old text (`grep -rn 'set roles\.' packages/*/test | head`) and change its expectation to the new one. For plugin `complete`, add to `packages/core/test/plugins.test.ts`, or the test that covers `liveLayer`'s `complete` (`grep -rln "complete" packages/core/test`), a case with no roles at all: `complete({ role: "rehearse", messages: [] })` fails with `no model for role "rehearse" (set a default with /models)`. If no test reaches `liveLayer`'s `complete`, extract it as `export const completeWith = (roles, model) => (req) => …` in `live.ts` and test that directly.
- [ ] **Step 2: Run them and watch them fail** with the old messages.
- [ ] **Step 3: Implement** the messages. In `live.ts`'s `complete`: `const ref = roles[req.role]; if (ref === undefined) return yield* Effect.fail(new ModelError({ kind: "config", message: \`no model for role "${req.role}" (set a default with /models)\` }))` (import `ModelError` from `@zarg/model`). `roles.driver` is no longer needed as a fallback: the live roles fall back to `default` already.
- [ ] **Step 4: Run them and watch them pass**: `mise x -- bun test` in core, rlm and decisions.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/core packages/rlm packages/decisions && git commit -m "fix: no model means a clear message pointing at /models, never the stub model

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: A secret row masks its input

**Files:**
- Modify: `packages/view/src/schema.ts:46` (`TableData` row `secret`)
- Modify: `packages/view/src/behaviour.ts:27,378` (`input.secret`; no prefill for a secret row)
- Modify: `packages/view-tui/src/sections.tsx:152-162` (`InputField` masks)
- Test: `packages/view/test/behaviour.test.ts`, `packages/view-tui/test/sections.test.tsx`

**Interfaces:**
- Produces:
  - A table row may carry `secret: true`.
  - `pressAction` on such a row opens `ui.input` with `secret: true` and an empty text (it never prefills from the row).
  - The TUI draws the typed text as `•` repeated, one per character.

- [ ] **Step 1: Write the failing tests**

`behaviour.test.ts` (next to the existing `pressAction` input test; find it with `grep -n "input" packages/view/test/behaviour.test.ts | head`):
```ts
test("an action on a secret row opens a secret input, never prefilled", () => {
  const layout = layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "name", label: "name" }], actions: [{ id: "set", label: "Set", key: "s", on: "row", input: "the value" }] } }))
  const view = { layout, data: { list: { rows: [{ id: "K", cells: { name: "K" }, text: "old", secret: true }] } } } as never
  const r = pressAction(view, {} as never, "list", "set", ["K"])
  expect(r.ui.input).toEqual({ section: "list", action: "set", rows: ["K"], text: "", placeholder: "the value", secret: true })
})
```
`sections.test.tsx`: render an `InputField` (or a table whose `ui.input` is secret) with `text: "sk-or-abc"`, and assert the frame contains `•••••••••` and not `sk-or-abc`. Copy the render helper the file already uses for `InputField` or a table section.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - schema: add `secret: Schema.optionalKey(Schema.Boolean)` to the table row struct.
  - behaviour: `input?: { …; readonly secret?: boolean }`. In `pressAction`: `const secret = (row as { secret?: boolean } | undefined)?.secret === true` and `input: { section, action, rows, text: secret ? "" : (row?.text ?? ""), placeholder: a.input, ...(secret ? { secret: true } : {}) }`.
  - `InputField`: `const shown = (p.input.secret === true ? "•".repeat(p.input.text.length) : p.input.text).slice(-room)`, and keep the empty case.
- [ ] **Step 4: Run them and watch them pass**: `cd packages/view && mise x -- bun test && mise x -- bunx tsc --noEmit -p . && cd ../view-tui && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/view packages/view-tui && git commit -m "feat(view): a secret row's input is masked and never prefilled

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The setup service, its view, `/login` and `/models`

**Files:**
- Create: `packages/core/src/setup.ts`
- Modify: `packages/core/src/actions.ts` (`local` handlers by pseudo-plugin)
- Modify: `packages/core/src/live.ts`:
  - `let sensitive`, refreshed after a login, for the log's redactor;
  - `layoutOf`, `surfaceOf` and `surfacesOf` answer for plugin `core`;
  - the setup service made and opened at start when needed;
  - `setup` returned from `liveCore`.
- Modify: `packages/core/src/server.ts` (`POST /setup/open`) and its control interface (where `turnOn` and `yolo` are exposed)
- Modify: `packages/client/src/client.ts` (`setup(at)`), `packages/client/src/session.ts` (`/login`, `/models`), `packages/view-tui/src/commands.ts` (two `SLASH_COMMANDS` entries)
- Test: `packages/core/test/setup.test.ts` (new); `packages/client/test/session.test.ts` (append)

**Interfaces:**
- Produces from `setup.ts`:
```ts
export interface SetupDeps {
  readonly providers: ReadonlyArray<Provider>
  readonly env: Env["Service"]
  readonly secrets: Secrets.Secrets["Service"]
  readonly config: Config.ZargConfig
  readonly reloadConfig: Effect.Effect<void, unknown>
  readonly writeUserConfig: (edit: Parameters<typeof Config.setUserConfig>[1]) => Effect.Effect<void, unknown>
  readonly ensureUserSchema: Effect.Effect<void, unknown>
  readonly model: Model.Model["Service"]
  readonly agentEvents: (plugin: string, event: unknown) => void
  readonly secretsChanged: Effect.Effect<void>
}
export const SETUP_LAYOUT: Layout
export const SETUP_SURFACE: Surface   // { kind: "sheet", name: "setup", view: "setup", … } (check the sheet surface's fields in @zarg/view's Surface schema)
export const makeSetup: (d: SetupDeps) => {
  readonly needed: Effect.Effect<boolean>          // the driver resolves to no model, or its provider does not verify
  readonly open: (at?: "providers" | "models") => Effect.Effect<void>
  readonly act: (action: string, rows: ReadonlyArray<string>, text: string | undefined) => Effect.Effect<{ readonly notice: string }>
}
```
- The view's sections:
  - `summary`: text.
  - `providers`: a table. Columns `provider` and `state`; action `login` (`⏎`, default).
  - `fields`: a table for the provider being logged in. One row per env key, `secret: true` for sensitive ones, `text` holding the current non-secret value. Action `set` (`⏎`, input "the value"); view action `done` ("Check and save", key `c`).
  - `models`: a table, `search: true`. Columns `model` and `about`; action `default` (`⏎`).

**Behaviour:**
- **`open(at)`:**
  1. Ensure the agent: `agentEvents("core", {event: "start", id: "setup", title: "setup", view: "setup", task: "Set up a model provider and the default model"})`.
  2. Fill all sections from current state (`render`).
  3. Open the sheet: `agentEvents("core", {event: "open", surfaces: [{surface: "setup", agent: "setup", focus: true}], gesture: true})`.

  `at` only decides which section the summary says to start from (a hint line); both tables are always there.
- **State per provider:**
  - `◇ not set up`: `config.providers[name]` is missing, or a required env key has no value.
  - Otherwise `verify` decides: `✓ reachable · N models` (`model.list(name)`), or `✗ <why>`.
  - Reasons from the error's message: 401/403 → "the key was refused"; a refused connection or fetch failure → "is it running?"; 404 → "check its URL"; else the message's first line.
- **`act("login", [provider])`:** select that provider; fill `fields` from `env.fields(provider.envKeys)` (the description, `required`, `sensitive`, and the current plain value via `env.lookup` when not sensitive).
- **`act("set", [VAR], text)`:**
  1. `ensureUserSchema`.
  2. Sensitive (from `env.fields`): `secrets.set(VAR, Redacted.make(text))`; else `secrets.setPlain(VAR, text)`. `Secrets` reloads env itself.
  3. Then `secretsChanged`, which refreshes the log redactor's list.
  4. Notice: `` `${VAR} saved` ``. The value never goes into the notice.
- **`act("done")`:** for the selected provider:
  1. `writeUserConfig({ provider: { name, settings: provider.settings } })`;
  2. `reloadConfig`, then `model.reconnect`;
  3. verify.
  4. Notice: `` `${name}: reachable, ${n} models` `` or `` `${name}: ${why}` ``.
  5. Re-render.
- **`act("default", [ref])`:**
  1. `writeUserConfig({ default: ref })`, then `reloadConfig`.
  2. Notice: `` `default model: ${ref}` ``.
  3. Re-render.
  4. When `needed` is now false, close the sheet with `agentEvents("core", {event: "close", surface: "setup", id: "setup"})`.
- **Models listed:** every reachable provider's `model.list`, as `provider:id`. `about` shows the context length (`128k`) and its capabilities joined by spaces.

**Wiring in `live.ts`:**
- `actions.ts` `makeActions` gains `local?: Readonly<Record<string, (agent: string, action: string, rows: ReadonlyArray<string>, text?: string) => Effect.Effect<{ readonly notice: string }>>>`. `act` checks `deps.local?.[o.plugin]` before `opensOf` and `invoke`.
- `layoutOf("core", "setup")` returns `SETUP_LAYOUT`. `surfaceOf("core", "setup")` returns `SETUP_SURFACE`. `surfacesOf("core")` returns `[SETUP_SURFACE]`.
- `const secrets = yield* Effect.provide(Secrets.Secrets, Secrets.layer(USER_DIR)…)`: build the service from `Secrets.layer(join(homedir(), ".config", "zarg"))` with env, fs and path from the core's context.
- Make `sensitive` a `let`. `secretsChanged` re-reads `env.sensitive` into it. The log's redactor is `(t) => redact(t, sensitive)` and reads the variable at call time.
- After plugins load: `if (yield* setup.needed) yield* setup.open("providers")`.
- `server.ts`: `POST /setup/open` with body `{ at?: "providers" | "models" }` calls `control.setup.open(at)` and answers `{ notice: "opened" }`. Expose `setup` the way `turnOn` is exposed (follow `/reconcile`'s path through the control service).

**Client:**
- `client.setup(at) => Effect<{ notice }>`, `POST /setup/open`.
- In `session.command`, before the plugin lookup: `/login` → `setup("providers")`, `/models` → `setup("models")`, with the notice set the same way as `/yolo`.
- The unknown-command hint gains them: `(try /reconcile, /yolo, /login or /models)`.
- `SLASH_COMMANDS` gains `{ cmd: "/login", desc: "set up or log in to a model provider" }` and `{ cmd: "/models", desc: "pick the default model" }`. Match the existing entries' fields: `grep -n "/reconcile" packages/view-tui/src/commands.ts`.

- [ ] **Step 1: Write the failing tests** (`packages/core/test/setup.test.ts`)

Use fakes: a provider `fake` with `envKeys: ["ZT_SETUP_KEY", "ZT_SETUP_URL"]`, `settings: { base_url: "${ZT_SETUP_URL}", api_key: "${ZT_SETUP_KEY}" }`, and a `connect` whose `verify` fails while `ZT_SETUP_KEY !== "good"` (it reads the value from settings).
- `env`: `layerTest` with a field map where `ZT_SETUP_KEY` is sensitive and required and `ZT_SETUP_URL` is not.
- `secrets`: an in-memory `Secrets` that records `set`/`setPlain` calls and updates the test env's values.
- `config`: a live config built with `Config.load` over temp dirs.
- `writeUserConfig`: `Config.setUserConfig` on a temp file.
- `agentEvents`: records events.

```ts
test("not set up: needed, and open starts the core:setup agent and its sheet", …)            // events: start, set summary/providers/fields/models, open setup
test("login: fields come from the env schema, secret rows marked; set stores a secret with Secrets.set and a URL with setPlain; no value in any notice or event", …)
test("done with a refused key: the provider row says the key was refused; no default; values kept", …)
test("done with a good key, then default: roles.default written, needed is false, the sheet closes", …)
test("already set up (a default whose provider verifies): needed is false", …)
test("log redaction: a secret saved after start is redacted from text appended to the thread log", …)  // through live's redactor: refresh then redact
```
Write each test fully in the file. Assert on recorded events, `readFileSync(userConfig)`, the notices, and that `JSON.stringify(events)` never contains the secret value. Seed `"good"` and `"wrong-one"` as the test's key values.

`packages/client/test/session.test.ts`: `/models` calls `client.setup("models")` and `/login` calls `client.setup("providers")`. Use the fake client pattern the file already uses for `/yolo`.

- [ ] **Step 2: Run them and watch them fail** (`../src/setup` is not found).
- [ ] **Step 3: Implement** `setup.ts` as specified, then the wiring.
- [ ] **Step 4: Run them and watch them pass**: `cd packages/core && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`, and the same in client and view-tui.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/core packages/client packages/view-tui && git commit -m "feat(core): first-run setup: providers, then the default model; /login and /models

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Docs and a check in a fresh project

**Files:**
- Modify: `AGENTS.md`: the `packages/core` bullet gains the Setup view (`core:setup`, `/login`, `/models`, `roles.default` in `~/.config/zarg/config.toml`); the `packages/model` bullet gains `roles.default`, live roles and `setUserConfig`.
- Modify: `docs/roadmap.md`, if it lists "/models" or login as future work (`grep -n "models\|login" docs/roadmap.md`): mark it done.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Commit:
```bash
mise run verify && git add AGENTS.md docs/roadmap.md && git commit -m "docs: first-run setup, /login and /models

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
- [ ] **Step 3:** Ask the operator to try it in `~/Git/minecraft-test-2`:
  1. run `zarg core stop`, then `zarg`;
  2. the Setup sheet should open;
  3. log in to zarg-router with its URL (or openrouter with a key);
  4. pick a default;
  5. zarg's conversation should start.

  Don't run it yourself: it needs their models and their core.

---

## Self-Review

- **Spec coverage:**
  - Settings and fallback: Tasks 1, 3, 4.
  - Env in any project: Task 2.
  - Setup view, opening, acts, `/login` and `/models`: Tasks 5 and 6.
  - Before setup is done: Task 4's messages and Task 6's auto-open.
  - Secrets: Tasks 5 and 6.
  - Tests: every task.
- **Rulings (deviations from the spec's words):**
  - **Runs fail instead of waiting.** Before setup, agent-zarg's runs fail fast with "set a default with /models" rather than waiting. The Setup sheet is already open over them, and waiting would need a new run state. Cost if wrong: a run you start before setup fails once.
  - **No separate HTTP routes for login and default.** The spec lists `GET /setup` and `POST /setup/login|default`. The view's acts already carry login and default through the core's act route, so only `POST /setup/open` is added. Cost if wrong: a non-TUI client acts through the view instead of dedicated routes.
  - **Reconcile isn't hot-reloaded.** A core that started with reconcile off stays off until restart (its gate runs once). The spec's "without a restart" covers the conversation.
