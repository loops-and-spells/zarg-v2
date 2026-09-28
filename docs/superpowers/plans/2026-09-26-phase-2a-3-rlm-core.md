# Phase 2a-3: RLM Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@zarg/rlm`: the RLM as zarg's unit of agency. Scoped core services, plugin tools exposed as services, presets with a spawn graph, and the turn loop that runs a model against a kernel until the RLM finishes with a result that decodes against its preset's Schema.

**Architecture:** An RLM is `exec({ task, preset, scope, budget? })`. Its preset names a layer of services, a model role, a budget, a result Schema and the presets it may spawn. The host builds those services for the RLM's scope, starts a kernel (2a-2) with them plus an `Rlm` service (`done`, `exec`), and loops: model turn → `exec` tool calls → kernel cells → tool results. `Rlm.done(value)` finishes once the value decodes; `Rlm.exec(child)` folds a scoped task into a child RLM whose result is all the parent sees.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117`, `@zarg/kernel`, `@zarg/model`, `@zarg/graph`, `@zarg/plugin`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` (RLM, Services, Errors; build steps 6-7). Plan 2a-4 adds folding (atomize, typed plans, verify before folding) and the live smoke test.

## Global Constraints

- Run bun only as `mise x -- bun ...`.
- The kernel folds context; it is not a security sandbox. Services still enforce scope and leak-guard hygiene: `Fs` refuses paths outside the scope and `.env*` files other than `.env.schema`; `Sh` and `Verify` run with `@sensitive` variables removed from the environment and redact them from output.
- A cell yielded on a service call does not use its deadline, so every service bounds its own time: `Sh` 120 s default (max 600 s), `Verify` 600 s.
- Tests never call a real model: a stub `Model` replays scripted cells per preset. Tests use variable names unique to the test (`ZT_RLM_*`).
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes (`mise run verify`: 181 tests).

### Deliberate differences from the spec

- Plugin tools become services by generating them from `ServerPlugin.tools`: plugin `gherkin`, tool `add-card` → `Gherkin.addCard(params)`, run through `PluginHost.call`. The plugin contract keeps `tools`; no plugin changes.
- A plugin write is refused as out of scope when its params name a node id (`XX-0000`) outside the RLM's graph scope. That is a textual check on the params, good enough for gherkin's ids; a plugin with other id shapes gets no scope check for writes.
- `max_concurrent` limits concurrent model turns across all RLMs, not concurrent RLMs, so a parent waiting on its children cannot deadlock them.
- Tracing is structured logs (`rlm.start`, `rlm.end` with id, parent, preset, depth). AG-UI activity events are 2b.
- `Agenda` and `Inquire` take their backends as arguments (`AgendaInbox`, `Asker`); 2b provides the real ones.
- Budget is turns, tokens (from model usage) and wall time. Carving children's budgets from the parent's is not in scope (declined in the folding design).

## Review Focus

1. A child's transcript must never reach the parent: only its decoded result (Task 2: the marker test).
2. A preset must not be able to spawn a preset outside its `spawns` list, even when the model asks (Task 2).
3. A path like `../../etc/passwd`, an absolute path, or `.env.local` must be refused even when the scope's globs are broad (Task 2).
4. A secret in the environment must not reach a model through `Sh` output or the command's own environment (Task 2).
5. A graph write naming a node outside the scope must be refused before the write pipeline runs (Task 1).

---

### Task 1: Scope and scoped services

**Files:**
- Create: `packages/rlm/{package.json,tsconfig.json,mise.toml}`
- Create: `packages/rlm/src/{scope.ts,index.ts}`, `packages/rlm/src/services/{core.ts,graph.ts,io.ts}`
- Create: `packages/rlm/test/graph.test.ts`

**Interfaces:**
- Consumes: `defineService`, `bind`, `Bound`, `ServiceFailure`, `Kernel` (`@zarg/kernel`); `redact`, `scrubEnv`, `SensitiveValue` (`@zarg/model`); `PluginHost`, `ServerPlugin` (`@zarg/plugin/server`); `hash`, `Snapshot` (`@zarg/graph`).
- Produces:
  - `Scope { graph?: { focus, k }, paths?: globs, kind? }`, `withinRoot(root, path)`, `pathInScope(scope, rel)`, `isEnvSecretFile(rel)`, `describeScope(scope)`, `OutOfScope`
  - `CoreContext { root, scope, sensitive }`; `fs(ctx)`, `fsRead(ctx)` (service `Fs`), `sh(ctx)` (`Sh.run`), `verify(ctx, command?, timeoutMs?)` (`Verify.run`), `runCommand(ctx, argv, timeoutMs)`
  - `GraphContext { host, snapshot, scope }`; `graph(ctx)` (`Graph.render/agenda/show/neighbors`), `scopeSet(snapshot, scope)`, `pluginService(plugin, ctx)`
  - `agenda(inbox: AgendaInbox)` (`Agenda.raise`), `inquire(asker: Asker)` (`Inquire.ask`), types `Raised`, `Question`, `Answer`

- [ ] **Step 1: Create the package**

```bash
mkdir -p packages/rlm/src/services packages/rlm/test
cp packages/graph/tsconfig.json packages/graph/mise.toml packages/rlm/
```

`packages/rlm/package.json`:

```json
{
  "name": "@zarg/rlm",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@zarg/decisions": "workspace:*",
    "@zarg/graph": "workspace:*",
    "@zarg/kernel": "workspace:*",
    "@zarg/model": "workspace:*",
    "@zarg/plugin": "workspace:*"
  }
}
```

