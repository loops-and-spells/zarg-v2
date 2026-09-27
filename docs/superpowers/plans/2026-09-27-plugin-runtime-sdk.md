# Plugin Runtime and SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every plugin runs in its own locked-down Bun process with only the powers you granted, written with a structured SDK, with Gherkin as the first plugin moved in.

**Architecture:** `@zarg/plugin` gains a runtime: a runner script (child process: `lockdown()`, one SES `Compartment`, powers proxied over IPC), a host side that spawns, deadlines, restarts and talks to it, a grants store and the power handlers. `@zarg/plugin-sdk` gives plugin authors `definePlugin`, Effect services for their powers, a manifest generator and a checked bundler. `PluginHost` keeps its interface but runs plugins through the runtime; core, CLI and rlm load plugins only through it.

**Tech Stack:** Bun 1.4.2 (via mise), Effect 4.0.0-rc.117, `ses` 2.3.0 (exact), Bun.build, Bun.spawn IPC.

**Spec:** `docs/superpowers/specs/2026-09-27-plugin-runtime-sdk-design.md`

## Global Constraints

- Run tools through mise: `mise x -- bun …`; tests spawn `process.execPath`, never a bare `bun`.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm` or `node`. Change dependencies with `bun add` / `bun remove`; commit `bun.lock`.
- `mise run verify` typechecks and tests every package and must pass before every commit.
- `ses` is pinned to exactly `2.3.0`.
- Only plugin processes call `lockdown()`; core, CLI and TUI never evaluate plugin code.
- A plugin process starts with an empty environment (`env: {}`).
- Grants live in `~/.config/zarg/grants.json` (tests pass their own directory), never in the repository.
- Plugin secret `<name>.<KEY>` is stored as the variable `ZARG_PLUGIN_<NAME>__<KEY>` (upper case, `-` → `_`).
- Default call deadline 10 s; grant question timeout 10 minutes; three restarts in ten minutes disable a plugin; idle plugin processes stop after 10 minutes.
- First-party = bundle loaded from zarg's own `packages/*/dist` directory **and** SHA-256 in the built-in list; never by name.
- Never print, log or commit a secret value. Tests use variable names unique to the test (`ZT_…`).
- Tag code implementing a card with `// @card <id>` where one applies (existing Gherkin tags move with their code).

## Review Focus

1. A plugin bundle that is valid JavaScript but not built by the SDK (hand-written, no `default` export, throws at load): the host must report it on the agenda and keep every other plugin working. → Task 7, test "a plugin that throws while loading is reported and others still load".
2. Two graph writes landing while a plugin process restarts: the snapshot mirror must be re-sent in full on restart, never a diff against a mirror the new process never had. → Task 7, test "a restarted plugin gets the full snapshot again".
3. A grant question the developer never answers while the plugin keeps calling: calls after the first must share the same pending question and all fail together at the timeout. → Task 4, test "concurrent calls share one question and time out together".
4. Secrets in errors: a plugin that puts its own secret in an error message must not have it reach the core log or the wire. → Task 4, test "a secret inside a plugin error is redacted".
5. `--yolo` with a plugin whose manifest has no optional scopes: YOLO must pass nothing extra and must not write grants. → Task 4, test "YOLO passes only declared scopes and writes no grants".

---

### Task 1: A pure graph entry plugins can bundle

`@zarg/graph`'s `node.ts` imports `node:crypto` for `hash`, so a plugin that uses `Snapshot` or `diff` would pull a Node built-in into its bundle. Move `hash` out and add a `./pure` export.

**Files:**
- Create: `packages/graph/src/hash.ts`, `packages/graph/src/pure.ts`
- Modify: `packages/graph/src/node.ts` (remove `hash` and the `node:crypto` import), `packages/graph/src/index.ts`, `packages/graph/package.json`
- Test: `packages/graph/test/pure.test.ts`

**Interfaces:**
- Produces: `@zarg/graph/pure` exporting `Snapshot` (namespace), `Put`, `Remove`, `type Change`, `diff`, `type Diff`, `type Node`, `type Edge`, `canonical`; `@zarg/graph` unchanged for existing importers (still exports `hash`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/graph/test/pure.test.ts
import { describe, expect, test } from "bun:test"
import { join } from "node:path"

describe("@zarg/graph/pure", () => {
  test("bundles for a plugin with no Node built-ins", async () => {
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/pure.ts")], target: "browser", format: "cjs" })
    expect(out.success).toBe(true)
    const code = await out.outputs[0]!.text()
    expect(code).not.toMatch(/require\(["']node:|from ["']node:|require\(["']crypto["']\)/)
  })
  test("exports what plugins use", async () => {
    const pure = await import("../src/pure")
    const snap = pure.Snapshot.make([{ id: "S-0001", type: "gherkin/state", props: { text: "a" }, edges: [] }])
    expect(pure.Snapshot.get(snap, "S-0001")?.id).toBe("S-0001")
    expect(pure.diff(pure.Snapshot.empty, snap).added.map((n) => n.id)).toEqual(["S-0001"])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/graph && mise x -- bun test test/pure.test.ts`
Expected: FAIL (`Cannot find module '../src/pure'`).

- [ ] **Step 3: Implement**

Move the `hash` function and its `createHash` import from `src/node.ts` into `src/hash.ts` unchanged (it imports `canonical` and `type Node` from `./node`). Then:

```ts
// packages/graph/src/pure.ts
/** What a plugin bundle may use: no Node built-ins (hashing and the store stay in "@zarg/graph"). */
export * from "./diff"
export * from "./node"
export * as Snapshot from "./snapshot"
export { Put, Remove, type Change } from "./snapshot"
```

```ts
// packages/graph/src/index.ts (add one line)
export * from "./hash"
```

```json
// packages/graph/package.json "exports"
{ ".": "./src/index.ts", "./pure": "./src/pure.ts" }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/graph && mise x -- bun test && mise x -- bunx tsc`
Expected: all pass (existing importers of `hash` still resolve through `index.ts`).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/graph && git commit -m "feat(graph): a pure entry plugins can bundle (hash moves out of node.ts)"
```

---

### Task 2: The plugin process: runner, host channel, deadlines, escape suite

**Files:**
- Create: `packages/plugin/src/runtime/protocol.ts`, `packages/plugin/src/runtime/runner.ts`, `packages/plugin/src/runtime/process.ts`, `packages/plugin/src/runtime/index.ts`
- Modify: `packages/plugin/package.json` (add `"ses": "2.3.0"` exactly; export `"./runtime": "./src/runtime/index.ts"`)
- Test: `packages/plugin/test/runtime.test.ts`, `packages/plugin/test/escape.test.ts`, `packages/plugin/test/fixtures.ts`

**Interfaces:**
- Produces:
  - `type Powers = { readonly [power: string]: (args: unknown) => Promise<unknown> }` — host-side handlers a plugin can call (`"secrets.get"`, `"fetch"`, `"fs.read"`, `"fs.write"`, `"graph.snapshot"`, `"console.log"`).
  - `spawnPlugin(opts: { name: string; bundle: string; powers: Powers; deadlineMs?: number; onExit?: (reason: "crash" | "deadline" | "stop") => void }): Effect<PluginProcess, PluginLoadError>`
  - `interface PluginProcess { call(method: string, params: unknown, deadlineMs?: number): Effect<unknown, PluginCallError>; stream(method: string, params: unknown): Stream<unknown, PluginCallError>; stop: Effect<void> }`
  - `PluginCallError = { _tag: "NotGranted" | "PluginCrashed" | "Deadline" | "PluginError" | "UnknownMethod"; message: string }` (a `Data.TaggedError` union exported as `PluginCallError` with field `tag`).
  - `PluginLoadError` (`Data.TaggedError("PluginLoadError")<{ name: string; message: string }>`).
- The bundle contract (produced by the SDK in Task 3; the fixtures here write it by hand): a CommonJS script whose `module.exports.default` has `serve(powers): { [method]: (params) => Promise<unknown> | AsyncIterable<unknown> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/plugin/test/fixtures.ts
/** A hand-written bundle in the runner's contract: module.exports.default.serve(powers) → methods. */
export const bundle = (methods: string) => `module.exports.default = { serve: (powers) => (${methods}) }`
export const echo = bundle(`{ echo: async (p) => p, add: async ({ a, b }) => a + b, secret: async ({ key }) => powers.call("secrets.get", { name: key }) }`)
export const looping = bundle(`{ spin: async () => { for (;;) {} }, ok: async () => "ok" }`)
export const crashing = bundle(`{ boom: async () => { throw new Error("plugin failed on purpose") } }`)
```

```ts
// packages/plugin/test/runtime.test.ts
import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { spawnPlugin } from "../src/runtime"
import { bundle, crashing, echo, looping } from "./fixtures"

const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(Effect.scoped(e as never)) as Promise<A>

describe("plugin process", () => {
  test("a call round-trips JSON through the plugin's process", async () => {
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {} })
      return [yield* p.call("echo", { x: [1, "a"] }), yield* p.call("add", { a: 2, b: 3 })]
    }))
    expect(r).toEqual([{ x: [1, "a"] }, 5])
  })

  test("a power call reaches the host handler and its answer comes back", async () => {
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: { "secrets.get": async (a) => `value-of-${(a as { name: string }).name}` } })
      return yield* p.call("secret", { key: "ZT_KEY" })
    }))
    expect(r).toBe("value-of-ZT_KEY")
  })

  test("a call past its deadline fails, the process restarts, later calls work", async () => {
    const exits: Array<string> = []
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "loop", bundle: looping, powers: {}, deadlineMs: 300, onExit: (x) => exits.push(x) })
      const spun = yield* Effect.flip(p.call("spin", {}))
      return { tag: spun._tag, after: yield* p.call("ok", {}) }
    }))
    expect(r).toEqual({ tag: "Deadline", after: "ok" })
    expect(exits).toContain("deadline")
  })

  test("a thrown error comes back as PluginError with its message", async () => {
    const e = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "crash", bundle: crashing, powers: {} })
      return yield* Effect.flip(p.call("boom", {}))
    }))
    expect(e).toMatchObject({ _tag: "PluginError", message: "plugin failed on purpose" })
  })

  test("an unknown method is UnknownMethod", async () => {
    const e = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "echo", bundle: echo, powers: {} })
      return yield* Effect.flip(p.call("nope", {}))
    }))
    expect(e._tag).toBe("UnknownMethod")
  })

  test("a streaming method yields each chunk in order", async () => {
    const counter = bundle(`{ count: async function* ({ n }) { for (let i = 0; i < n; i++) yield i } }`)
    const r = await run(Effect.gen(function* () {
      const p = yield* spawnPlugin({ name: "count", bundle: counter, powers: {} })
      return [...(yield* Stream.runCollect(p.stream("count", { n: 3 })))]
    }))
    expect(r).toEqual([0, 1, 2])
  })

  test("a bundle that throws while loading is a PluginLoadError", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "bad", bundle: "throw new Error('broken at load')", powers: {} }))))
    expect(e).toMatchObject({ _tag: "PluginLoadError", name: "bad" })
    expect(e.message).toContain("broken at load")
  })

  test("the process has an empty environment", async () => {
    process.env.ZT_RUNTIME_LEAK = "zt-should-not-reach-the-plugin"
    const probe = bundle(`{ env: async () => typeof process === "undefined" ? "no process" : JSON.stringify(process.env) }`)
    const r = await run(Effect.gen(function* () { const p = yield* spawnPlugin({ name: "env", bundle: probe, powers: {} }); return yield* p.call("env", {}) }))
    expect(r).toBe("no process")
    delete process.env.ZT_RUNTIME_LEAK
  })
})
```

```ts
// packages/plugin/test/escape.test.ts
// The spike's hostile probes, kept for good: each must be blocked inside the real runtime.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { spawnPlugin } from "../src/runtime"
import { bundle } from "./fixtures"

const probes: Record<string, string> = {
  process: `typeof process === "undefined" ? "blocked" : "REACHED"`,
  Bun: `typeof Bun === "undefined" ? "blocked" : "REACHED"`,
  require: `typeof require === "undefined" ? "blocked" : "REACHED"`,
  globalFetch: `typeof fetch === "undefined" ? "blocked" : "REACHED"`,
  functionCtor: `(() => { try { return (function(){}).constructor("return typeof process")() === "undefined" ? "blocked" : "REACHED" } catch { return "blocked" } })()`,
  indirectEvalProcess: `(0, eval)("typeof process") === "undefined" ? "blocked" : "REACHED"`,
  prototypePollution: `(() => { try { Object.prototype.zt = 1; return "REACHED" } catch { return "blocked" } })()`,
  patchJSON: `(() => { try { JSON.stringify = () => "x"; return "REACHED" } catch { return "blocked" } })()`,
  mutatePowers: `(() => { try { powers.call = () => "stolen"; return "REACHED" } catch { return "blocked" } })()`,
}

describe("escape suite", () => {
  for (const [name, expr] of Object.entries(probes)) {
    test(`${name} is blocked`, async () => {
      const r = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const p = yield* spawnPlugin({ name: "hostile", bundle: bundle(`{ probe: async () => ${expr} }`), powers: {} })
        return yield* p.call("probe", {})
      })))
      expect(r).toBe("blocked")
    })
  }
  test("code containing import(...) is refused before it runs", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "imp", bundle: bundle(`{ x: async () => import("node:fs") }`), powers: {} }))))
    expect(e.message).toMatch(/import/)
  })
  test("code containing direct eval(...) is refused before it runs", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.flip(spawnPlugin({ name: "ev", bundle: bundle(`{ x: async () => eval("1") }`), powers: {} }))))
    expect(e.message).toMatch(/eval/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/plugin && mise x -- bun add ses@2.3.0 --exact && mise x -- bun test test/runtime.test.ts test/escape.test.ts`
Expected: FAIL (`Cannot find module '../src/runtime'`).

- [ ] **Step 3: Implement the protocol**

```ts
// packages/plugin/src/runtime/protocol.ts
/** Host → plugin process. */
export type ToPlugin =
  | { readonly type: "load"; readonly bundle: string }
  | { readonly type: "call"; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "power-reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "power-reply"; readonly id: number; readonly ok: false; readonly error: Failure }

/** Plugin process → host. */
export type FromPlugin =
  | { readonly type: "ready" }
  | { readonly type: "loaded" }
  | { readonly type: "load-failed"; readonly message: string }
  | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: Failure }
  | { readonly type: "chunk"; readonly id: number; readonly value: unknown }
  | { readonly type: "end"; readonly id: number }
  | { readonly type: "power"; readonly id: number; readonly power: string; readonly args: unknown }

export interface Failure {
  readonly tag: "NotGranted" | "PluginError" | "UnknownMethod"
  readonly message: string
}
```

- [ ] **Step 4: Implement the runner (runs inside the child process)**

```ts
// packages/plugin/src/runtime/runner.ts
// The plugin process: lock down first, then load exactly one bundle into one Compartment whose
// only authority is `powers.call(name, args)`, a request to the host.
import "ses"
import type { Failure, FromPlugin, ToPlugin } from "./protocol"

lockdown({ errorTaming: "unsafe", overrideTaming: "severe", consoleTaming: "unsafe", reporting: "none" })

const send = (m: FromPlugin) => process.send!(m)
let nextPower = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const powers = harden({
  call: (power: string, args: unknown) =>
    new Promise((resolve, reject) => {
      const id = ++nextPower
      waiting.set(id, { resolve, reject })
      send({ type: "power", id, power: String(power), args: JSON.parse(JSON.stringify(args ?? null)) })
    }),
})
let methods: Record<string, (p: unknown) => unknown> = {}
const running = new Map<number, { cancelled: boolean }>()

const fail = (tag: Failure["tag"], message: string): Failure => ({ tag, message })

const onCall = async (id: number, method: string, params: unknown) => {
  const fn = methods[method]
  if (typeof fn !== "function") return send({ type: "reply", id, ok: false, error: fail("UnknownMethod", `no method "${method}"`) })
  const state = { cancelled: false }
  running.set(id, state)
  try {
    const result = await fn(params)
    if (result !== null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
      for await (const chunk of result as AsyncIterable<unknown>) {
        if (state.cancelled) break
        send({ type: "chunk", id, value: JSON.parse(JSON.stringify(chunk ?? null)) })
      }
      send({ type: "end", id })
    } else send({ type: "reply", id, ok: true, value: JSON.parse(JSON.stringify(result ?? null)) })
  } catch (e) {
    const err = e as { tag?: string; message?: string }
    send({ type: "reply", id, ok: false, error: fail(err?.tag === "NotGranted" ? "NotGranted" : "PluginError", String(err?.message ?? e)) })
  } finally {
    running.delete(id)
  }
}

process.on("message", (m: ToPlugin) => {
  if (m.type === "load") {
    try {
      const c = new Compartment({ globals: { console: harden({ log: (...a: Array<unknown>) => void powers.call("console.log", a.map(String).join(" ")) }) }, __options__: true })
      const module = { exports: {} as { default?: { serve?: (p: typeof powers) => Record<string, (p: unknown) => unknown> } } }
      c.evaluate(`(function (module, exports, powers) {\n${m.bundle}\n})`)(module, module.exports, powers)
      const serve = module.exports.default?.serve
      if (typeof serve !== "function") throw new Error("the bundle has no default export with serve(powers)")
      methods = serve(powers)
      send({ type: "loaded" })
    } catch (e) {
      send({ type: "load-failed", message: String((e as Error)?.message ?? e) })
    }
  } else if (m.type === "call") void onCall(m.id, m.method, m.params)
  else if (m.type === "cancel") { const r = running.get(m.id); if (r) r.cancelled = true }
  else if (m.type === "power-reply") {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (w === undefined) return
    if (m.ok) w.resolve(m.value)
    else w.reject(Object.assign(new Error(m.error.message), { tag: m.error.tag }))
  }
})
send({ type: "ready" })
```

- [ ] **Step 5: Implement the host side**

```ts
// packages/plugin/src/runtime/process.ts
import { Data, Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { Failure, FromPlugin, ToPlugin } from "./protocol"

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{ readonly name: string; readonly message: string }> {}
export class PluginCallError extends Data.TaggedError("PluginCallError")<{
  readonly tag: "NotGranted" | "PluginCrashed" | "Deadline" | "PluginError" | "UnknownMethod"
  readonly message: string
}> {
  // `_tag` reads as the failure kind for callers that switch on it.
  override get _tag() { return this.tag as never }
}

export type Powers = { readonly [power: string]: (args: unknown) => Promise<unknown> }

export interface PluginProcess {
  readonly call: (method: string, params: unknown, deadlineMs?: number) => Effect.Effect<unknown, PluginCallError>
  readonly stream: (method: string, params: unknown) => Stream.Stream<unknown, PluginCallError>
  readonly stop: Effect.Effect<void>
}

const RUNNER = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_DEADLINE_MS = 10_000

type Waiter = { readonly onChunk?: (v: unknown) => void; readonly done: (r: { ok: true; value: unknown } | { ok: false; error: Failure | { tag: "PluginCrashed" | "Deadline"; message: string } }) => void }

/**
 * One plugin in its own Bun process (empty environment, locked down, one Compartment). A call past its
 * deadline, or a crash, kills the process; the next call starts a fresh one with the same bundle.
 */
export const spawnPlugin = (opts: {
  readonly name: string
  readonly bundle: string
  readonly powers: Powers
  readonly deadlineMs?: number
  readonly onExit?: (reason: "crash" | "deadline" | "stop") => void
}): Effect.Effect<PluginProcess, PluginLoadError, Scope.Scope> =>
  Effect.gen(function* () {
    let child: ReturnType<typeof Bun.spawn> | undefined
    let ready: Promise<void> | undefined
    let nextId = 0
    const waiters = new Map<number, Waiter>()
    let ending: "deadline" | "stop" | undefined

    const failAll = (tag: "PluginCrashed" | "Deadline", message: string) => {
      for (const [, w] of waiters) w.done({ ok: false, error: { tag, message } })
      waiters.clear()
    }

    const start = () =>
      new Promise<void>((resolve, reject) => {
        const proc = Bun.spawn([process.execPath, RUNNER], {
          env: {},
          stdio: ["ignore", "ignore", "ignore"],
          ipc: (m: FromPlugin) => {
            if (m.type === "ready") proc.send({ type: "load", bundle: opts.bundle } satisfies ToPlugin)
            else if (m.type === "loaded") resolve()
            else if (m.type === "load-failed") reject(new PluginLoadError({ name: opts.name, message: m.message }))
            else if (m.type === "power") {
              const handler = opts.powers[m.power]
              const reply = (r: ToPlugin) => proc.send(r)
              if (handler === undefined) reply({ type: "power-reply", id: m.id, ok: false, error: { tag: "NotGranted", message: `power "${m.power}" is not granted to ${opts.name}` } })
              else handler(m.args).then(
                (value) => reply({ type: "power-reply", id: m.id, ok: true, value }),
                (e) => reply({ type: "power-reply", id: m.id, ok: false, error: { tag: e?.tag === "NotGranted" ? "NotGranted" : "PluginError", message: String(e?.message ?? e) } }),
              )
            } else if (m.type === "chunk") waiters.get(m.id)?.onChunk?.(m.value)
            else if (m.type === "end") { waiters.get(m.id)?.done({ ok: true, value: undefined }); waiters.delete(m.id) }
            else if (m.type === "reply") {
              const w = waiters.get(m.id)
              waiters.delete(m.id)
              w?.done(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error })
            }
          },
          onExit: () => {
            const reason = ending ?? "crash"
            ending = undefined
            child = undefined
            ready = undefined
            failAll(reason === "deadline" ? "Deadline" : "PluginCrashed", reason === "deadline" ? `${opts.name}: call exceeded its deadline` : `${opts.name}: plugin process exited`)
            opts.onExit?.(reason)
            reject(new PluginLoadError({ name: opts.name, message: "plugin process exited while loading" }))
          },
        })
        child = proc
      })

    const ensure = Effect.tryPromise({
      try: () => (ready ??= start()),
      catch: (e) => (e instanceof PluginLoadError ? e : new PluginLoadError({ name: opts.name, message: String(e) })),
    })

    const kill = (why: "deadline" | "stop") => Effect.sync(() => {
      if (child === undefined) return
      ending = why
      child.kill()
    })

    // Load once now, so a broken bundle fails here and not on the first call.
    yield* ensure
    yield* Effect.addFinalizer(() => kill("stop"))

    const toError = (e: Failure | { tag: "PluginCrashed" | "Deadline"; message: string }) => new PluginCallError({ tag: e.tag, message: e.message })

    const call = (method: string, params: unknown, deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS) =>
      Effect.gen(function* () {
        yield* ensure.pipe(Effect.mapError((e) => new PluginCallError({ tag: "PluginCrashed", message: e.message })))
        const id = ++nextId
        const done = yield* Deferred.make<unknown, PluginCallError>()
        waiters.set(id, { done: (r) => Deferred.doneUnsafe(done, r.ok ? Effect.succeed(r.value) : Effect.fail(toError(r.error))) })
        child!.send({ type: "call", id, method, params } satisfies ToPlugin)
        return yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.andThen(kill("deadline"), Effect.fail(new PluginCallError({ tag: "Deadline", message: `${opts.name}.${method}: no answer within ${deadlineMs} ms` }))) }),
        )
      })

    const stream = (method: string, params: unknown) =>
      Stream.callback<unknown, PluginCallError>((queue) =>
        Effect.gen(function* () {
          yield* ensure.pipe(Effect.mapError((e) => new PluginCallError({ tag: "PluginCrashed", message: e.message })))
          const id = ++nextId
          waiters.set(id, {
            onChunk: (v) => Queue.offerUnsafe(queue, v),
            done: (r) => (r.ok ? Queue.endUnsafe(queue) : Queue.failCauseUnsafe(queue, toError(r.error) as never)),
          })
          child!.send({ type: "call", id, method, params } satisfies ToPlugin)
          yield* Effect.addFinalizer(() => Effect.sync(() => { if (waiters.delete(id)) child?.send({ type: "cancel", id } satisfies ToPlugin) }))
        }),
      )

    return { call, stream, stop: kill("stop") } satisfies PluginProcess
  })
```