```bash
cd packages/rlm && mise x -- bun add effect@rc && mise x -- bun add -d @effect/platform-bun@rc @zarg/plugin-gherkin@workspace:* && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/rlm/test/graph.test.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { Kernel } from "@zarg/kernel"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "@zarg/plugin-gherkin/server"
import { agenda, graph, inquire, pluginService, type Scope, verify } from "../src"

/** A real graph with the gherkin plugin: S-0001 → UX-0001 → S-0002, plus an unrelated S-0003. */
const withGraph = <A>(scope: Scope, body: (k: Kernel.Kernel) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const host = yield* PluginHost
    const store = yield* GraphStore
    yield* host.call("gherkin/add-state", { text: "the home page is shown", entry: true })
    yield* host.call("gherkin/add-card", { title: "Open pricing", when: "the user opens pricing", arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown", terminal: true }] })
    yield* host.call("gherkin/add-state", { text: "an unrelated screen", entry: true, terminal: true })
    const ctx = { host, snapshot: store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))), scope }
    const services = [graph(ctx), pluginService(gherkin, ctx)!]
    const k = yield* Kernel.make({ services })
    return yield* body(k)
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(hostLayer([gherkin]), graphLayer(mkdtempSync(join(tmpdir(), "zarg-rlm-graph-"))))),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  )

describe("Graph service", () => {
  test("render and agenda are narrowed to the scope's focus", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) => k.run("return yield* Graph.render({})"))
    expect(out.output).toContain("UX-0001 Open pricing")
    expect(out.output).not.toContain("S-0003")
  })

  test("show returns the node with its hash; nodes outside the scope are refused", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) =>
      Effect.all([k.run('return (yield* Graph.show({ id: "S-0002" })).hash'), k.run('return yield* Graph.show({ id: "S-0003" })')]),
    )
    expect(out[0].output).toMatch(/^[0-9a-f]{12}$/)
    expect(out[1].output).toContain("OutOfScope")
  })
})

describe("plugin tools as services", () => {
  test("Gherkin.addCard runs through the write pipeline and lints", async () => {
    const out = await withGraph({}, (k) =>
      Effect.all([
        k.run('return (yield* Gherkin.addState({ text: "a settings page is shown", entry: true, terminal: true })).added'),
        k.run('return yield* Gherkin.addState({ text: "shown if logged in" })'),
      ]),
    )
    expect(out[0].output).toContain("S-0004")
    expect(out[1].output).toContain("LintFailed")
    expect(out[1].output).toContain('contains "if"')
  })

  test("writes that name nodes outside the scope are refused", async () => {
    const out = await withGraph({ graph: { focus: ["UX-0001"], k: 1 } }, (k) => k.run('return yield* Gherkin.editState({ id: "S-0003", text: "changed" })'))
    expect(out.output).toContain("OutOfScope")
  })
})

describe("Inquire, Agenda and Verify", () => {
  const kernel = <A>(services: Parameters<typeof Kernel.make>[0]["services"], f: (k: Kernel.Kernel) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(Kernel.make({ services }), f)))

  test("Inquire.ask returns the operator's answer; bad option counts are refused", async () => {
    const asked: Array<string> = []
    const svc = inquire({ ask: (q) => Effect.sync(() => (asked.push(q.question), { choice: "b" })) })
    const out = await kernel([svc], (k) =>
      Effect.all([
        k.run('return yield* Inquire.ask({ question: "Which?", options: [{ id: "a", label: "A", recommended: true, why: "simpler" }, { id: "b", label: "B" }] })'),
        k.run('return yield* Inquire.ask({ question: "Only one?", options: [{ id: "a", label: "A" }] })'),
      ]),
    )
    expect(out[0].output).toContain('"choice": "b"')
    expect(out[1].output).toContain("InvalidQuestion")
    expect(asked).toEqual(["Which?"])
  })

  test("Agenda.raise hands the item to the inbox", async () => {
    const titles: Array<string> = []
    const out = await kernel([agenda({ raise: (i) => Effect.sync(() => (titles.push(i.title), "A-1")) })], (k) =>
      k.run('return yield* Agenda.raise({ title: "UX-0007 contradicts UX-0003", detail: "d", about: ["UX-0007"] })'),
    )
    expect(out.output).toContain('"id": "A-1"')
    expect(titles).toEqual(["UX-0007 contradicts UX-0003"])
  })

  test("Verify reports the gate's verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-verify-"))
    const ctx = { root, scope: {}, sensitive: [] }
    const out = await kernel([verify(ctx, ["bash", "-c", "echo checks passed"])], (k) => k.run("return yield* Verify.run({})"))
    expect(out.output).toContain('"passed": true')
    const failing = await kernel([verify(ctx, ["bash", "-c", "echo broken; exit 3"])], (k) => k.run("return (yield* Verify.run({})).passed"))
    expect(failing.output).toBe("false")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/rlm && mise x -- bun test`
Expected: FAIL, cannot resolve `../src`.

- [ ] **Step 4: Implement**

`packages/rlm/src/scope.ts`:

```ts
import { isAbsolute, normalize, relative, resolve } from "node:path"

/** The bounded domain an RLM may see and touch. */
export interface Scope {
  /** Graph focus: node ids and how many hops around them. */
  readonly graph?: { readonly focus: ReadonlyArray<string>; readonly k: number }
  /** Globs relative to the repo root, e.g. ["packages/graph/**"]. Empty or absent: nothing on disk. */
  readonly paths?: ReadonlyArray<string>
  /** What kind of work this is (a classification), shown to the model. */
  readonly kind?: string
}

export class OutOfScope extends Error {
  readonly _tag = "OutOfScope"
}

/** Resolve `path` inside `root`, refusing anything that escapes it. Returns the repo-relative path. */
export const withinRoot = (root: string, path: string): string => {
  const abs = isAbsolute(path) ? normalize(path) : resolve(root, path)
  const rel = relative(root, abs)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new OutOfScope(`${path} is outside the repository`)
  return rel
}

/** True when a repo-relative path matches one of the scope's globs. */
export const pathInScope = (scope: Scope, rel: string): boolean =>
  (scope.paths ?? []).some((g) => new Bun.Glob(g).match(rel))

/** Env files hold secrets; only the schema is readable. */
export const isEnvSecretFile = (rel: string): boolean => {
  const base = rel.split("/").pop() ?? ""
  return base.startsWith(".env") && base !== ".env.schema"
}

/** One line for the prompt: what this RLM may touch. */
export const describeScope = (scope: Scope): string =>
  [
    scope.kind ? `kind: ${scope.kind}` : undefined,
    scope.graph ? `graph: within ${scope.graph.k} hops of ${scope.graph.focus.join(", ")}` : "graph: whole graph",
    scope.paths && scope.paths.length > 0 ? `files: ${scope.paths.join(", ")}` : "files: none",
  ]
    .filter((x) => x !== undefined)
    .join("; ")
```

`packages/rlm/src/services/core.ts`:

```ts
import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import { redact, scrubEnv, type SensitiveValue } from "@zarg/model"
import { isEnvSecretFile, OutOfScope, pathInScope, type Scope, withinRoot } from "../scope"

export interface CoreContext {
  readonly root: string
  readonly scope: Scope
  readonly sensitive: ReadonlyArray<SensitiveValue>
}

const fail = (_tag: string, message: string): ServiceFailure => ({ _tag, message })
const clip = (text: string, max = 32_768) => (text.length <= max ? text : `${text.slice(0, max / 2)}\n… [${text.length - max} characters cut] …\n${text.slice(-max / 2)}`)

/** Resolve a path the RLM asked for, enforcing root, scope and the env-file rule. */
const resolvePath = (ctx: CoreContext, path: string) =>
  Effect.try({
    try: () => {
      const rel = withinRoot(ctx.root, path)
      if (isEnvSecretFile(rel)) throw new OutOfScope(`${rel} holds secrets; agents cannot read it`)
      if (!pathInScope(ctx.scope, rel)) throw new OutOfScope(`${rel} is outside this RLM's scope (${(ctx.scope.paths ?? []).join(", ") || "no files"}); hand the work to a child RLM`)
      return rel
    },
    catch: (e) => fail("OutOfScope", e instanceof Error ? e.message : String(e)),
  })

const FsRead = {
  read: { doc: "Read a text file (repo-relative path inside your scope).", params: Schema.Struct({ path: Schema.String }), success: Schema.String },
  list: {
    doc: "List files matching a glob, limited to your scope.",
    params: Schema.Struct({ glob: Schema.String }),
    success: Schema.Array(Schema.String),
  },
} as const

export const FsReadDef = defineService("Fs", "Files in your scope (read only).", FsRead)
export const FsDef = defineService("Fs", "Files in your scope.", {
  ...FsRead,
  write: {
    doc: "Write a text file (creates directories). Returns bytes written.",
    params: Schema.Struct({ path: Schema.String, content: Schema.String }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
})

const fsHandlers = (ctx: CoreContext) => ({
  read: ({ path }: { path: string }) =>
    Effect.flatMap(resolvePath(ctx, path), (rel) =>
      Effect.tryPromise({
        try: () => Bun.file(`${ctx.root}/${rel}`).text(),
        catch: () => fail("NotFound", `${rel} does not exist or is not readable`),
      }),
    ).pipe(Effect.map((t) => clip(redact(t, ctx.sensitive)))),
  list: ({ glob }: { glob: string }) =>
    Effect.promise(async () => {
      const out: Array<string> = []
      for await (const f of new Bun.Glob(glob).scan({ cwd: ctx.root, onlyFiles: true })) {
        if (pathInScope(ctx.scope, f) && !isEnvSecretFile(f) && !f.startsWith("node_modules/")) out.push(f)
        if (out.length >= 2000) break
      }
      return out.sort()
    }),
})

export const fsRead = (ctx: CoreContext): Bound => bind(FsReadDef, fsHandlers(ctx))

export const fs = (ctx: CoreContext): Bound =>
  bind(FsDef, {
    ...fsHandlers(ctx),
    write: ({ path, content }) =>
      Effect.flatMap(resolvePath(ctx, path), (rel) =>
        Effect.tryPromise({
          try: async () => ({ bytes: await Bun.write(`${ctx.root}/${rel}`, content, { createPath: true }) }),
          catch: (e) => fail("WriteFailed", `${rel}: ${e instanceof Error ? e.message : String(e)}`),
        }),
      ),
  })

/** Run a command with a deadline, a scrubbed env and redacted, capped output. */
export const runCommand = (ctx: CoreContext, argv: ReadonlyArray<string>, timeoutMs: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      const proc = Bun.spawn([...argv], {
        cwd: ctx.root,
        env: scrubEnv(process.env, ctx.sensitive),
        stdout: "pipe",
        stderr: "pipe",
        signal,
      })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      clearTimeout(timer)
      return {
        exitCode,
        timedOut: proc.signalCode !== null && exitCode !== 0,
        stdout: clip(redact(stdout, ctx.sensitive)),
        stderr: clip(redact(stderr, ctx.sensitive)),
      }
    },
    catch: (e) => fail("CommandFailed", e instanceof Error ? e.message : String(e)),
  })

const CommandResult = Schema.Struct({ exitCode: Schema.Number, timedOut: Schema.Boolean, stdout: Schema.String, stderr: Schema.String })

export const ShDef = defineService("Sh", "Shell commands in the repository root.", {
  run: {
    doc: "Run a bash command. Default deadline 120000 ms. Secrets are not in its environment.",
    params: Schema.Struct({ command: Schema.String, timeoutMs: Schema.optionalKey(Schema.Number) }),
    success: CommandResult,
  },
})

export const sh = (ctx: CoreContext): Bound =>
  bind(ShDef, { run: ({ command, timeoutMs }) => runCommand(ctx, ["bash", "-c", command], Math.min(timeoutMs ?? 120_000, 600_000)) })

export const VerifyDef = defineService("Verify", "The repository's verify gate.", {
  run: {
    doc: "Run the gate (typecheck and tests). passed is the verdict; output is the tail of the log.",
    params: Schema.Struct({}),
    success: Schema.Struct({ passed: Schema.Boolean, output: Schema.String }),
  },
})

export const verify = (ctx: CoreContext, command: ReadonlyArray<string> = ["mise", "run", "verify"], timeoutMs = 600_000): Bound =>
  bind(VerifyDef, {
    run: () =>
      Effect.map(runCommand(ctx, command, timeoutMs), (r) => ({
        passed: r.exitCode === 0,
        output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000),
      })),
  })
```

`packages/rlm/src/services/graph.ts`:

```ts
import { Effect, Schema } from "effect"
import { hash, Snapshot } from "@zarg/graph"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"
import type { PluginHost, ServerPlugin } from "@zarg/plugin/server"
import type { Scope } from "../scope"

const Item = Schema.Struct({ id: Schema.String, title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String), priority: Schema.Number })
const NodeView = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  hash: Schema.String,
  props: Schema.Record(Schema.String, Schema.Json),
  edges: Schema.Array(Schema.Struct({ type: Schema.String, to: Schema.String })),
  inbound: Schema.Array(Schema.Struct({ from: Schema.String, type: Schema.String })),
})

export const GraphDef = defineService("Graph", "The requirements graph, limited to your scope (read only).", {
  render: { doc: "Gherkin text for the cards in scope (optionally narrowed to ids).", params: Schema.Struct({ focus: Schema.optionalKey(Schema.Array(Schema.String)) }), success: Schema.String },
  agenda: { doc: "Open items in scope, most urgent first.", params: Schema.Struct({}), success: Schema.Array(Item) },
  show: { doc: "One node with its hash (for expectations) and inbound edges.", params: Schema.Struct({ id: Schema.String }), success: NodeView },
  neighbors: { doc: "Node ids within k hops, both directions.", params: Schema.Struct({ id: Schema.String, k: Schema.Number }), success: Schema.Array(Schema.String) },
})

const outOfScope = (id: string): ServiceFailure => ({ _tag: "OutOfScope", message: `${id} is outside this RLM's graph scope; hand the work to a child RLM` })

export interface GraphContext {
  readonly host: PluginHost["Service"]
  readonly snapshot: Effect.Effect<Snapshot.Snapshot, ServiceFailure>
  readonly scope: Scope
}

/** The set of node ids this scope may see, or undefined for the whole graph. */
export const scopeSet = (snap: Snapshot.Snapshot, scope: Scope): ReadonlySet<string> | undefined =>
  scope.graph === undefined ? undefined : new Set(scope.graph.focus.flatMap((id) => Snapshot.neighbors(snap, id, scope.graph!.k)))