> Implementer note: `Stream.callback`, `Queue.offerUnsafe`, `Queue.endUnsafe`, `Queue.failCauseUnsafe`, `Deferred.doneUnsafe` and `Effect.timeoutOrElse` are the Effect 4 rc.117 names used elsewhere in this repo (`packages/kernel/src/kernel.ts`, `packages/decisions/src/index.ts`). If one differs in rc.117, use the equivalent the kernel uses and record a Ruling; the tests define the behaviour.

```ts
// packages/plugin/src/runtime/index.ts
export * from "./process"
export type { Failure } from "./protocol"
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/plugin && mise x -- bun test test/runtime.test.ts test/escape.test.ts`
Expected: all pass. The `import(...)` and `eval(...)` tests fail at load with SES's `SES_IMPORT_REJECTED` / `SES_EVAL_REJECTED` text.

- [ ] **Step 7: Commit**

```bash
mise run verify
git add packages/plugin bun.lock && git commit -m "feat(plugin): each plugin runs in its own locked-down process with deadlines, restarts and an escape suite"
```

---

### Task 3: The plugin SDK: definePlugin, power services, manifest, checked build

**Files:**
- Create: `packages/plugin-sdk/package.json`, `packages/plugin-sdk/mise.toml`, `packages/plugin-sdk/tsconfig.json`, `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/src/define.ts`, `packages/plugin-sdk/src/services.ts`, `packages/plugin-sdk/src/manifest.ts`, `packages/plugin-sdk/src/build.ts`, `packages/plugin-sdk/src/testing.ts`
- Test: `packages/plugin-sdk/test/sdk.test.ts`, `packages/plugin-sdk/test/fixtures/good/index.ts`, `packages/plugin-sdk/test/fixtures/node-import/index.ts`, `packages/plugin-sdk/test/fixtures/bun-global/index.ts`

**Interfaces:**
- Consumes: Task 2's bundle contract (`module.exports.default.serve(powers)`), `spawnPlugin`.
- Produces:
  - `definePlugin<M>(def: PluginDef<M>): Plugin<M>` where
    ```ts
    interface Scopes { net?: ReadonlyArray<string> | "ask"; secrets?: ReadonlyArray<string>; graph?: "read" | "write"; fs?: { read?: ReadonlyArray<string> | "ask"; write?: ReadonlyArray<string> | "ask" } }
    interface MethodSpec { doc: string; params: Schema.Top; success: Schema.Top; agents?: boolean; deadlineMs?: number; stream?: boolean }
    interface PluginDef<M extends Record<string, MethodSpec>> {
      name: string; service: string; archetype: "graph" | "provider"
      config: Schema.Top; scopes: Scopes; optional?: Scopes
      methods: M
      graph?: { nodes: Record<string, Schema.Top>; edges: Record<string, { from: string; to: string; min?: number; max?: number }> }
      make: Effect.Effect<{ [K in keyof M]: (p: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, PluginFailure> | Stream.Stream<unknown, PluginFailure> }, never, Secrets | Http | Files | Graph | Config>
    }
    ```
  - Services (Effect `Context.Service`): `Secrets` (`get(name): Effect<string, PluginFailure>`), `Http` (`request(url, init?): Effect<{ status: number; headers: Record<string,string>; text: string }, PluginFailure>`, `getJson(url, { bearer? })`), `Files` (`read(path)`, `write(path, text)`), `Graph` (`snapshot: Effect<Snapshot.Snapshot, PluginFailure>`), `Config` (`value: unknown` decoded with the plugin's config schema).
  - `PluginFailure` = `Data.TaggedError("PluginFailure")<{ tag: string; message: string }>`.
  - `interface Manifest { name; service; archetype; config: unknown /* JSON Schema */; scopes: Scopes; optional: Scopes; methods: Record<string, { doc: string; params: unknown; success: unknown; agents: boolean; deadlineMs?: number; stream: boolean }>; graph?: { nodes: Record<string, unknown>; edges: Record<string, EdgeSpec> } }`
  - `manifestOf(plugin): Manifest`
  - `buildPlugin(entry: string): Promise<{ ok: true; bundle: string; manifest: Manifest } | { ok: false; errors: ReadonlyArray<string> }>`
  - `testPlugin(plugin entry path, powers: Powers): Effect<PluginProcess, …, Scope>` (builds and spawns through the real runtime).
- The graph archetype's reserved methods (called by the host, not by agents): `validate` (params `{ changes }` → `{ findings }`), `lint`, `agenda`, `suggest`, `render`, `affected`. A graph plugin lists the ones it implements in `methods`.

- [ ] **Step 1: Write the failing tests and fixtures**

```ts
// packages/plugin-sdk/test/fixtures/good/index.ts
import { Effect, Schema } from "effect"
import { definePlugin, Http, Secrets } from "../../../src"

export default definePlugin({
  name: "zt-good",
  service: "ZtGood",
  archetype: "provider",
  config: Schema.Struct({ greeting: Schema.optionalKey(Schema.String) }),
  scopes: { net: ["example.test"], secrets: ["API_KEY"] },
  methods: {
    hello: { doc: "Say hello.", params: Schema.Struct({ who: Schema.String.annotate({ description: "Whom to greet." }) }), success: Schema.String, agents: true },
    keyLength: { doc: "Length of the granted key.", params: Schema.Struct({}), success: Schema.Number },
    ping: { doc: "Fetch the granted host.", params: Schema.Struct({}), success: Schema.Number },
  },
  make: Effect.gen(function* () {
    const secrets = yield* Secrets
    const http = yield* Http
    return {
      hello: ({ who }) => Effect.succeed(`hello ${who}`),
      keyLength: () => Effect.map(secrets.get("API_KEY"), (k) => k.length),
      ping: () => Effect.map(http.request("https://example.test/ping"), (r) => r.status),
    }
  }),
})
```

```ts
// packages/plugin-sdk/test/fixtures/node-import/index.ts
import fs from "node:fs"
import { Effect, Schema } from "effect"
import { definePlugin } from "../../../src"
export default definePlugin({
  name: "zt-bad", service: "ZtBad", archetype: "provider", config: Schema.Struct({}), scopes: {},
  methods: { read: { doc: "x", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.succeed({ read: () => Effect.sync(() => fs.readFileSync("/etc/hostname", "utf8")) }),
})
```

```ts
// packages/plugin-sdk/test/fixtures/bun-global/index.ts
import { Effect, Schema } from "effect"
import { definePlugin } from "../../../src"
export default definePlugin({
  name: "zt-bun", service: "ZtBun", archetype: "provider", config: Schema.Struct({}), scopes: {},
  methods: { read: { doc: "x", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.succeed({ read: () => Effect.promise(() => Bun.file("/etc/hostname").text()) }),
})
```

```ts
// packages/plugin-sdk/test/sdk.test.ts
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect } from "effect"
import { buildPlugin, manifestOf, testPlugin } from "../src"
import good from "./fixtures/good"

const fixture = (n: string) => join(import.meta.dir, "fixtures", n, "index.ts")

describe("manifest", () => {
  test("carries name, service, archetype, scopes and each method's JSON Schema with descriptions", () => {
    const m = manifestOf(good)
    expect(m).toMatchObject({ name: "zt-good", service: "ZtGood", archetype: "provider", scopes: { net: ["example.test"], secrets: ["API_KEY"] }, optional: {} })
    expect(m.methods.hello).toMatchObject({ doc: "Say hello.", agents: true, stream: false })
    expect(JSON.stringify(m.methods.hello!.params)).toContain("Whom to greet.")
    expect(m.methods.keyLength!.agents).toBe(false)
  })
})

describe("build", () => {
  test("a plugin bundles into one script that has no Node built-ins", async () => {
    const r = await buildPlugin(fixture("good"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundle).not.toMatch(/require\(["'](node:)?(fs|child_process|net)["']\)/)
    expect(r.manifest.name).toBe("zt-good")
  })
  test("importing node:fs is refused with the scope to ask for", async () => {
    const r = await buildPlugin(fixture("node-import"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("plugins cannot import node:fs; request an fs scope instead")
  })
  test("using Bun is refused", async () => {
    const r = await buildPlugin(fixture("bun-global"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("plugins cannot use Bun")
  })
})

describe("running a plugin", () => {
  test("methods run in the locked runtime with only the powers given", async () => {
    const r = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const p = yield* testPlugin(fixture("good"), {
        "secrets.get": async (a) => ((a as { name: string }).name === "API_KEY" ? "zt-12345" : Promise.reject(Object.assign(new Error("no"), { tag: "NotGranted" }))),
        fetch: async (a) => ({ status: (a as { url: string }).url === "https://example.test/ping" ? 204 : 0, headers: {}, text: "" }),
        "config.get": async () => ({}),
      })
      return [yield* p.call("hello", { who: "you" }), yield* p.call("keyLength", {}), yield* p.call("ping", {})]
    })))
    expect(r).toEqual(["hello you", 8, 204])
  })
  test("bad params are refused by the plugin's own Schema", async () => {
    const e = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const p = yield* testPlugin(fixture("good"), { "config.get": async () => ({}) })
      return yield* Effect.flip(p.call("hello", { who: 1 }))
    })))
    expect(e.message).toContain("who")
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: create `packages/plugin-sdk/package.json` (below), `cd /home/demiurge/Git/zarg-v2 && mise x -- bun install`, then `cd packages/plugin-sdk && mise x -- bun test`
Expected: FAIL (`Cannot find module '../src'`).

```json
// packages/plugin-sdk/package.json
{
  "name": "@zarg/plugin-sdk",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@zarg/graph": "workspace:*", "@zarg/plugin": "workspace:*", "effect": "^4.0.0-rc.117" }
}
```

```toml
# packages/plugin-sdk/mise.toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

`packages/plugin-sdk/tsconfig.json`: same content as `packages/plugin/tsconfig.json`.

- [ ] **Step 3: Implement services and definePlugin**

```ts
// packages/plugin-sdk/src/services.ts
import { Context, Data, Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"

export class PluginFailure extends Data.TaggedError("PluginFailure")<{ readonly tag: string; readonly message: string }> {}

/** What the runner hands a plugin: one function that asks the host for a power. */
export interface RawPowers { readonly call: (power: string, args: unknown) => Promise<unknown> }

const power = <A>(raw: RawPowers, name: string, args: unknown) =>
  Effect.tryPromise({
    try: () => raw.call(name, args) as Promise<A>,
    catch: (e) => new PluginFailure({ tag: String((e as { tag?: string }).tag ?? "PluginError"), message: String((e as Error).message ?? e) }),
  })

export class Secrets extends Context.Service<Secrets, { readonly get: (name: string) => Effect.Effect<string, PluginFailure> }>()("@zarg/plugin-sdk/Secrets") {}
export interface HttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly text: string }
export class Http extends Context.Service<Http, {
  readonly request: (url: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }) => Effect.Effect<HttpResponse, PluginFailure>
  readonly getJson: (url: string, opts?: { readonly bearer?: string }) => Effect.Effect<any, PluginFailure>
}>()("@zarg/plugin-sdk/Http") {}
export class Files extends Context.Service<Files, {
  readonly read: (path: string) => Effect.Effect<string, PluginFailure>
  readonly write: (path: string, text: string) => Effect.Effect<void, PluginFailure>
}>()("@zarg/plugin-sdk/Files") {}
export class Graph extends Context.Service<Graph, { readonly snapshot: Effect.Effect<Snapshot.Snapshot, PluginFailure> }>()("@zarg/plugin-sdk/Graph") {}
export class Config extends Context.Service<Config, { readonly value: unknown }>()("@zarg/plugin-sdk/Config") {}

/** Every power as an Effect service over the runner's channel. The host decides what is granted. */
export const servicesFrom = (raw: RawPowers) => ({
  secrets: Secrets.of({ get: (name) => power<string>(raw, "secrets.get", { name }) }),
  http: Http.of({
    request: (url, init) => power<HttpResponse>(raw, "fetch", { url, ...init }),
    getJson: (url, opts) =>
      Effect.flatMap(power<HttpResponse>(raw, "fetch", { url, headers: opts?.bearer ? { authorization: `Bearer ${opts.bearer}` } : {} }), (r) =>
        Effect.try({ try: () => JSON.parse(r.text), catch: () => new PluginFailure({ tag: "PluginError", message: `${url}: response is not JSON` }) }),
      ),
  }),
  files: Files.of({ read: (path) => power<string>(raw, "fs.read", { path }), write: (path, text) => Effect.asVoid(power(raw, "fs.write", { path, text })) }),
  graph: Graph.of({ snapshot: Effect.map(power<{ nodes: ReadonlyArray<never> }>(raw, "graph.snapshot", {}), (s) => Snapshot.make(s.nodes)) }),
})
```

```ts
// packages/plugin-sdk/src/define.ts
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
```

- [ ] **Step 4: Implement the manifest and the checked build**

```ts
// packages/plugin-sdk/src/manifest.ts
import { Schema } from "effect"
import type { EdgeSpec, Plugin, Scopes } from "./define"

export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider"
  readonly config: unknown
  readonly scopes: Scopes
  readonly optional: Scopes
  readonly methods: Readonly<Record<string, { readonly doc: string; readonly params: unknown; readonly success: unknown; readonly agents: boolean; readonly deadlineMs?: number; readonly stream: boolean }>>
  readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
}

const json = (s: Schema.Top) => Schema.toJsonSchemaDocument(s)

export const manifestOf = (p: Plugin): Manifest => ({
  name: p.name,
  service: p.service,
  archetype: p.archetype,
  config: json(p.config),
  scopes: p.scopes,
  optional: p.optional ?? {},
  methods: Object.fromEntries(
    Object.entries(p.methods).map(([k, m]) => [k, { doc: m.doc, params: json(m.params), success: json(m.success), agents: m.agents === true, stream: m.stream === true, ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}) }]),
  ),
  ...(p.graph !== undefined ? { graph: { nodes: Object.fromEntries(Object.entries(p.graph.nodes).map(([k, s]) => [k, json(s)])), edges: p.graph.edges } } : {}),
})
```

```ts
// packages/plugin-sdk/src/build.ts
import { builtinModules } from "node:module"
import type { Plugin } from "./define"
import { type Manifest, manifestOf } from "./manifest"

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const FORBIDDEN_GLOBALS: ReadonlyArray<[RegExp, string]> = [
  [/\bBun\s*\./, "plugins cannot use Bun; request a scope instead"],
  [/\bprocess\s*\.\s*(env|exit|argv|cwd)/, "plugins cannot use process; request a scope instead"],
]
const SES_REJECTS: ReadonlyArray<[RegExp, string]> = [
  [/\bimport\s*\(/, "plugins cannot use dynamic import(); bundle the module instead"],
  [/(^|[^.\w$])eval\s*\(/, "plugins cannot use direct eval()"],
]

/** Bundle a plugin into one script for the runtime and write its manifest. Refuses what the runtime would block. */
export const buildPlugin = async (entry: string): Promise<{ ok: true; bundle: string; manifest: Manifest } | { ok: false; errors: ReadonlyArray<string> }> => {
  const errors: Array<string> = []
  const out = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "cjs",
    plugins: [{
      name: "zarg-no-builtins",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (BUILTINS.has(args.path)) {
            errors.push(`${args.importer}: plugins cannot import ${args.path.startsWith("node:") ? args.path : `node:${args.path}`}; request an fs scope instead`.replace("an fs scope", args.path.includes("fs") ? "an fs scope" : "a scope"))
            return { path: args.path, external: true }
          }
          return undefined
        })
      },
    }],
  })
  if (!out.success) return { ok: false, errors: [...errors, ...out.logs.map(String)] }
  const bundle = await out.outputs[0]!.text()
  for (const [re, msg] of [...FORBIDDEN_GLOBALS, ...SES_REJECTS]) if (re.test(bundle)) errors.push(msg)
  if (errors.length > 0) return { ok: false, errors }
  const plugin = (await import(entry)).default as Plugin
  return { ok: true, bundle, manifest: manifestOf(plugin) }
}
```

> Implementer note: Effect's own bundled source may contain the text `import(` inside comments or strings, which SES's load-time regex also rejects. If the `good` fixture's build fails on `SES_REJECTS`, strip comments with `minify: { whitespace: true, syntax: true, identifiers: false }` in `Bun.build` and re-test; record a Ruling if a string literal still matches (the spike's 160 KiB Effect bundle loaded without it, unminified).