export const graph = (ctx: GraphContext): Bound =>
  bind(GraphDef, {
    render: ({ focus }) =>
      Effect.gen(function* () {
        const visible = scopeSet(yield* ctx.snapshot, ctx.scope)
        const wanted = focus === undefined ? visible : new Set(focus.filter((id) => visible === undefined || visible.has(id)))
        return yield* ctx.host.render(wanted).pipe(Effect.mapError((e): ServiceFailure => ({ _tag: e._tag, message: e.message })))
      }),
    agenda: () =>
      Effect.gen(function* () {
        const visible = scopeSet(yield* ctx.snapshot, ctx.scope)
        return yield* ctx.host.agenda(visible).pipe(Effect.mapError((e): ServiceFailure => ({ _tag: e._tag, message: e.message })))
      }),
    show: ({ id }) =>
      Effect.gen(function* () {
        const snap = yield* ctx.snapshot
        const visible = scopeSet(snap, ctx.scope)
        if (visible !== undefined && !visible.has(id)) return yield* Effect.fail(outOfScope(id))
        const node = snap.nodes.get(id)
        if (node === undefined) return yield* Effect.fail({ _tag: "NotFound", message: `no node ${id}` })
        return {
          id: node.id,
          type: node.type,
          hash: hash(node),
          props: node.props,
          edges: node.edges.map((e) => ({ type: e.type, to: e.to })),
          inbound: Snapshot.inbound(snap, id).map((e) => ({ from: e.from, type: e.edge.type })),
        }
      }),
    neighbors: ({ id, k }) =>
      Effect.gen(function* () {
        const snap = yield* ctx.snapshot
        const visible = scopeSet(snap, ctx.scope)
        if (visible !== undefined && !visible.has(id)) return yield* Effect.fail(outOfScope(id))
        return Snapshot.neighbors(snap, id, k).filter((n) => visible === undefined || visible.has(n))
      }),
  })

const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
const camel = (s: string) => {
  const p = pascal(s)
  return p[0]!.toLowerCase() + p.slice(1)
}

const CallResult = Schema.Struct({
  message: Schema.String,
  added: Schema.Array(Schema.String),
  changed: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.Struct({ severity: Schema.String, code: Schema.String, message: Schema.String, about: Schema.Array(Schema.String) })),
})

/**
 * A plugin's tools as a yieldable service: plugin "gherkin" with tool "add-card" becomes
 * `Gherkin.addCard(params)`. Every call runs through the PluginHost write pipeline.
 * Writes that touch nodes outside the scope are refused after the fact is known (the result lists them).
 */
export const pluginService = (plugin: ServerPlugin, ctx: GraphContext): Bound | undefined => {
  const tools = plugin.tools ?? []
  if (tools.length === 0) return undefined
  const methods = Object.fromEntries(
    tools.map((t) => [camel(t.name), { doc: t.description, params: t.params as unknown as Schema.Codec<unknown, unknown>, success: CallResult }]),
  )
  const def = defineService(pascal(plugin.name), `Graph writes for the ${plugin.name} plugin (through lints and the write pipeline).`, methods)
  const handlers = Object.fromEntries(
    tools.map((t) => [
      camel(t.name),
      (params: unknown) =>
        Effect.gen(function* () {
          const visible = scopeSet(yield* ctx.snapshot, ctx.scope)
          const touched = JSON.stringify(params).match(/[A-Z]+-\d{4}/g) ?? []
          const outside = visible === undefined ? [] : touched.filter((id) => !visible.has(id))
          if (outside.length > 0) return yield* Effect.fail(outOfScope(outside.join(", ")))
          return yield* ctx.host.call(`${plugin.name}/${t.name}`, params).pipe(
            Effect.mapError((e): ServiceFailure => {
              if (e._tag === "LintFailed") return { _tag: "LintFailed", message: e.findings.map((f) => f.message).join("; ") }
              const tagged = e as { readonly _tag: string; readonly message?: unknown }
              return { _tag: tagged._tag, message: tagged.message === undefined ? tagged._tag : String(tagged.message) }
            }),
          )
        }),
    ]),
  )
  return bind(def, handlers as never)
}
```

`packages/rlm/src/services/io.ts`:

```ts
import { Effect, Schema } from "effect"
import { bind, type Bound, defineService, type ServiceFailure } from "@zarg/kernel"

const Raised = Schema.Struct({ title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String) })
export type Raised = typeof Raised.Type

export const AgendaDef = defineService("Agenda", "Raise items for a driver thread to take up.", {
  raise: { doc: "Raise an item (for example a card that cannot be implemented as written).", params: Raised, success: Schema.Struct({ id: Schema.String }) },
})

/** Where raised items go; 2b replaces this with the project's agenda. */
export interface AgendaInbox {
  readonly raise: (item: Raised) => Effect.Effect<string, ServiceFailure>
}

export const agenda = (inbox: AgendaInbox): Bound => bind(AgendaDef, { raise: (item) => Effect.map(inbox.raise(item), (id) => ({ id })) })

const Option = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  recommended: Schema.optionalKey(Schema.Boolean),
  why: Schema.optionalKey(Schema.String),
})
const Question = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(Option),
  allowOther: Schema.optionalKey(Schema.Boolean),
  about: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Question = typeof Question.Type
const Answer = Schema.Struct({ choice: Schema.optionalKey(Schema.String), other: Schema.optionalKey(Schema.String) })
export type Answer = typeof Answer.Type

export const InquireDef = defineService("Inquire", "Ask the operator a question. The cell waits (yielded) until they answer.", {
  ask: { doc: "Ask with 2-4 options; mark one recommended with why. The answer is an option id or free text.", params: Question, success: Answer },
})

/** How questions reach the operator; 2b implements it with AG-UI interrupts. */
export interface Asker {
  readonly ask: (q: Question) => Effect.Effect<Answer, ServiceFailure>
}

export const inquire = (asker: Asker): Bound =>
  bind(InquireDef, {
    ask: (q) =>
      q.options.length < 2 || q.options.length > 4
        ? Effect.fail({ _tag: "InvalidQuestion", message: `ask with 2 to 4 options, got ${q.options.length}` })
        : asker.ask(q),
  })
```

`packages/rlm/src/index.ts` (Task 2 adds presets and `Rlm`):

```ts
export * from "./scope"
export * from "./services/core"
export * from "./services/graph"
export * from "./services/io"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bun test`
Expected: PASS, 7 tests.

- [ ] **Step 6: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/rlm bun.lock
git commit -m "feat(rlm): scoped core services and plugin tools as services

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Presets, spawn graph and the turn loop

**Files:**
- Create: `packages/rlm/src/{presets.ts,rlm.ts}`, `packages/rlm/test/{stub-model.ts,rlm.test.ts}`
- Modify: `packages/rlm/src/index.ts`, `AGENTS.md`

**Interfaces:**
- Consumes: Task 1 services and `Scope`; `Model.Model`, `ChatMessage`, `ToolCall`, `ConfigError` (`@zarg/model`); `Kernel`, `tsType` (`@zarg/kernel`).
- Produces:
  - `settings(raw)`: `Effect<RlmSettings, ConfigError>` from config `[rlm]` merged over `DEFAULT_PRESETS`; `RlmSettings { maxDepth, maxConcurrent, presets }`; `Preset { layer, spawns?, role, budget?, result?, verify?, stance? }`; `budgetOf(preset, override)`; `DEFAULT_BUDGET`; `RESULTS` (`text`, `research`, `implement-card`)
  - Namespace `Rlm`: `Rlm.make(deps: RlmDeps)`: `Effect<{ exec(spec) }, never, Model>`; `RlmSpec { task, preset, scope, budget? }`; `RlmOutcome { id, value, turns, tokens }`; `RlmError { kind: "budget" | "result" | "model" | "kernel" | "spawn" | "config", message }`; `ServiceFactory = (name, scope) => Bound | undefined`
- Test helper: `stubModel(scripts)` keyed by preset, recording every request.

- [ ] **Step 1: Write the failing tests**

`packages/rlm/test/stub-model.ts`:

```ts
import { Effect, Layer, Stream } from "effect"
import { type ChatMessage, Model, type StreamEvent } from "@zarg/model"

/** One scripted reply: a cell to run, plain text, or a function of the conversation so far. */
export type Reply = { readonly cell: string } | { readonly text: string } | ((messages: ReadonlyArray<ChatMessage>) => { readonly cell: string } | { readonly text: string })

const events = (r: { cell: string } | { text: string }, n: number): ReadonlyArray<StreamEvent> =>
  "cell" in r
    ? [
        { type: "toolCall", call: { id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code: r.cell }) } } },
        { type: "usage", usage: { promptTokens: 100, completionTokens: 10, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 100 } },
        { type: "done", finishReason: "tool_calls" },
      ]
    : [{ type: "text", delta: r.text }, { type: "done", finishReason: "stop" }]

/**
 * A Model that replays scripts keyed by preset (read from the system prompt's first line).
 * Records every request so tests can inspect what each RLM saw.
 */
export const stubModel = (scripts: Readonly<Record<string, ReadonlyArray<Reply>>>) => {
  const seen: Array<{ preset: string; messages: ReadonlyArray<ChatMessage> }> = []
  const cursor = new Map<string, number>()
  const layer = Layer.succeed(Model.Model, {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      const preset = /zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1] ?? "?"
      seen.push({ preset, messages: [...req.messages] })
      const i = cursor.get(preset) ?? 0
      cursor.set(preset, i + 1)
      const script = scripts[preset] ?? []
      const r = script[Math.min(i, script.length - 1)]
      if (r === undefined) return Stream.fromIterable(events({ text: "(no script)" }, i))
      return Stream.fromIterable(events(typeof r === "function" ? r(req.messages) : r, i))
    },
  })
  return { layer, seen }
}
```

`packages/rlm/test/rlm.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { type Bound } from "@zarg/kernel"
import { agenda, type CoreContext, DEFAULT_PRESETS, fs, fsRead, inquire, Rlm, type Scope, settings, sh } from "../src"
import { stubModel, type Reply } from "./stub-model"

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zarg-rlm-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "README.md"), "outside\n")
  writeFileSync(join(root, ".env.local"), "ZT_RLM_KEY=zt-rlm-secret\n")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sensitive = [{ name: "ZT_RLM_KEY", value: Redacted.make("zt-rlm-secret") }]
const asked: Array<string> = []
const raised: Array<string> = []

const factory = (name: string, scope: Scope): Bound | undefined => {
  const ctx: CoreContext = { root, scope, sensitive }
  if (name === "Fs") return fs(ctx)
  if (name === "Fs:read") return fsRead(ctx)
  if (name === "Sh") return sh(ctx)
  if (name === "Agenda") return agenda({ raise: (i) => Effect.sync(() => (raised.push(i.title), `A-${raised.length}`)) })
  if (name === "Inquire") return inquire({ ask: (q) => Effect.sync(() => (asked.push(q.question), { choice: q.options[0]!.id })) })
  return undefined
}

const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, presetsRaw: unknown = {}) => {
  const stub = stubModel(scripts)
  return Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings(presetsRaw)
      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, cellTimeoutMs: 5000 })
      return yield* Effect.exit(rlm.exec(spec))
    }).pipe(Effect.provide(stub.layer)),
  ).then((exit) => ({ exit, seen: stub.seen }))
}
const ok = <A>(r: { exit: any }) => {
  if (r.exit._tag !== "Success") throw new Error(`expected success, got ${JSON.stringify(r.exit.cause)}`)
  return r.exit.value as Rlm.RlmOutcome
}
const err = (r: { exit: any }) => {
  if (r.exit._tag !== "Failure") throw new Error("expected failure")
  return r.exit.cause.reasons[0].error as Rlm.RlmError
}
const scope: Scope = { paths: ["src/**"] }