```ts
// packages/plugin-sdk/src/testing.ts
import { Effect } from "effect"
import { type Powers, spawnPlugin } from "@zarg/plugin/runtime"
import { buildPlugin } from "./build"

/** Build a plugin and run it in the real locked runtime with the given powers (for plugin tests). */
export const testPlugin = (entry: string, powers: Powers) =>
  Effect.flatMap(Effect.promise(() => buildPlugin(entry)), (r) =>
    r.ok ? spawnPlugin({ name: r.manifest.name, bundle: r.bundle, powers }) : Effect.die(new Error(r.errors.join("\n"))),
  )
```

```ts
// packages/plugin-sdk/src/index.ts
export * from "./build"
export * from "./define"
export * from "./manifest"
export * from "./services"
export * from "./testing"
```

The runner (Task 2) calls `module.exports.default.serve(powers)`: `definePlugin` returns an object with `serve`, and the plugin's `export default definePlugin(...)` is `module.exports.default` in the CommonJS bundle.

- [ ] **Step 5: Run tests**

Run: `cd packages/plugin-sdk && mise x -- bun test && mise x -- bunx tsc`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/plugin-sdk bun.lock && git commit -m "feat(plugin-sdk): definePlugin, power services, manifests and a build that refuses what the runtime blocks"
```

---

### Task 4: Grants and the powers the host serves

**Files:**
- Create: `packages/plugin/src/runtime/grants.ts`, `packages/plugin/src/runtime/powers.ts`
- Modify: `packages/plugin/src/runtime/index.ts`
- Test: `packages/plugin/test/grants.test.ts`, `packages/plugin/test/powers.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `Scopes` shape (Task 3; the plugin package declares a local structural copy `ManifestScopes` to avoid depending on the SDK).
- Produces:
  - `makeGrants(opts: { file: string; project: string }): Effect<Grants>` with
    ```ts
    interface Grants {
      /** Everything granted to a plugin: load-time scopes (by digest) plus grants you started and "always" answers. */
      readonly of: (plugin: string, scopesDigest: string) => Effect.Effect<Granted>
      readonly approveLoad: (plugin: string, scopesDigest: string) => Effect.Effect<void>
      readonly add: (plugin: string, grant: Grant) => Effect.Effect<void>
    }
    type Grant = { kind: "net"; host: string } | { kind: "secret"; name: string } | { kind: "fs-read"; glob: string } | { kind: "fs-write"; glob: string }
    interface Granted { readonly loaded: boolean; readonly extra: ReadonlyArray<Grant> }
    ```
  - `scopesDigest(scopes, optional): string` (SHA-256 of canonical JSON).
  - `makePowers(opts: { plugin: string; manifest: { scopes: ManifestScopes; optional: ManifestScopes }; grants: Grants; digest: string; vault: (name: string) => Effect<Redacted<string> | undefined>; config: unknown; snapshot?: () => { nodes: ReadonlyArray<unknown> }; ask: Ask; yolo: () => boolean; log: (line: string) => void; redact: (text: string) => string; fetch?: typeof fetch }): Powers`
  - `type Ask = (q: { plugin: string; what: string; options: ReadonlyArray<{ id: "once" | "folder" | "always" | "deny"; label: string }> }) => Effect<"once" | "folder" | "always" | "deny">`
  - `secretVar(plugin, key): string` → `ZARG_PLUGIN_<NAME>__<KEY>`.
  - `warnings(scopes: ManifestScopes, optional: ManifestScopes): ReadonlyArray<string>` (data-leaves warnings for the approval question).

Decision order for every power call: granted (load scopes when `loaded`, or an `extra` grant) → allow; declared in `optional` (listed, or `"ask"` kind) → YOLO on: allow and log "yolo: <plugin> <scope> <target>"; YOLO off: ask (one pending question per plugin+scope+target; concurrent callers share it; 10 min timeout → deny) → once: allow this call; folder/always: `grants.add` then allow; deny: `NotGranted`; otherwise → `NotGranted` at once.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/plugin/test/grants.test.ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeGrants, scopesDigest } from "../src/runtime"

const dir = () => mkdtempSync(join(tmpdir(), "zt-grants-"))

describe("grants", () => {
  test("a load approval is per project, plugin and scopes digest", async () => {
    const file = join(dir(), "grants.json")
    const d1 = scopesDigest({ net: ["a.test"] }, {})
    const d2 = scopesDigest({ net: ["a.test", "b.test"] }, {})
    const r = await Effect.runPromise(Effect.gen(function* () {
      const g = yield* makeGrants({ file, project: "/p/one" })
      yield* g.approveLoad("tracker", d1)
      const other = yield* makeGrants({ file, project: "/p/two" })
      return { same: (yield* g.of("tracker", d1)).loaded, newScopes: (yield* g.of("tracker", d2)).loaded, otherProject: (yield* other.of("tracker", d1)).loaded }
    }))
    expect(r).toEqual({ same: true, newScopes: false, otherProject: false })
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy()
  })
  test("grants you start are kept, and survive a new digest", async () => {
    const file = join(dir(), "grants.json")
    const r = await Effect.runPromise(Effect.gen(function* () {
      const g = yield* makeGrants({ file, project: "/p" })
      yield* g.add("tracker", { kind: "fs-read", glob: "/mnt/data/**" })
      return (yield* g.of("tracker", "any-digest")).extra
    }))
    expect(r).toEqual([{ kind: "fs-read", glob: "/mnt/data/**" }])
  })
})
```

```ts
// packages/plugin/test/powers.test.ts
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { type Ask, makeGrants, makePowers, scopesDigest, secretVar, warnings } from "../src/runtime"

const tmp = () => mkdtempSync(join(tmpdir(), "zt-powers-"))
const vaultOf = (values: Record<string, string>) => (name: string) => Effect.succeed(values[name] !== undefined ? Redacted.make(values[name]!) : undefined)

const setup = (opts: { scopes?: object; optional?: object; answers?: Array<"once" | "folder" | "always" | "deny">; yolo?: boolean; vault?: Record<string, string>; fetchImpl?: typeof fetch }) =>
  Effect.gen(function* () {
    const file = join(tmp(), "grants.json")
    const grants = yield* makeGrants({ file, project: "/p" })
    const scopes = (opts.scopes ?? {}) as never
    const optional = (opts.optional ?? {}) as never
    const digest = scopesDigest(scopes, optional)
    yield* grants.approveLoad("tracker", digest)
    const asked: Array<string> = []
    const logs: Array<string> = []
    const answers = [...(opts.answers ?? [])]
    const ask: Ask = (q) => Effect.sync(() => { asked.push(q.what); return answers.shift() ?? "deny" })
    const powers = makePowers({
      plugin: "tracker", manifest: { scopes, optional }, grants, digest, vault: vaultOf(opts.vault ?? {}), config: {},
      ask, yolo: () => opts.yolo === true, log: (l) => logs.push(l), redact: (t) => t.replaceAll("zt-secret-value", "<redacted>"),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    })
    return { powers, asked, logs, grants, file }
  })