describe("Rlm.exec", () => {
  test("runs cells and finishes with a result that matches the preset's Schema", async () => {
    const r = await run(
      { research: [{ cell: 'const t = yield* Fs.read({ path: "src/a.ts" })\nreturn t' }, { cell: 'yield* Rlm.done({ value: { findings: ["a is 1"], sources: ["src/a.ts"] } })' }] },
      { task: "what is a?", preset: "research", scope },
    )
    expect(ok(r)).toMatchObject({ value: { findings: ["a is 1"], sources: ["src/a.ts"] }, turns: 2 })
    const toolMsgs = r.seen[1]!.messages.filter((m) => m.role === "tool")
    expect(toolMsgs[0]?.content).toBe("ok\nexport const a = 1\n")
  })

  test("a result that does not match its Schema is refused, and the model can correct it", async () => {
    const r = await run(
      { research: [{ cell: 'yield* Rlm.done({ value: "just text" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] },
      { task: "t", preset: "research", scope },
    )
    expect(ok(r).turns).toBe(2)
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("InvalidResult")
  })

  test("a reply without a tool call gets a nudge", async () => {
    const r = await run({ research: [{ text: "thinking out loud" }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] }, { task: "t", preset: "research", scope })
    expect(ok(r).turns).toBe(2)
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("Use the exec tool")
  })

  test("running out of turns gives one final report turn, then a budget error", async () => {
    const saved = await run(
      { research: [{ cell: "return 1" }, { cell: "return 2" }, { cell: 'yield* Rlm.done({ value: { findings: ["partial"], sources: [] } })' }] },
      { task: "t", preset: "research", scope, budget: { turns: 2 } },
    )
    expect(ok(saved).value).toEqual({ findings: ["partial"], sources: [] })
    expect(saved.seen[2]!.messages.at(-1)?.content).toContain("budget is exhausted")
    const lost = await run({ research: [{ cell: "return 1" }] }, { task: "t", preset: "research", scope, budget: { turns: 2 } })
    expect(err(lost)).toMatchObject({ kind: "budget" })
  })

  test("a service outside the preset's layer fails the typecheck and never runs", async () => {
    const r = await run(
      { research: [{ cell: 'yield* Sh.run({ command: "echo hi" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] },
      { task: "t", preset: "research", scope },
    )
    expect(r.seen[1]!.messages.at(-1)?.content).toContain("Cannot find name 'Sh'")
  })
})

describe("folding into children", () => {
  test("a child runs in its own kernel and the parent sees only its result", async () => {
    const r = await run(
      {
        driver: [
          { cell: 'const found = yield* Rlm.exec({ task: "find a", preset: "research", scope: { paths: ["src/**"] } })\nreturn found' },
          { cell: 'yield* Rlm.done({ value: "folded" })' },
        ],
        research: [{ cell: 'const secretTranscriptMarker = 1\nreturn yield* Fs.read({ path: "src/a.ts" })' }, { cell: 'yield* Rlm.done({ value: { findings: ["child found a"], sources: ["src/a.ts"] } })' }],
      },
      { task: "parent", preset: "driver", scope: {} },
    )
    expect(ok(r).value).toBe("folded")
    const parentTurn2 = r.seen.filter((s) => s.preset === "driver")[1]!.messages
    const parentText = JSON.stringify(parentTurn2)
    expect(parentText).toContain("child found a")
    expect(parentText).not.toContain("secretTranscriptMarker")
  })

  test("the spawn graph refuses a preset the parent may not spawn", async () => {
    const r = await run(
      {
        driver: [
          { cell: 'return yield* Effect.catch(Rlm.exec({ task: "edit code", preset: "implement-card", scope: {} }), (e) => Effect.succeed(e.message))' },
          { cell: 'yield* Rlm.done({ value: "ok" })' },
        ],
      },
      { task: "parent", preset: "driver", scope: {} },
    )
    ok(r)
    const out = r.seen.filter((s) => s.preset === "driver")[1]!.messages.at(-1)?.content
    expect(out).toContain('preset "driver" may not spawn "implement-card"')
  })

  test("an unknown preset at the root is a spawn error", async () => {
    expect(err(await run({}, { task: "t", preset: "nope", scope: {} }))).toMatchObject({ kind: "spawn" })
  })
})

describe("scoped core services", () => {
  const cellOut = (seen: ReadonlyArray<{ messages: ReadonlyArray<any> }>) => String(seen[1]!.messages.at(-1)?.content)
  const once = (cell: string, preset = "implement-card") =>
    run({ [preset]: [{ cell }, { cell: 'yield* Rlm.done({ value: { files: [], summary: "" } })' }] }, { task: "t", preset, scope })

  test("Fs refuses paths outside the scope and env files", async () => {
    expect(cellOut((await once('return yield* Fs.read({ path: "README.md" })')).seen)).toContain("OutOfScope")
    expect(cellOut((await once('return yield* Fs.read({ path: "../../etc/passwd" })')).seen)).toContain("outside the repository")
    const wide = await run({ research: [{ cell: 'return yield* Fs.read({ path: ".env.local" })' }, { cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }] }, { task: "t", preset: "research", scope: { paths: ["**"] } })
    expect(cellOut(wide.seen)).toContain("holds secrets")
  })

  test("Fs writes inside the scope", async () => {
    const r = await once('return yield* Fs.write({ path: "src/new.ts", content: "export {}\\n" })')
    expect(cellOut(r.seen)).toContain('"bytes": 10')
    expect(await Bun.file(join(root, "src", "new.ts")).text()).toBe("export {}\n")
  })

  test("Sh runs without secrets in its environment and redacts them from output", async () => {
    process.env.ZT_RLM_KEY = "zt-rlm-secret"
    const r = await once('return yield* Sh.run({ command: "echo [$ZT_RLM_KEY]; echo zt-rlm-secret" })')
    delete process.env.ZT_RLM_KEY
    const out = cellOut(r.seen)
    expect(out).toContain('"stdout": "[]\\n<redacted:ZT_RLM_KEY>\\n"')
    expect(out).not.toContain("zt-rlm-secret")
  })
})

describe("settings", () => {
  test("config presets override defaults; unknown spawn targets are errors", async () => {
    const s = await Effect.runPromise(settings({ max_depth: 2, presets: { research: { ...DEFAULT_PRESETS.research!, budget: { turns: 3 } } } }))
    expect(s.maxDepth).toBe(2)
    expect(s.presets.research?.budget).toEqual({ turns: 3 })
    const e = await Effect.runPromise(Effect.flip(settings({ presets: { research: { layer: [], role: "driver", spawns: ["ghost"] } } })))
    expect(e.message).toContain('unknown preset "ghost"')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/rlm && mise x -- bun test test/rlm.test.ts`
Expected: FAIL, `Rlm` and `settings` are not exported.

- [ ] **Step 3: Implement**

`packages/rlm/src/presets.ts`:

```ts
import { Effect, Schema } from "effect"
import { ConfigError } from "@zarg/model"

export const Budget = Schema.Struct({
  turns: Schema.Number,
  tokens: Schema.Number,
  wallMs: Schema.Number,
})
export type Budget = typeof Budget.Type

const Preset = Schema.Struct({
  layer: Schema.Array(Schema.String),
  spawns: Schema.optionalKey(Schema.Array(Schema.String)),
  role: Schema.String,
  budget: Schema.optionalKey(Schema.Struct({ turns: Schema.optionalKey(Schema.Number), tokens: Schema.optionalKey(Schema.Number), wallMs: Schema.optionalKey(Schema.Number) })),
  result: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.Literals(["gate", "decision", "none"])),
  stance: Schema.optionalKey(Schema.String),
})
export type Preset = typeof Preset.Type

const RlmConfig = Schema.Struct({
  max_depth: Schema.optionalKey(Schema.Number),
  max_concurrent: Schema.optionalKey(Schema.Number),
  presets: Schema.optionalKey(Schema.Record(Schema.String, Preset)),
  atomize: Schema.optionalKey(Schema.Struct({ min_confidence: Schema.optionalKey(Schema.Number) })),
})

export interface RlmSettings {
  readonly maxDepth: number
  readonly maxConcurrent: number
  readonly presets: Readonly<Record<string, Preset>>
}

export const DEFAULT_BUDGET: Budget = { turns: 25, tokens: 400_000, wallMs: 30 * 60_000 }

/** The presets from the spec; `[rlm.presets.*]` in config overrides them by name. */
export const DEFAULT_PRESETS: Readonly<Record<string, Preset>> = {
  driver: { layer: ["Graph", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rlm"], spawns: ["research", "driver"], role: "driver", budget: { turns: 25 }, result: "text", verify: "none" },
  sync: { layer: ["Graph", "Fs", "Sh", "Verify", "Agenda", "Decisions", "Rlm"], spawns: ["implement-card", "research"], role: "sync", budget: { turns: 40 }, result: "text", verify: "gate" },
  "implement-card": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "sync", budget: { turns: 25 }, result: "implement-card", verify: "gate" },
  research: { layer: ["Graph", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "driver", budget: { turns: 15 }, result: "research", verify: "none" },
}

/** `[rlm]` from config (already `${VAR}`-expanded), merged over the defaults. */
export const settings = (raw: unknown) =>
  Effect.gen(function* () {
    const cfg = yield* Schema.decodeUnknownEffect(RlmConfig)(raw ?? {}).pipe(
      Effect.mapError((e) => new ConfigError({ message: `[rlm]: ${e.message}`, key: "rlm" })),
    )
    const presets = { ...DEFAULT_PRESETS, ...cfg.presets }
    for (const [name, p] of Object.entries(presets)) {
      for (const child of p.spawns ?? []) {
        if (presets[child] === undefined) {
          return yield* new ConfigError({ message: `rlm.presets.${name}.spawns names unknown preset "${child}"`, key: `rlm.presets.${name}.spawns` })
        }
      }
    }
    return { maxDepth: cfg.max_depth ?? 4, maxConcurrent: cfg.max_concurrent ?? 8, presets } satisfies RlmSettings
  })

export const budgetOf = (p: Preset, override: Partial<Budget> = {}): Budget => {
  const base = { ...DEFAULT_BUDGET, ...p.budget }
  // An override can only lower the preset's budget.
  return {
    turns: Math.min(base.turns, override.turns ?? Infinity),
    tokens: Math.min(base.tokens, override.tokens ?? Infinity),
    wallMs: Math.min(base.wallMs, override.wallMs ?? Infinity),
  }
}

/** Result Schemas by name; presets refer to them with `result = "<name>"`. */
export const RESULTS: Readonly<Record<string, Schema.Codec<any, any>>> = {
  text: Schema.String,
  research: Schema.Struct({ findings: Schema.Array(Schema.String), sources: Schema.Array(Schema.String) }),
  "implement-card": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String }),
}
```

`packages/rlm/src/rlm.ts`:

```ts
import { Data, Effect, Ref, Schema, Semaphore, Stream } from "effect"
import { bind, type Bound, defineService, Kernel, type ServiceFailure, tsType } from "@zarg/kernel"
import { Model, type ChatMessage, type ToolCall } from "@zarg/model"
import { budgetOf, type Budget, type Preset, RESULTS, type RlmSettings } from "./presets"
import { describeScope, type Scope } from "./scope"

export type RlmErrorKind = "budget" | "result" | "model" | "kernel" | "spawn" | "config"

export class RlmError extends Data.TaggedError("RlmError")<{
  readonly kind: RlmErrorKind
  readonly message: string
}> {}

export interface RlmSpec {
  readonly task: string
  readonly preset: string
  readonly scope: Scope
  readonly budget?: Partial<Budget>
}

/** Builds the services an RLM's layer names ("Fs:read", "Graph", ...) for its scope. */
export type ServiceFactory = (name: string, scope: Scope) => Bound | undefined

export interface RlmDeps {
  readonly settings: RlmSettings
  readonly services: ServiceFactory
  /** Role → `provider:model` (from config `[roles]`). */
  readonly roles: Readonly<Record<string, string>>
  readonly results?: Readonly<Record<string, Schema.Codec<any, any>>>
  /** Per-cell worker deadline (time yielded on calls does not count). */
  readonly cellTimeoutMs?: number
  /** Tool outputs kept in full; older ones are trimmed. */
  readonly keepOutputs?: number
}

export interface RlmOutcome {
  readonly id: string
  readonly value: unknown
  readonly turns: number
  readonly tokens: number
}

const EXEC_TOOL = {
  name: "exec",
  description: "Run a TypeScript cell in your kernel. It is the body of a generator: `yield*` service calls, `return` a value to see it. Top-level declarations persist into later cells.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
}

const resultType = (schema: Schema.Codec<any, any>) => {
  const d = Schema.toJsonSchemaDocument(schema) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions ?? {})
}

const systemPrompt = (spec: RlmSpec, preset: Preset, manifest: string, result: string, budget: Budget) =>
  [
    preset.stance ?? `You are a zarg ${spec.preset} agent.`,
    "You work only by calling the `exec` tool with TypeScript cells. Each cell is a generator body: `const x = yield* Service.method(params)`; `return` a value to see it in the tool result. Declarations persist across cells.",
    "Stay inside your scope. Work that needs files or graph nodes outside it, or reading more than a few files, goes to a child with `yield* Rlm.exec({ task, preset, scope })`: you get back only its result, which keeps your context small.",
    `When you are done, finish with \`yield* Rlm.done({ value })\` where value is: ${result}`,
    `Scope: ${describeScope(spec.scope)}`,
    `Budget: ${budget.turns} turns.`,
    "Services available to your cells:",
    "```ts",
    manifest.trim(),
    "```",
  ].join("\n\n")

/** Keep the latest tool outputs whole; shorten older ones so a long run stays in context. */
const trimOld = (messages: Array<ChatMessage>, keep: number) => {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []))
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
    const m = messages[i]!
    const c = m.content ?? ""
    if (c.length > 600) messages[i] = { ...m, content: `${c.slice(0, 400)}\n… [older output trimmed] …` }
  }
}

export const make = (deps: RlmDeps) =>
  Effect.gen(function* () {
    const model = yield* Model.Model
    const results = deps.results ?? RESULTS
    const turns = yield* Semaphore.make(deps.settings.maxConcurrent)
    let counter = 0

    const exec = (spec: RlmSpec, parent?: { readonly id: string; readonly preset: string; readonly depth: number }): Effect.Effect<RlmOutcome, RlmError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const preset = deps.settings.presets[spec.preset]
          if (preset === undefined) return yield* new RlmError({ kind: "spawn", message: `no preset "${spec.preset}"` })
          const depth = parent === undefined ? 0 : parent.depth + 1
          if (parent !== undefined) {
            const allowed = deps.settings.presets[parent.preset]?.spawns ?? []
            if (!allowed.includes(spec.preset)) {
              return yield* new RlmError({ kind: "spawn", message: `preset "${parent.preset}" may not spawn "${spec.preset}" (allowed: ${allowed.join(", ") || "none"})` })
            }
            if (depth > deps.settings.maxDepth) return yield* new RlmError({ kind: "spawn", message: `max depth ${deps.settings.maxDepth} reached` })
          }
          const ref = deps.roles[preset.role]
          if (ref === undefined) return yield* new RlmError({ kind: "config", message: `no model for role "${preset.role}"; set roles.${preset.role}` })
          const resultSchema = results[preset.result ?? "text"]
          if (resultSchema === undefined) return yield* new RlmError({ kind: "config", message: `unknown result "${preset.result}"` })
          const budget = budgetOf(preset, spec.budget)
          const id = `rlm-${++counter}`
          const me = { id, preset: spec.preset, depth }

          // The value handed to Rlm.done, once it decodes against the preset's result Schema.
          const finished = yield* Ref.make<{ readonly value: unknown } | undefined>(undefined)
          const RlmDef = defineService("Rlm", "Finish, or fold work into a child RLM.", {
            done: { doc: "Finish with your result (must match the result type in your instructions).", params: Schema.Struct({ value: Schema.Unknown }), success: Schema.String },
            exec: {
              doc: "Run a child RLM on a scoped task; returns only its result. preset must be one you may spawn.",
              params: Schema.Struct({ task: Schema.String, preset: Schema.String, scope: Schema.Struct({ paths: Schema.optionalKey(Schema.Array(Schema.String)), graph: Schema.optionalKey(Schema.Struct({ focus: Schema.Array(Schema.String), k: Schema.Number })), kind: Schema.optionalKey(Schema.String) }) }),
              success: Schema.Unknown,
            },
          })
          const rlmService = bind(RlmDef, {
            done: ({ value }) =>
              Schema.decodeUnknownEffect(Schema.toCodecJson(resultSchema))(value).pipe(
                Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `the result does not match ${resultType(resultSchema)}: ${e.message}` })),
                Effect.flatMap((decoded) => Ref.set(finished, { value: decoded })),
                Effect.as("done: stop now"),
              ),
            exec: (child) =>
              exec(child as RlmSpec, me).pipe(
                Effect.flatMap((o) => Schema.encodeEffect(Schema.toCodecJson(results[deps.settings.presets[child.preset]!.result ?? "text"]!))(o.value)),
                Effect.mapError((e): ServiceFailure => ({ _tag: e._tag === "RlmError" ? "RlmError" : "InvalidResult", message: e.message })),
              ),
          })
          const layer = preset.layer.filter((n) => n !== "Rlm").flatMap((n) => {
            const b = deps.services(n, spec.scope)
            return b === undefined ? [] : [b]
          })
          const kernel = yield* Kernel.make({ services: [...layer, rlmService], env: {}, ...(deps.cellTimeoutMs ? { timeoutMs: deps.cellTimeoutMs } : {}) })

          const messages: Array<ChatMessage> = [
            { role: "system", content: systemPrompt(spec, preset, kernel.manifest, resultType(resultSchema), budget) },
            { role: "user", content: spec.task },
          ]
          const started = Date.now()
          let tokens = 0
          let restarts = 0
          yield* Effect.logInfo("rlm.start").pipe(Effect.annotateLogs({ rlm: id, parent: parent?.id ?? "", preset: spec.preset, depth }))

          const turn = Effect.gen(function* () {
            const events = yield* Semaphore.withPermits(turns, 1)(
              Stream.runCollect(model.stream({ model: ref, messages, tools: [EXEC_TOOL] })),
            ).pipe(Effect.mapError((e) => new RlmError({ kind: "model", message: e.message })))
            let text = ""
            const calls: Array<ToolCall> = []
            for (const e of events) {
              if (e.type === "text") text += e.delta
              if (e.type === "toolCall") calls.push(e.call)
              if (e.type === "usage") tokens += e.usage.promptTokens + e.usage.completionTokens
            }
            messages.push({ role: "assistant", content: text.length > 0 ? text : null, ...(calls.length > 0 ? { toolCalls: calls } : {}) })
            if (calls.length === 0) {
              messages.push({ role: "user", content: "Use the exec tool. Finish with `yield* Rlm.done({ value })`." })
              return
            }
            for (const call of calls) {
              let code = ""
              try {
                code = String((JSON.parse(call.function.arguments) as { code?: unknown }).code ?? "")
              } catch {
                messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: "error: exec arguments must be JSON {\"code\": string}" })
                continue
              }
              const r = yield* kernel.run(code)
              restarts = r.restarted ? restarts + 1 : 0
              if (restarts >= 2) return yield* new RlmError({ kind: "kernel", message: "the kernel died twice in a row" })
              messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: `${r.ok ? "ok" : "failed"}\n${r.output}` })
            }
            trimOld(messages, deps.keepOutputs ?? 4)
          })

          const over = () => tokens >= budget.tokens || Date.now() - started >= budget.wallMs
          for (let n = 1; n <= budget.turns && !over(); n++) {
            yield* turn
            const done = yield* Ref.get(finished)
            if (done !== undefined) {
              yield* Effect.logInfo("rlm.end").pipe(Effect.annotateLogs({ rlm: id, turns: n, tokens }))
              return { id, value: done.value, turns: n, tokens }
            }
          }
          // Budget spent: one final turn to report what it has.
          messages.push({ role: "user", content: "Your budget is exhausted. In your next cell call `yield* Rlm.done({ value })` with your best result now." })
          yield* turn
          const last = yield* Ref.get(finished)
          if (last !== undefined) return { id, value: last.value, turns: budget.turns + 1, tokens }
          return yield* new RlmError({ kind: "budget", message: `${spec.preset} did not finish within its budget (${budget.turns} turns)` })
        }),
      )

    return { exec: (spec: RlmSpec) => exec(spec) }
  })

export type Rlm = Effect.Success<ReturnType<typeof make>>
```

`packages/rlm/src/index.ts` (final):

```ts
export * from "./presets"
export * as Rlm from "./rlm"
export * from "./scope"
export * from "./services/core"
export * from "./services/graph"
export * from "./services/io"
```

In `AGENTS.md`, add under Packages after the `packages/kernel` line:

```markdown
- `packages/rlm` (`@zarg/rlm`): the RLM (unit of agency): presets and spawn graph, scoped core services (`Graph`, `Fs`, `Sh`, `Verify`, `Agenda`, `Inquire`), plugin tools as services, and the turn loop.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bun test`
Expected: PASS, 19 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify`
Expected: exit 0, 181 tests.

```bash
git add packages/rlm AGENTS.md
git commit -m "feat(rlm): presets, spawn graph and the RLM turn loop with folding into children

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