const go = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("secrets", () => {
  test("a granted key of its own namespace; nothing else", async () => {
    const vault = { [secretVar("tracker", "TOKEN")]: "zt-own", [secretVar("other", "TOKEN")]: "zt-other" }
    const { powers } = await go(setup({ scopes: { secrets: ["TOKEN"] }, vault }))
    expect(await powers["secrets.get"]!({ name: "TOKEN" })).toBe("zt-own")
    await expect(powers["secrets.get"]!({ name: "OTHER" })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers["secrets.get"]!({ name: "../other.TOKEN" })).rejects.toMatchObject({ tag: "NotGranted" })
  })
  test("secretVar maps the namespace to one variable name", () => {
    expect(secretVar("open-router", "API_KEY")).toBe("ZARG_PLUGIN_OPEN_ROUTER__API_KEY")
  })
})

describe("net", () => {
  const recording = () => {
    const seen: Array<string> = []
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url))
      if (String(url) === "https://a.test/redirect") return new Response("", { status: 302, headers: { location: "https://evil.test/x" } })
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    }) as typeof fetch
    return { seen, f }
  }
  test("https to a granted host; user@host and other hosts are refused; plain data back", async () => {
    const { seen, f } = recording()
    const { powers } = await go(setup({ scopes: { net: ["a.test"] }, fetchImpl: f }))
    expect(await powers.fetch!({ url: "https://a.test/x" })).toEqual({ status: 200, headers: { "content-type": "text/plain" }, text: "ok" })
    await expect(powers.fetch!({ url: "https://a.test@evil.test/x" })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers.fetch!({ url: "http://a.test/x" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(seen).toEqual(["https://a.test/x"])
  })
  test("a redirect to an ungranted host is refused", async () => {
    const { seen, f } = recording()
    const { powers } = await go(setup({ scopes: { net: ["a.test"] }, fetchImpl: f }))
    await expect(powers.fetch!({ url: "https://a.test/redirect" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(seen).toEqual(["https://a.test/redirect"])
  })
})

describe("files", () => {
  test("a granted glob reads; .. and a symlink out of it are refused", async () => {
    const root = tmp()
    mkdirSync(join(root, "data"))
    writeFileSync(join(root, "data", "a.txt"), "inside")
    writeFileSync(join(root, "secret.txt"), "outside")
    symlinkSync(join(root, "secret.txt"), join(root, "data", "link.txt"))
    const { powers } = await go(setup({ scopes: { fs: { read: [`${root}/data/**`] } } }))
    expect(await powers["fs.read"]!({ path: `${root}/data/a.txt` })).toBe("inside")
    await expect(powers["fs.read"]!({ path: `${root}/data/../secret.txt` })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers["fs.read"]!({ path: `${root}/data/link.txt` })).rejects.toMatchObject({ tag: "NotGranted" })
  })
})

describe("grants on demand", () => {
  test("an optional host asks once; once allows only that call; always persists", async () => {
    const f = (async () => new Response("ok")) as typeof fetch
    const s = await go(setup({ optional: { net: ["b.test"] }, answers: ["once", "always"], fetchImpl: f }))
    expect((await s.powers.fetch!({ url: "https://b.test/1" }) as { status: number }).status).toBe(200)
    expect((await s.powers.fetch!({ url: "https://b.test/2" }) as { status: number }).status).toBe(200)
    expect((await s.powers.fetch!({ url: "https://b.test/3" }) as { status: number }).status).toBe(200)
    expect(s.asked).toHaveLength(2)
  })
  test("an \"ask\" fs kind names the concrete path; folder grants the directory", async () => {
    const root = tmp()
    writeFileSync(join(root, "one.txt"), "1")
    writeFileSync(join(root, "two.txt"), "2")
    const s = await go(setup({ optional: { fs: { read: "ask" } }, answers: ["folder"] }))
    expect(await s.powers["fs.read"]!({ path: join(root, "one.txt") })).toBe("1")
    expect(await s.powers["fs.read"]!({ path: join(root, "two.txt") })).toBe("2")
    expect(s.asked).toEqual([`read ${join(root, "one.txt")}`])
  })
  test("an undeclared scope never asks", async () => {
    const s = await go(setup({ answers: ["always"] }))
    await expect(s.powers.fetch!({ url: "https://c.test/" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(s.asked).toEqual([])
  })
  test("concurrent calls share one question and time out together", async () => {
    const f = (async () => new Response("ok")) as typeof fetch
    let questions = 0
    const file = join(tmp(), "grants.json")
    const r = await go(Effect.gen(function* () {
      const grants = yield* makeGrants({ file, project: "/p" })
      const digest = scopesDigest({}, { net: ["b.test"] })
      yield* grants.approveLoad("tracker", digest)
      const powers = makePowers({
        plugin: "tracker", manifest: { scopes: {}, optional: { net: ["b.test"] } }, grants, digest, vault: vaultOf({}), config: {},
        ask: () => Effect.andThen(Effect.sync(() => void questions++), Effect.never), askTimeoutMs: 200,
        yolo: () => false, log: () => {}, redact: (t) => t, fetch: f,
      })
      return yield* Effect.promise(() => Promise.allSettled([powers.fetch!({ url: "https://b.test/1" }), powers.fetch!({ url: "https://b.test/2" })]))
    }))
    expect(questions).toBe(1)
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"])
  })
})

describe("YOLO", () => {
  test("YOLO passes only declared scopes and writes no grants", async () => {
    const f = (async () => new Response("ok")) as typeof fetch
    const s = await go(setup({ optional: { net: ["b.test"] }, yolo: true, fetchImpl: f }))
    expect((await s.powers.fetch!({ url: "https://b.test/1" }) as { status: number }).status).toBe(200)
    await expect(s.powers.fetch!({ url: "https://undeclared.test/" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(s.asked).toEqual([])
    expect(s.logs.some((l) => l.includes("yolo: tracker net b.test"))).toBe(true)
    expect((await go(s.grants.of("tracker", "x"))).extra).toEqual([])
  })
})

describe("secrets in errors", () => {
  test("a secret inside a plugin error is redacted", async () => {
    const { powers, logs } = await go(setup({}))
    await powers["console.log"]!("token is zt-secret-value")
    expect(logs.join("\n")).not.toContain("zt-secret-value")
  })
})

describe("warnings", () => {
  test("graph read plus a host warns that data can leave", () => {
    expect(warnings({ graph: "read", net: ["x.test"] }, {})).toEqual(["can read your graph and send it to x.test"])
    expect(warnings({ secrets: ["K"] }, { net: "ask" })).toEqual(["holds a secret and may ask to reach any host"])
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/plugin && mise x -- bun test test/grants.test.ts test/powers.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement grants**

```ts
// packages/plugin/src/runtime/grants.ts
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Semaphore } from "effect"

export interface ManifestScopes {
  readonly net?: ReadonlyArray<string> | "ask"
  readonly secrets?: ReadonlyArray<string>
  readonly graph?: "read" | "write"
  readonly fs?: { readonly read?: ReadonlyArray<string> | "ask"; readonly write?: ReadonlyArray<string> | "ask" }
}
export type Grant =
  | { readonly kind: "net"; readonly host: string }
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "fs-read"; readonly glob: string }
  | { readonly kind: "fs-write"; readonly glob: string }
export interface Granted { readonly loaded: boolean; readonly extra: ReadonlyArray<Grant> }
export interface Grants {
  readonly of: (plugin: string, digest: string) => Effect.Effect<Granted>
  readonly approveLoad: (plugin: string, digest: string) => Effect.Effect<void>
  readonly add: (plugin: string, grant: Grant) => Effect.Effect<void>
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

export const scopesDigest = (scopes: ManifestScopes, optional: ManifestScopes) => createHash("sha256").update(canonical({ scopes, optional })).digest("hex")

type File = { readonly [project: string]: { readonly [plugin: string]: { readonly digests?: ReadonlyArray<string>; readonly extra?: ReadonlyArray<Grant> } } }

/** `~/.config/zarg/grants.json`: approvals per project and plugin. Never in a repository. */
export const makeGrants = (opts: { readonly file: string; readonly project: string }) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const read = (): File => { try { return JSON.parse(readFileSync(opts.file, "utf8")) as File } catch { return {} } }
    const write = (f: File) => {
      mkdirSync(dirname(opts.file), { recursive: true })
      const tmp = `${opts.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, opts.file)
    }
    const update = (plugin: string, f: (e: { digests?: ReadonlyArray<string>; extra?: ReadonlyArray<Grant> }) => { digests?: ReadonlyArray<string>; extra?: ReadonlyArray<Grant> }) =>
      Semaphore.withPermits(lock, 1)(Effect.sync(() => {
        const all = read()
        const project = all[opts.project] ?? {}
        write({ ...all, [opts.project]: { ...project, [plugin]: f(project[plugin] ?? {}) } })
      }))
    return {
      of: (plugin, digest) => Effect.sync(() => {
        const e = read()[opts.project]?.[plugin]
        return { loaded: e?.digests?.includes(digest) === true, extra: e?.extra ?? [] }
      }),
      approveLoad: (plugin, digest) => update(plugin, (e) => ({ ...e, digests: [...new Set([...(e.digests ?? []), digest])] })),
      add: (plugin, grant) => update(plugin, (e) => ({ ...e, extra: [...(e.extra ?? []).filter((g) => canonical(g) !== canonical(grant)), grant] })),
    } satisfies Grants
  })
```

- [ ] **Step 4: Implement powers**

```ts
// packages/plugin/src/runtime/powers.ts
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Deferred, Effect, Redacted } from "effect"
import type { Grant, Grants, ManifestScopes } from "./grants"
import type { Powers } from "./process"

export type Answer = "once" | "folder" | "always" | "deny"
export type Ask = (q: { readonly plugin: string; readonly what: string; readonly options: ReadonlyArray<{ readonly id: Answer; readonly label: string }> }) => Effect.Effect<Answer>

const ASK_TIMEOUT_MS = 10 * 60_000

export const secretVar = (plugin: string, key: string) => `ZARG_PLUGIN_${plugin.toUpperCase().replaceAll("-", "_")}__${key.toUpperCase().replaceAll("-", "_")}`

const notGranted = (message: string) => Object.assign(new Error(message), { tag: "NotGranted" })

// A glob is a literal prefix plus an optional trailing "/**" (any depth) or "/*" (one level).
const globMatch = (glob: string, path: string) => {
  if (glob.endsWith("/**")) return path === glob.slice(0, -3) || path.startsWith(`${glob.slice(0, -3)}/`)
  if (glob.endsWith("/*")) return dirname(path) === glob.slice(0, -2)
  return path === glob
}
const expandHome = (p: string) => (p.startsWith("~/") ? `${process.env.HOME ?? ""}${p.slice(1)}` : p)

type Kind = "net" | "secret" | "fs-read" | "fs-write"
const declared = (s: ManifestScopes, kind: Kind, target: string): boolean | "ask" => {
  const list = kind === "net" ? s.net : kind === "secret" ? s.secrets : kind === "fs-read" ? s.fs?.read : s.fs?.write
  if (list === "ask") return "ask"
  if (list === undefined) return false
  return kind === "net" || kind === "secret" ? list.includes(target) : list.some((g) => globMatch(expandHome(g), target))
}
const grantMatches = (g: Grant, kind: Kind, target: string) =>
  g.kind === kind && (g.kind === "net" ? g.host === target : g.kind === "secret" ? g.name === target : globMatch(expandHome(g.glob), target))

export const warnings = (scopes: ManifestScopes, optional: ManifestScopes): ReadonlyArray<string> => {
  const hosts = [scopes.net, optional.net].flatMap((n) => (n === undefined ? [] : n === "ask" ? ["any host"] : n))
  const reads = scopes.graph !== undefined || optional.graph !== undefined
  const secrets = (scopes.secrets?.length ?? 0) + (optional.secrets?.length ?? 0) > 0
  const out: Array<string> = []
  if (reads && hosts.length > 0) out.push(`can read your graph and send it to ${hosts.join(", ")}`)
  if (secrets && (scopes.net === "ask" || optional.net === "ask")) out.push("holds a secret and may ask to reach any host")
  return out
}

export const makePowers = (opts: {
  readonly plugin: string
  readonly manifest: { readonly scopes: ManifestScopes; readonly optional: ManifestScopes }
  readonly grants: Grants
  readonly digest: string
  readonly vault: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly config: unknown
  readonly snapshot?: () => { readonly nodes: ReadonlyArray<unknown> }
  readonly ask: Ask
  readonly askTimeoutMs?: number
  readonly yolo: () => boolean
  readonly log: (line: string) => void
  readonly redact: (text: string) => string
  readonly fetch?: typeof fetch
}): Powers => {
  const pendingQuestions = new Map<string, Promise<Answer>>()

  /** Allowed when granted; else ask (optional scopes), pass (YOLO) or refuse. */
  const allow = async (kind: Kind, target: string, what: string, folder?: string) => {
    const granted = await Effect.runPromise(opts.grants.of(opts.plugin, opts.digest))
    if (granted.loaded && declared(opts.manifest.scopes, kind, target) === true) return
    if (granted.extra.some((g) => grantMatches(g, kind, target))) return
    const optional = declared(opts.manifest.optional, kind, target)
    if (optional === false) throw notGranted(`${opts.plugin}: ${what} is not declared in its manifest`)
    if (opts.yolo()) return void opts.log(`yolo: ${opts.plugin} ${kind} ${target}`)
    const key = `${kind}\u0000${target}`
    let answer = pendingQuestions.get(key)
    if (answer === undefined) {
      const options = [
        { id: "once" as const, label: "Allow once" },
        ...(folder !== undefined ? [{ id: "folder" as const, label: `Allow ${folder}` }] : []),
        { id: "always" as const, label: "Always allow" },
        { id: "deny" as const, label: "Deny" },
      ]
      answer = Effect.runPromise(
        opts.ask({ plugin: opts.plugin, what, options }).pipe(Effect.timeoutOrElse({ duration: opts.askTimeoutMs ?? ASK_TIMEOUT_MS, orElse: () => Effect.succeed<Answer>("deny") })),
      ).finally(() => pendingQuestions.delete(key))
      pendingQuestions.set(key, answer)
    }
    const a = await answer
    if (a === "deny") throw notGranted(`${opts.plugin}: ${what} was denied`)
    if (a === "always") await Effect.runPromise(opts.grants.add(opts.plugin, (kind === "net" ? { kind, host: target } : kind === "secret" ? { kind, name: target } : { kind, glob: target }) as Grant))
    if (a === "folder" && folder !== undefined) await Effect.runPromise(opts.grants.add(opts.plugin, { kind: kind as "fs-read" | "fs-write", glob: folder }))
  }

  // Open first, then check where the opened file really is: a symlink swapped in after a path check cannot redirect it.
  const checkedPath = async (kind: "fs-read" | "fs-write", raw: string) => {
    const path = resolve(expandHome(raw))
    await allow(kind, path, `${kind === "fs-read" ? "read" : "write"} ${path}`, `${dirname(path)}/**`)
    return path
  }
  const assertSame = (path: string, fd: number) => {
    const real = realpathSync(path)
    const a = fstatSync(fd)
    const b = statSync(real)
    if (a.ino !== b.ino || a.dev !== b.dev || real !== path) throw notGranted(`${opts.plugin}: ${path} resolves outside its grant`)
  }

  const fetchImpl = opts.fetch ?? fetch
  return {
    "config.get": async () => opts.config,
    "console.log": async (line) => void opts.log(`${opts.plugin}: ${opts.redact(String(line))}`),
    "secrets.get": async (args) => {
      const name = String((args as { name?: unknown }).name ?? "")
      if (!/^[A-Z0-9_]+$/i.test(name)) throw notGranted(`${opts.plugin}: "${name}" is not a secret name`)
      await allow("secret", name, `the secret ${name}`)
      const v = await Effect.runPromise(opts.vault(secretVar(opts.plugin, name)))
      if (v === undefined) throw Object.assign(new Error(`${opts.plugin}: secret ${name} is not set`), { tag: "PluginError" })
      return Redacted.value(v)
    },
    fetch: async (args) => {
      const a = args as { url: string; method?: string; headers?: Record<string, string>; body?: string }
      let url = new URL(a.url)
      for (let hop = 0; hop < 5; hop++) {
        if (url.protocol !== "https:") throw notGranted(`${opts.plugin}: only https is allowed (${url.protocol})`)
        await allow("net", url.hostname, `reach ${url.hostname}`)
        const r = await fetchImpl(url.href, { method: a.method ?? "GET", headers: a.headers ?? {}, ...(a.body !== undefined ? { body: a.body } : {}), redirect: "manual" })
        const location = r.headers.get("location")
        if (r.status >= 300 && r.status < 400 && location !== null) { url = new URL(location, url); continue }
        return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: await r.text() }
      }
      throw Object.assign(new Error(`${opts.plugin}: too many redirects`), { tag: "PluginError" })
    },
    "fs.read": async (args) => {
      const path = await checkedPath("fs-read", String((args as { path: string }).path))
      const fd = openSync(path, "r")
      try { assertSame(path, fd); return readFileSync(fd, "utf8") } finally { closeSync(fd) }
    },
    "fs.write": async (args) => {
      const a = args as { path: string; text: string }
      const path = await checkedPath("fs-write", a.path)
      const fd = openSync(path, "w")
      try { assertSame(path, fd); writeFileSync(fd, String(a.text)) } finally { closeSync(fd) }
      return null
    },
    ...(opts.snapshot !== undefined ? { "graph.snapshot": async () => opts.snapshot!() } : {}),
  }
}
```

Export both files from `packages/plugin/src/runtime/index.ts` (`export * from "./grants"; export * from "./powers"`).

> Implementer note: in the symlink test, `realpathSync(path) !== path` refuses `data/link.txt`; `..` in the `data/../secret.txt` path is resolved by `resolve()` before matching, so it fails the glob. Keep both checks.

- [ ] **Step 5: Run tests**

Run: `cd packages/plugin && mise x -- bun test && mise x -- bunx tsc`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/plugin && git commit -m "feat(plugin): grants per project and plugin, and the powers the host serves (namespaced secrets, host-checked fetch, symlink-safe files, questions on demand, YOLO)"
```

---

### Task 5: A thread can hold several questions; system questions reach main

Grant questions arrive at any time, also while the driver waits on its own. The thread's single `pending` becomes a first-in-first-out queue; only the head is shown as the run's interrupt, the next one is shown after it is answered.

**Files:**
- Modify: `packages/core/src/thread.ts` (`pending` → queue; `ask` exposed on the thread)
- Test: `packages/core/test/thread.test.ts`

**Interfaces:**
- Produces: `Thread.ask(question: Question): Effect<Answer>` — the same asker the driver uses, usable by any caller (the plugin host's `Ask`). Questions are answered in the order asked.

- [ ] **Step 1: Write the failing test**

```ts
// added to packages/core/test/thread.test.ts, describe("thread runs")
test("a second question waits behind the first and is shown once the first is answered", async () => {
  const q2 = { question: "Plugin tracker wants to reach b.test", options: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }] }
  const driver: Driver = (_spec, asker) =>
    Effect.gen(function* () {
      const a = yield* asker.ask(question)
      return outcome(`picked ${a.choice}`)
    }) as never
  const out = await Effect.runPromise(Effect.gen(function* () {
    const { thread } = yield* setup(driver)
    const first = yield* collect(thread.run({ runId: "r1" }))
    const system = yield* Effect.forkChild(thread.ask(q2))
    const firstId = (last(first) as any).outcome.interrupts[0].id
    const second = yield* collect(thread.run({ runId: "r2", resume: [{ interruptId: firstId, payload: { choice: "a" } }] }))
    const secondInterrupt = (last(second) as any).outcome.interrupts[0]
    yield* collect(thread.run({ runId: "r3", resume: [{ interruptId: secondInterrupt.id, payload: { choice: "once" } }] }))
    return { secondMessage: secondInterrupt.message, answer: yield* Fiber.join(system) }
  }))
  expect(out.secondMessage).toBe("Plugin tracker wants to reach b.test")
  expect(out.answer).toEqual({ choice: "once" })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/core && mise x -- bun test test/thread.test.ts -t "second question"`
Expected: FAIL (`thread.ask is not a function`).

- [ ] **Step 3: Implement**

In `makeThread`: replace `let pending: Pending | undefined` with `const queue: Array<Pending> = []` and a getter `const pending = () => queue[0]`. In `asker.ask`: push onto `queue`; emit `E.runInterrupted(threadId, runId, interrupt)` only when the new item is the head (`queue.length === 1`) and a run is open; otherwise it waits. Where the code now reads `pending`, use `pending()`; where it sets `pending = undefined` after an answer (resume) or an interjection, `queue.shift()`, then if a new head exists and the run is still open emit its interrupt (the existing re-send at run start already sends `pending()?.interrupt`). Return `ask: asker.ask` from the thread object (add it to the `Thread` type).

- [ ] **Step 4: Run all core tests**

Run: `cd packages/core && mise x -- bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/core && git commit -m "feat(core): a thread queues questions in order; any caller can ask on it"
```

---

### Task 6: Kernel methods described by JSON Schema

Plugin methods reach the kernel with JSON Schema from the manifest, not Effect Schemas. Let a method carry its JSON Schema for the declarations and pass JSON through; the plugin validates with its own Schema.

**Files:**
- Modify: `packages/kernel/src/service.ts` (`MethodDef.json?`), `packages/kernel/src/manifest.ts` (use `json` when present)
- Test: `packages/kernel/test/manifest.test.ts`

**Interfaces:**
- Produces: `MethodDef.json?: { readonly params: unknown; readonly success: unknown }` (JSON Schema documents as `Schema.toJsonSchemaDocument` emits them). With `json`, `params`/`success` are `Schema.Unknown`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/kernel/test/manifest.test.ts
test("a method described by JSON Schema declares its types from it", () => {
  const Plug = defineService("Plug", "A plugin.", {
    hello: {
      doc: "Say hello.",
      params: Schema.Unknown,
      success: Schema.Unknown,
      json: { params: Schema.toJsonSchemaDocument(Schema.Struct({ who: Schema.String })), success: Schema.toJsonSchemaDocument(Schema.String) },
    },
  })
  const text = manifest([Plug])
  expect(text).toContain("hello(params: { who: string }): Eff<string>")
  expect(makeChecker(text).check('yield* Plug.hello({ who: 1 })').ok).toBe(false)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/kernel && mise x -- bun test test/manifest.test.ts`
Expected: FAIL (declaration shows `unknown`).

- [ ] **Step 3: Implement**

```ts
// packages/kernel/src/service.ts — MethodDef
export interface MethodDef<P = any, S = any> {
  readonly doc: string
  readonly params: Schema.Codec<P, any>
  readonly success: Schema.Codec<S, any>
  /** JSON Schema documents to declare instead of `params`/`success` (plugin methods, described by their manifest). */
  readonly json?: { readonly params: unknown; readonly success: unknown }
}
```

```ts
// packages/kernel/src/manifest.ts — replace the method line in `manifest`
const docType = (doc: unknown, indent: string) => {
  const d = doc as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions ?? {}, new Set(), indent)
}
// …
([m, def]) => `  /** ${def.doc} */\n  ${m}(params: ${def.json ? docType(def.json.params, "  ") : typeOf(def.params, "  ")}): Eff<${def.json ? docType(def.json.success, "  ") : typeOf(def.success, "  ")}>`,
```

- [ ] **Step 4: Run tests**

Run: `cd packages/kernel && mise x -- bun test && mise x -- bunx tsc`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/kernel && git commit -m "feat(kernel): methods can be declared from JSON Schema"
```

---

### Task 7: PluginHost runs plugins through the runtime

`PluginHost` keeps its interface (plus `affected`), but reads plugins as `{ manifest, bundle, origin }` and calls them in their processes.

**Files:**
- Create: `packages/plugin/src/server/loaded.ts` (types + `loadPluginDir`), `packages/plugin/src/server/first-party.ts`
- Modify: `packages/plugin/src/server/host.ts`, `packages/plugin/src/server/validate.ts`, `packages/plugin/src/server/plugin.ts`, `packages/plugin/src/server/index.ts`, `packages/plugin/package.json`
- Test: `packages/plugin/test/host.test.ts` (rewritten on a fixture plugin), `packages/plugin/test/fixtures/notes/index.ts`

**Interfaces:**
- Consumes: `spawnPlugin` (Task 2), `makeGrants`/`makePowers`/`scopesDigest`/`warnings` (Task 4), `Manifest` shape (Task 3).
- Produces:
  - `interface LoadedPlugin { readonly manifest: Manifest; readonly bundle: string; readonly origin: string /* absolute dir */ }`
  - `loadPluginDir(dir: string): Effect<LoadedPlugin, PluginConfigError>` (reads `zarg-plugin.json` and `zarg-plugin.js`).
  - `layer(plugins: ReadonlyArray<LoadedPlugin>, opts: HostOptions): Layer<PluginHost, PluginConfigError, GraphStore>` with
    ```ts
    interface HostOptions {
      readonly grants: Grants
      readonly vault: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
      readonly config: (plugin: string) => unknown
      readonly ask: Ask
      readonly yolo: { readonly on: (plugin: string) => boolean }
      readonly log: (line: string) => void
      readonly redact: (text: string) => string
      readonly firstParty: (p: LoadedPlugin) => boolean
      readonly idleMs?: number
    }
    ```
  - `PluginHost` adds `affected(before: Snapshot, after: Snapshot): Effect<{ cards: ReadonlyArray<string>; removed: ReadonlyArray<string> }, IoError>` (union over graph plugins implementing `affected`), `manifests: ReadonlyArray<Manifest>`, and `call(name, params, expect?)` keeps working for `<plugin>/<method>` tool names.
  - `isFirstParty(p: LoadedPlugin, zargRoot: string, known: ReadonlySet<string>): boolean` (origin under `<zargRoot>/packages/` and `sha256(bundle) ∈ known`).
- Graph plugin reserved methods called by the host: `validate({ changes })` → `{ findings }` (node props), `lint({ before, after })` → `{ findings }`, `agenda({})`, `suggest({})`, `render({ focus })` → string, `affected({ before, after })`. Snapshots cross as `{ nodes }`. Tools are the methods whose `agents` is `true` and whose result is a `ToolResult` (`{ changes, message }`).

- [ ] **Step 1: Write the fixture plugin and failing tests**

`packages/plugin/test/fixtures/notes/index.ts`: a graph plugin on the SDK with node type `note` (props `{ text: NonEmptyString }`), tool `add-note` (`agents: true`, params `{ text }`, returns `{ changes: [Put(node)], message }` with id from `Snapshot.nextId(snap, "N")`), `validate`, `agenda` (item per note whose text contains `TODO`), `render` (one line per note), `affected` (added notes). Build it in a `beforeAll` with `buildPlugin` into a temp dir as `zarg-plugin.js` + `zarg-plugin.json`.

Tests (each through a real `layer(...)` over a temp `GraphStore`):
- "a granted plugin's tool writes through the pipeline and its agenda sees the write" (`call("notes/add-note", { text: "TODO x" })` → `added: ["N-0001"]`, `agenda()` has the TODO item).
- "invalid props come back as LintFailed from the plugin's validate" (`text: ""`).
- "an ungranted plugin with a net scope does not load and puts its request on the agenda" (fixture with `scopes.net`; no approveLoad; agenda item title `Plugin notes asks for: reach a.test` and detail includes `warnings(...)` text).
- "a first-party plugin with only graph scope is granted without a question" (`firstParty: () => true`).
- "a plugin named like a first-party one elsewhere is not first-party" (`isFirstParty` with origin outside the root or hash not known → false).
- "a plugin that throws while loading is reported and others still load" (Review Focus 1).
- "a restarted plugin gets the full snapshot again" (Review Focus 2: kill the plugin process with a looping method past its deadline, then `render()` still shows every note).
- "affected unions the graph plugins' answers".
- "a plugin process stops after idleMs and starts again on the next call" (`idleMs: 200`).

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/plugin && mise x -- bun test test/host.test.ts`
Expected: FAIL (`layer` signature / `loadPluginDir` missing).

- [ ] **Step 3: Implement**

Key points (write each fully in the files named above):
- `registry(manifests)`: node types `<plugin>/<local>` from `manifest.graph.nodes` keys; edges from `manifest.graph.edges` resolved as today. `checkNode` keeps edge and cardinality checks; its props check moves out (a `validate` call to the owning plugin).
- Per plugin, a lazily created `PluginProcess` (`spawnPlugin` inside a `ScopedRef`-like holder): created on first call, stopped by a fiber after `idleMs ?? 600_000` without calls, recreated after a crash or deadline. Restart bookkeeping: timestamps of `onExit("crash" | "deadline")`; three within ten minutes → the plugin is disabled (its calls fail `PluginCrashed`, the agenda gets `Plugin <name> was disabled after 3 restarts`).
- Powers per plugin via `makePowers`, with `snapshot: () => ({ nodes: [...current.nodes.values()] })` read from the store's current snapshot at call time. (A full snapshot per `graph.snapshot` power call keeps restarts correct; the plugin SDK's `Graph.snapshot` rebuilds it. This is the mirror: the host sends it when asked, never a diff.)
- Load check: `digest = scopesDigest(m.scopes, m.optional)`; `granted = (yield* grants.of(name, digest)).loaded`; if not granted and `firstParty(p)` and the scopes are graph-only (`!net && !secrets && !fs`), `approveLoad` and continue; else skip loading and add an agenda item `{ id: "plugin-grant:<name>", title: "Plugin <name> asks for: <scopes in words>", detail: [...warnings, "Run `zarg plugin grant <name>` to approve."].join(" "), about: [], priority: 1 }`.
- `call(tool)`: split `<plugin>/<method>`, `before = store.snapshot`, `result = plugin.call(method, params)` → `{ changes, message }`; `after = applyChanges`; findings = host `check` (edges) + `validate` of each touched plugin (`{ changes }`) + every graph plugin's `lint({ before: {nodes}, after: {nodes} })`; then commit as today.
- `agenda/suggest/render/affected`: call every graph plugin that lists the method; merge as today (`render` joins non-empty strings, `affected` unions and sorts).
- `tools`: `ToolInfo` from manifests (`params` = the method's JSON Schema document), `manifests` exposed.

`first-party.ts`:

```ts
import { createHash } from "node:crypto"
import { relative, isAbsolute } from "node:path"
import type { LoadedPlugin } from "./loaded"
export const bundleHash = (bundle: string) => createHash("sha256").update(bundle).digest("hex")
/** Shipped with zarg: loaded from zarg's own packages and byte-identical to what this release built. Never by name. */
export const isFirstParty = (p: LoadedPlugin, zargRoot: string, known: ReadonlySet<string>) => {
  const rel = relative(`${zargRoot}/packages`, p.origin)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && known.has(bundleHash(p.bundle))
}
```

Remove `ServerPlugin`, `Tool`, `tool`, `Lint`, `server` from `plugin.ts` once Task 8 has moved Gherkin (keep `AgendaItem`, `Finding`, `EdgeSpec`, `ToolError`, `ToolResult` types, which the SDK and host share).

- [ ] **Step 4: Run tests**

Run: `cd packages/plugin && mise x -- bun test && mise x -- bunx tsc`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/plugin && git commit -m "feat(plugin): PluginHost runs plugins in their processes: manifests, grants, first-party by origin and hash, lazy start, idle stop, restarts"
```

(`verify` will fail in core/cli/rlm until Task 8–9 switch them; if so, commit Tasks 7–9 together at the end of Task 9 and record a Ruling.)

---

### Task 8: Gherkin moves onto the SDK

**Files:**
- Modify: `packages/plugin-gherkin/src/server/*.ts` → `packages/plugin-gherkin/src/index.ts` (the `definePlugin`), keeping `model.ts`, `lints.ts`, `agenda.ts`, `render.ts`, `affected.ts`, `tools.ts` as internal modules using `@zarg/graph/pure`
- Create: `packages/plugin-gherkin/scripts/build.ts`, `packages/plugin/src/server/first-party-hashes.ts` (generated)
- Modify: `packages/plugin-gherkin/package.json` (deps: `@zarg/plugin-sdk`, `@zarg/graph`; drop the `./server` export; add `"./dist": "./dist"`), `packages/plugin-gherkin/mise.toml` (`build` task), root `mise.toml` (`verify` and `zarg` depend on `//packages/plugin-gherkin:build`), `.gitignore` (`packages/*/dist/`)
- Test: `packages/plugin-gherkin/test/*.test.ts` (run through `testPlugin` / the host layer instead of in-process imports)

**Interfaces:**
- Consumes: SDK (Task 3), host (Task 7).
- Produces: `packages/plugin-gherkin/dist/zarg-plugin.js` + `zarg-plugin.json`; `KNOWN_FIRST_PARTY: ReadonlySet<string>` in `first-party-hashes.ts` (written by the build script with the bundle's SHA-256).

- [ ] **Step 1: Point the existing Gherkin tests at the runtime**

Change `packages/plugin-gherkin/test/harness.ts` so `run(body)` builds the plugin (`buildPlugin(join(import.meta.dir, "../src/index.ts"))`) and provides `layer([{ manifest, bundle, origin: <tmp> }], { …, firstParty: () => true })` over a temp graph. `call(name, params)` stays `PluginHost.use((h) => h.call(\`gherkin/${name}\`, params))`. Tests that imported `affectedCards` call `h.affected(before, after)`.

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/plugin-gherkin && mise x -- bun test`
Expected: FAIL (`src/index.ts` has no default `definePlugin`).

- [ ] **Step 3: Implement**

```ts
// packages/plugin-gherkin/src/index.ts
import { Effect, Schema } from "effect"
import { Snapshot } from "@zarg/graph/pure"
import { definePlugin, Graph } from "@zarg/plugin-sdk"
import { affectedCards } from "./affected"
import { agenda, suggest } from "./agenda"
import { clauseShape, stateText } from "./lints"
import { CardProps, StateProps } from "./model"
import { render } from "./render"
import { AddCard, AddState, EditCard, EditState, Link, Remove, runTool, ToolResult, Unlink } from "./tools"

const SnapshotJson = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })
const Findings = Schema.Struct({ findings: Schema.Array(Schema.Unknown) })
const Items = Schema.Array(Schema.Unknown)
const tool = (doc: string, params: Schema.Codec<any, any>) => ({ doc, params, success: ToolResult, agents: true as const })

export default definePlugin({
  name: "gherkin",
  service: "Gherkin",
  archetype: "graph",
  config: Schema.Struct({}),
  scopes: { graph: "write" },
  graph: {
    nodes: { state: StateProps, card: CardProps },
    edges: {
      arrives: { from: "card", to: "state", min: 1, max: 1 },
      given: { from: "card", to: "state", max: 3 },
      then: { from: "card", to: "state", min: 1, max: 5 },
    },
  },
  methods: {
    "add-state": tool("Add a state (a Given/Then sentence). Fails if a state with the same text exists.", AddState),
    "edit-state": tool("Reword a state or change its entry/terminal flags. Every card using it updates.", EditState),
    "add-card": tool("Add a card: one arrival Given, up to 3 extra Givens, one When, 1-5 Thens. States by {id} or {text}.", AddCard),
    "edit-card": tool("Change a card's title or When.", EditCard),
    link: tool("Connect a card to a state as arrives (replaces the current one), given, or then.", Link),
    unlink: tool("Remove a given or then edge from a card.", Unlink),
    remove: tool("Remove a card, or a state that no card uses.", Remove),
    validate: { doc: "Node props check.", params: Schema.Struct({ changes: Schema.Array(Schema.Unknown) }), success: Findings },
    lint: { doc: "Lints over a proposed change.", params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }), success: Findings },
    agenda: { doc: "Open items.", params: Schema.Struct({}), success: Items },
    suggest: { doc: "What next when the agenda is empty.", params: Schema.Struct({}), success: Items },
    render: { doc: "Gherkin text.", params: Schema.Struct({ focus: Schema.optionalKey(Schema.Array(Schema.String)) }), success: Schema.String },
    affected: { doc: "Cards a change affects.", params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }), success: Schema.Struct({ cards: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }) },
  },
  make: Effect.gen(function* () {
    const graph = yield* Graph
    const snap = graph.snapshot.pipe(Effect.orDie)
    const make = (j: { nodes: ReadonlyArray<unknown> }) => Snapshot.make(j.nodes as never)
    const toolFor = (name: string) => (p: unknown) => Effect.flatMap(snap, (s) => runTool(name, p, s))
    return {
      "add-state": toolFor("add-state"), "edit-state": toolFor("edit-state"), "add-card": toolFor("add-card"),
      "edit-card": toolFor("edit-card"), link: toolFor("link"), unlink: toolFor("unlink"), remove: toolFor("remove"),
      validate: ({ changes }) => Effect.succeed({ findings: validateProps(changes) }),
      lint: ({ before, after }) => Effect.sync(() => ({ findings: [clauseShape, stateText].flatMap((l) => l(lintContext(make(before), make(after)))) })),
      agenda: () => Effect.map(snap, agenda),
      suggest: () => Effect.map(snap, suggest),
      render: ({ focus }) => Effect.map(snap, (s) => render(s, focus === undefined ? undefined : new Set(focus))),
      affected: ({ before, after }) => Effect.sync(() => affectedCards(make(before), make(after))),
    }
  }),
})
```

In `tools.ts`, keep each tool's `params` Schema and `run` body, export the Schemas (`AddState`, `AddCard`, …), a `ToolResult` Schema (`{ changes: Array(Unknown), message: String }`), and `runTool(name, params, snapshot)` dispatching to the existing `run` functions (`ToolError` becomes `PluginFailure` with `tag: "ToolError"`). `validateProps(changes)` decodes each `Put` node's props with `StateProps`/`CardProps` by type and returns `invalid-props` findings exactly as `validate.ts`'s `checkNode` did. `lintContext(before, after)` builds `{ before, after, diff: diff(before, after) }`. Move the `// @card` tags with their code.

`scripts/build.ts`: `buildPlugin("src/index.ts")` → write `dist/zarg-plugin.js`, `dist/zarg-plugin.json`, and regenerate `packages/plugin/src/server/first-party-hashes.ts`:

```ts
// generated by packages/plugin-gherkin/scripts/build.ts — do not edit
export const KNOWN_FIRST_PARTY: ReadonlySet<string> = new Set(["<sha256 of dist/zarg-plugin.js>"])
```

`mise.toml`: `[tasks.build] run = "mise x -- bun scripts/build.ts"`.

- [ ] **Step 4: Run tests**

Run: `cd packages/plugin-gherkin && mise run build && mise x -- bun test && mise x -- bunx tsc`
Expected: all Gherkin tests pass through the runtime.

- [ ] **Step 5: Commit** (with Task 9 if `verify` needs the consumers switched; see Task 7 note)

---

### Task 9: Core, CLI and rlm load plugins only through the runtime

**Files:**
- Create: `packages/core/src/plugins.ts` (`loadPlugins(root)`), `packages/plugin/test/import-rule.test.ts`
- Modify: `packages/core/src/live.ts`, `packages/core/src/phases.ts`, `packages/core/src/reconcile.ts`, `packages/cli/src/main.ts`, `packages/cli/src/commands.ts`, `packages/cli/src/plugins.ts` (delete), `packages/rlm/src/services/graph.ts` (`pluginService` from a manifest), `packages/rlm/smoke/smoke.ts`, `packages/rlm/test/graph.test.ts`
- Test: existing core, cli, rlm suites; new import rule test

**Interfaces:**
- Consumes: Tasks 4, 5, 6, 7, 8.
- Produces:
  - `loadPlugins(opts: { root: string; zargRoot: string; userDir: string }): Effect<ReadonlyArray<LoadedPlugin>, PluginConfigError>` — first-party dist dirs under `<zargRoot>/packages/*/dist` plus `[plugins.<name>] source` entries of `.zarg/config.toml` installed under `<userDir>/plugins/<name>/<sha256>/`.
  - `hostOptions(...)`: `grants` from `<userDir>/grants.json`, `vault` from `Env` (variable `secretVar(plugin, key)`), `ask` = main thread's `ask` mapping `{ what, options }` to an inquiry `Plugin <name> wants to <what>` (options with `recommended` on "Allow once"), `yolo` from the core's `--yolo` flag plus runtime toggles (Task 10), `log` to stderr redacted, `firstParty` = `isFirstParty(p, zargRoot, KNOWN_FIRST_PARTY)`.
  - `pluginService(manifest, ctx)` in rlm: builds a kernel `ServiceDef` named `manifest.service` whose methods are the manifest methods with `agents: true`, each `{ doc, params: Schema.Unknown, success: Schema.Unknown, json: { params, success } }`; handlers call `ctx.host.call(\`${manifest.name}/${method}\`, params)` with the existing scope check.

- [ ] **Step 1: Write the import rule test**

```ts
// packages/plugin/test/import-rule.test.ts
import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../../..", "packages")
const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (f === "node_modules" || f === "dist") return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })

test("only the runtime and a plugin's own package import plugin code", () => {
  const offenders = readdirSync(root)
    .filter((pkg) => pkg !== "plugin-gherkin")
    .flatMap((pkg) => files(join(root, pkg)).filter((f) => /from ["']@zarg\/plugin-gherkin/.test(readFileSync(f, "utf8"))))
  expect(offenders).toEqual([])
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/plugin && mise x -- bun test test/import-rule.test.ts`
Expected: FAIL listing `core/src/live.ts`, `core/src/phases.ts`, `core/src/reconcile.ts`, `cli/src/plugins.ts`, `cli/src/commands.ts`, `rlm/…`.

- [ ] **Step 3: Switch each consumer**

- `core/src/live.ts`: `const plugins = yield* loadPlugins({ root, zargRoot, userDir })`; `hostLayer(plugins, hostOptions(...))`; `pluginService(m, ctx)` for `host.manifests`.
- `core/src/reconcile.ts` / `phases.ts`: replace `affectedCards(before, after)` with `yield* host.affected(before, after)` (thread the host through `PhaseDeps`).
- `cli/src/main.ts` / `commands.ts`: build the host layer from `loadPlugins` too; `affected` command calls `host.affected`. The CLI has no main thread: its `ask` answers `deny` and prints "run `zarg plugin grant <name> …`".
- `rlm/test/graph.test.ts` and `rlm/smoke/smoke.ts`: use the built Gherkin through `loadPluginDir(<repo>/packages/plugin-gherkin/dist)`.
- `zargRoot`: `join(import.meta.dir, "../../..")` from `core/src` and `cli/src`.

- [ ] **Step 4: Run everything**

Run: `mise run verify`
Expected: pass (the import rule too).

- [ ] **Step 5: Commit**

```bash
git add -A packages && git commit -m "feat: core, CLI and rlm load plugins only through the runtime; Gherkin runs in its own process"
```

---

### Task 10: Commands: plugin add, grant, build; --yolo and /yolo

**Files:**
- Create: `packages/plugin/src/server/install.ts`
- Modify: `packages/cli/src/commands.ts` (`plugin add|grant|build`, `--yolo` on the root command and `core start`), `packages/core/src/main.ts` / `lifecycle.ts` (pass `--yolo`), `packages/core/src/server.ts` (`POST /yolo`), `packages/client/src/client.ts` (`yolo(on, plugin?)`), `packages/client/src/session.ts` (`/yolo` command; `yolo` in state from a `CUSTOM` event `zarg.yolo`), `packages/client/src/state.ts`, `packages/cli/src/tui/commands.ts` (`/yolo` in `SLASH_COMMANDS`: `arg: { kind: "choice", choices: ["on", "off"], hint: "on|off" }`), `packages/cli/src/tui/view.ts` (`statusLine` shows `YOLO`)
- Test: `packages/plugin/test/install.test.ts`, `packages/cli/test/commands.test.ts`, `packages/cli/test/view.test.ts`, `packages/client/test/session.test.ts`, `packages/core/test/server.test.ts`

**Interfaces:**
- Produces:
  - `installPlugin(source: string, userDir: string): Effect<{ name: string; dir: string }, PluginConfigError>` — `source` is a directory containing `zarg-plugin.js`/`.json`, or a `.tgz` whose package root has them (extracted with `tar -xzf` into a temp dir, no scripts), copied to `<userDir>/plugins/<name>/<sha256>/`.
  - CLI: `zarg plugin add <source>`, `zarg plugin grant <name> [--fs-read <path>] [--fs-write <path>] [--net <host>] [--secret <KEY>]` (without flags: prints the manifest's scopes and `warnings`, asks `Approve? [y/N]` on the terminal, then `approveLoad`), `zarg plugin build <dir>` (writes `dist/`).
  - `zarg --yolo` / `zarg core start --headless --yolo`; `/yolo [on|off] [<plugin>]`; `POST /yolo { on: boolean, plugin?: string }` → `{ on: boolean }`; status line `… · YOLO` while on.

- [ ] **Step 1: Write the failing tests**

- install: "a package with a postinstall script is unpacked without running it" — a temp package dir with `package.json` `"scripts": { "postinstall": "touch <marker>" }`, `zarg-plugin.js`, `zarg-plugin.json` packed with `tar -czf`; after `installPlugin`, the marker does not exist and `<userDir>/plugins/<name>/<sha>/zarg-plugin.js` does.
- install: "a source without a manifest is refused with what is missing".
- commands: `plugin grant zt-notes --fs-read /mnt/zt` writes `{ kind: "fs-read", glob: "/mnt/zt/**" }` to the grants file given by `ZARG_TEST_USER_DIR`.
- view: `statusLine` with `yolo: true` ends with `· YOLO`.
- session: `/yolo on` calls `client.yolo(true)` and sets a notice "YOLO is on: plugins pass declared scopes without asking."
- server: `POST /yolo` flips the host's `yolo.on` and returns `{ on: true }`; a `CUSTOM` event `{ name: "zarg.yolo", value: { on: true } }` reaches `main`.

- [ ] **Step 2: Run to see them fail**

Run: `mise run verify`
Expected: the new tests fail.

- [ ] **Step 3: Implement** each piece as named in Interfaces, following the existing `/reconcile` path end to end (`SLASH_COMMANDS` entry → `session.command` → `client` → `server` route → core state → event → reducer → status line).

- [ ] **Step 4: Run tests**

Run: `mise run verify`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A packages && git commit -m "feat: zarg plugin add/grant/build, --yolo and /yolo"
```

---

### Task 11: Speed check and docs

**Files:**
- Test: `packages/plugin-gherkin/test/speed.test.ts`
- Modify: `AGENTS.md` (packages list: `plugin-sdk`; plugins load only through the runtime), `intent/zarg.md` (Done: plugin runtime)

- [ ] **Step 1: Write the speed test**

```ts
// packages/plugin-gherkin/test/speed.test.ts
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { call, pricing, run } from "./harness"

test("a Gherkin render through the runtime stays within a few milliseconds", async () => {
  const ms = await run(Effect.gen(function* () {
    yield* pricing
    const host = yield* PluginHost
    yield* host.render() // warm: the process starts on first use
    const t = performance.now()
    for (let i = 0; i < 50; i++) yield* host.render()
    return (performance.now() - t) / 50
  }))
  console.log(`render via runtime: ${ms.toFixed(2)} ms per call`)
  expect(ms).toBeLessThan(5)
})
```

- [ ] **Step 2: Run it**

Run: `cd packages/plugin-gherkin && mise x -- bun test test/speed.test.ts`
Expected: PASS; the printed time is recorded in the final report.

- [ ] **Step 3: Update docs, run verify, commit**

```bash
mise run verify
git add -A && git commit -m "test(plugin-gherkin): runtime call speed; docs: plugins load only through the runtime"
```
