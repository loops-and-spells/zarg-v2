import { Context, Data, Effect, Exit, Layer, type Redacted, Scope, Semaphore } from "effect"
import { diff, type Expect, GraphStore, type GraphError, hash, type IoError, type Loaded, Snapshot } from "@zarg/graph"
import { type Ask, type Grants, makePowers, type PluginProcess, scopesDigest, spawnPlugin, warnings } from "../runtime"
import type { LoadedPlugin, Manifest } from "./loaded"
import { type AgendaItem, type Finding, ToolError } from "./plugin"
import { checkStructure, manifestRegistry, PluginConfigError } from "./validate"

export class LintFailed extends Data.TaggedError("LintFailed")<{ readonly findings: ReadonlyArray<Finding> }> {}

export interface ToolInfo {
  readonly name: string
  readonly description: string
  readonly params: unknown
}

export interface CallResult {
  readonly message: string
  readonly added: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<Finding>
}

export interface Affected {
  readonly cards: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    /** Methods agents may call, as `<plugin>/<method>`, with their params' JSON Schema. */
    readonly tools: ReadonlyArray<ToolInfo>
    /** Manifests of the plugins that loaded. */
    readonly manifests: ReadonlyArray<Manifest>
    /** Run a plugin method through the write pipeline: run it in its process, check, commit. */
    readonly call: (name: string, params: unknown, expect?: Expect) => Effect.Effect<CallResult, ToolError | LintFailed | GraphError>
    /** Check the whole graph as if every node were new. */
    readonly lint: Effect.Effect<ReadonlyArray<Finding>, IoError>
    readonly agenda: (focus?: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<AgendaItem>, IoError>
    /** Every plugin's suggestions within focus, in the order each plugin ranks them. */
    readonly suggest: (focus?: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<AgendaItem>, IoError>
    readonly render: (focus?: ReadonlySet<string>) => Effect.Effect<string, IoError>
    /** Cards (or other items) a graph change affects, over every graph plugin that answers it. */
    readonly affected: (before: Snapshot.Snapshot, after: Snapshot.Snapshot) => Effect.Effect<Affected, IoError>
    /** Run `effect` with no tool call committing meanwhile (e.g. while landing a commit that writes graph files). */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("@zarg/plugin/PluginHost") {}

export interface HostOptions {
  readonly grants: Grants
  readonly vault: (name: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly config: (plugin: string) => unknown
  readonly ask: Ask
  readonly yolo: { readonly on: (plugin: string) => boolean }
  readonly log: (line: string) => void
  readonly redact: (text: string) => string
  readonly firstParty: (p: LoadedPlugin) => boolean
  /** Stop a plugin's process after this long without calls (default 10 minutes). */
  readonly idleMs?: number
  /** Items to show on the agenda about plugins the host could not even load (not installed). */
  readonly notices?: ReadonlyArray<AgendaItem>
}

/** Methods the host calls on graph plugins; never offered as tools. */
const RESERVED = new Set(["validate", "lint", "agenda", "suggest", "render", "affected"])
const IDLE_MS = 10 * 60_000
const RESTART_WINDOW_MS = 10 * 60_000
const MAX_RESTARTS = 3

const problemItems = (loaded: Loaded): ReadonlyArray<AgendaItem> =>
  loaded.problems.map((p) => ({ id: `invalid-file:${p.file}`, title: `Fix ${p.file}`, detail: p.message, about: [], priority: 1 }))

const inFocus = (focus: ReadonlySet<string> | undefined, about: ReadonlyArray<string>) =>
  focus === undefined || about.length === 0 || about.some((id) => focus.has(id))

// Reserved ids (files that failed to load) travel too: a plugin must never hand one out again.
const json = (s: Snapshot.Snapshot) => ({ nodes: [...s.nodes.values()], reserved: [...s.reserved] })

/** What a plugin asks for, in words, for the grant question and its agenda item. */
const describeScopes = (m: Manifest): string => {
  const s = m.scopes
  const parts = [
    s.graph === "read" ? "read your graph" : s.graph === "write" ? "change your graph" : undefined,
    ...(s.net === "ask" ? ["reach hosts it asks for"] : (s.net ?? []).map((h) => `reach ${h}`)),
    ...(s.secrets ?? []).map((k) => `the secret ${k}`),
    ...(s.fs?.read === "ask" ? ["read files it asks for"] : (s.fs?.read ?? []).map((g) => `read ${g}`)),
    ...(s.fs?.write === "ask" ? ["write files it asks for"] : (s.fs?.write ?? []).map((g) => `write ${g}`)),
  ]
  return parts.filter((p) => p !== undefined).join(", ") || "nothing"
}

/** A plugin with no network, secret or file scope can only touch the graph. */
const graphOnly = (m: Manifest) => m.scopes.net === undefined && m.scopes.secrets === undefined && m.scopes.fs === undefined

interface Running {
  readonly manifest: Manifest
  readonly process: PluginProcess
  readonly restarts: Array<number>
  disabled: boolean
  inflight: number
  idle?: ReturnType<typeof setTimeout>
}

export const layer = (plugins: ReadonlyArray<LoadedPlugin>, opts: HostOptions): Layer.Layer<PluginHost, PluginConfigError, GraphStore> =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const store = yield* GraphStore
      const scope = yield* Effect.scope
      const hostItems: Array<AgendaItem> = [...(opts.notices ?? [])]
      const running = new Map<string, Running>()

      for (const p of plugins) {
        const m = p.manifest
        const digest = scopesDigest(m.scopes, m.optional)
        const granted = (yield* opts.grants.of(m.name, digest)).loaded
        if (!granted && opts.firstParty(p) && graphOnly(m)) yield* opts.grants.approveLoad(m.name, digest)
        else if (!granted) {
          hostItems.push({
            id: `plugin-grant:${m.name}`,
            title: `Plugin ${m.name} asks for: ${describeScopes(m)}`,
            detail: [...warnings(m.scopes, m.optional).map((w) => `It ${w}.`), `Run \`zarg plugin grant ${m.name}\` to approve.`].join(" "),
            about: [],
            priority: 1,
          })
          continue
        }
        const restarts: Array<number> = []
        const powers = makePowers({
          plugin: m.name,
          manifest: { scopes: m.scopes, optional: m.optional },
          grants: opts.grants,
          digest,
          vault: opts.vault,
          config: opts.config(m.name),
          // The plugin reads the graph as it is at call time: a restarted process gets it whole again.
          ...(m.scopes.graph !== undefined ? { snapshot: () => Effect.runPromise(store.snapshot.pipe(Effect.map(json), Effect.orDie)) } : {}),
          ask: opts.ask,
          yolo: () => opts.yolo.on(m.name),
          log: opts.log,
          redact: opts.redact,
        })
        const spawned = yield* spawnPlugin({
          name: m.name,
          bundle: p.bundle,
          powers,
          onExit: (why) => {
            if (why === "stop") return
            const now = Date.now()
            restarts.push(now)
            while (restarts.length > 0 && now - restarts[0]! > RESTART_WINDOW_MS) restarts.shift()
            const r = running.get(m.name)
            if (r !== undefined && restarts.length >= MAX_RESTARTS && !r.disabled) {
              r.disabled = true
              hostItems.push({ id: `plugin-disabled:${m.name}`, title: `Plugin ${m.name} was disabled after ${MAX_RESTARTS} restarts`, detail: "It crashed or ran past its deadline three times in ten minutes. Restart zarg to try it again.", about: [], priority: 1 })
            }
          },
        }).pipe(Scope.provide(scope), Effect.exit)
        if (Exit.isFailure(spawned)) {
          const cause = spawned.cause.reasons.find((r) => r._tag === "Fail")?.error as { message?: string } | undefined
          hostItems.push({ id: `plugin-failed:${m.name}`, title: `Plugin ${m.name} failed to load`, detail: String(cause?.message ?? "unknown error"), about: [], priority: 1 })
          continue
        }
        running.set(m.name, { manifest: m, process: spawned.value, restarts, disabled: false, inflight: 0 })
      }

      yield* Effect.addFinalizer(() => Effect.sync(() => { for (const r of running.values()) if (r.idle !== undefined) clearTimeout(r.idle) }))
      const loaded = [...running.values()].map((r) => r.manifest)
      const reg = yield* Effect.try({
        try: () => manifestRegistry(loaded),
        catch: (e) => (e instanceof PluginConfigError ? e : new PluginConfigError(String(e))),
      })

      /** One call into a plugin's process; an idle process is stopped after `idleMs` and restarts on the next call. */
      const invoke = (r: Running, method: string, params: unknown) =>
        Effect.gen(function* () {
          if (r.disabled) return yield* Effect.fail({ _tag: "PluginCrashed" as const, message: `plugin ${r.manifest.name} is disabled` })
          if (r.idle !== undefined) clearTimeout(r.idle)
          r.inflight++
          return yield* r.process.call(method, params, r.manifest.methods[method]?.deadlineMs).pipe(
            Effect.ensuring(Effect.sync(() => {
              r.inflight--
              if (r.inflight === 0) {
                r.idle = setTimeout(() => { if (r.inflight === 0) Effect.runFork(r.process.stop) }, opts.idleMs ?? IDLE_MS)
                // An idle timer must never keep a finished command (or the core) alive.
                r.idle.unref()
              }
            })),
          )
        })

      const graphPlugins = (method: string) => [...running.values()].filter((r) => r.manifest.archetype === "graph" && r.manifest.methods[method] !== undefined)
      const each = <A>(method: string, params: unknown) =>
        Effect.forEach(graphPlugins(method), (r) => invoke(r, method, params).pipe(Effect.map((v) => v as A), Effect.orElseSucceed(() => undefined)))
      const defined = <A>(xs: ReadonlyArray<A | undefined>) => xs.filter((x): x is A => x !== undefined)

      /** Structure from manifests, props from each owning plugin, then every graph plugin's lints. */
      const check = (before: Snapshot.Snapshot, after: Snapshot.Snapshot, changes: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          const d = diff(before, after)
          const structure = checkStructure(reg, { before, after, diff: d })
          const owners = new Set(
            [...d.added, ...d.changed.map((c) => c.after)].map((n) => reg.nodes.get(n.type)).filter((o): o is string => o !== undefined),
          )
          const props = yield* Effect.forEach([...owners], (o) => {
            const r = running.get(o)
            return r === undefined || r.manifest.methods.validate === undefined ? Effect.succeed([]) : invoke(r, "validate", { changes }).pipe(Effect.map((v) => (v as { findings: ReadonlyArray<Finding> }).findings), Effect.orElseSucceed(() => []))
          })
          const lints = yield* each<{ findings: ReadonlyArray<Finding> }>("lint", { before: json(before), after: json(after) })
          return [...structure, ...props.flat(), ...defined(lints).flatMap((l) => l.findings)]
        })

      // Calls in this process run one at a time: each reads the snapshot its changes are checked
      // against, so two at once would pick the same new ids. Other processes are caught by `expect`.
      const lock = yield* Semaphore.make(1)
      const call = (name: string, raw: unknown, expect: Expect = {}) =>
        Semaphore.withPermits(lock, 1)(Effect.gen(function* () {
          const [plugin, method] = name.split("/") as [string, string | undefined]
          const r = running.get(plugin)
          if (r === undefined || method === undefined || RESERVED.has(method) || r.manifest.methods[method] === undefined) {
            return yield* new ToolError({ message: `unknown tool "${name}"; run \`zarg tool list\`` })
          }
          const before = yield* store.snapshot
          const out = yield* invoke(r, method, raw).pipe(
            // The plugin's own message as it wrote it; the runtime's (crash, deadline) names the tool.
            Effect.mapError((e) => new ToolError({ message: e._tag === "PluginError" ? e.message : `${name}: ${e.message}` })),
          )
          const result = out as { changes?: ReadonlyArray<Snapshot.Change>; message?: string }
          if (!Array.isArray(result?.changes)) return yield* new ToolError({ message: `${name} did not return changes` })
          const after = Snapshot.applyChanges(before, result.changes)
          const d = diff(before, after)
          const findings = yield* check(before, after, result.changes)
          const errors = findings.filter((f) => f.severity === "error")
          // @card UX-0006
          if (errors.length > 0) return yield* new LintFailed({ findings: errors })
          // Guard against writes that land between our read and our commit.
          const touched: Record<string, string> = {}
          for (const c of result.changes) {
            const id = c._tag === "Put" ? c.node.id : c.id
            const cur = before.nodes.get(id)
            touched[id] = cur === undefined ? "absent" : hash(cur)
          }
          yield* store.commit(result.changes, { ...touched, ...expect })
          return {
            message: String(result.message ?? ""),
            added: d.added.map((n) => n.id),
            changed: d.changed.map((c) => c.id),
            removed: d.removed.map((n) => n.id),
            warnings: findings,
          }
        }))

      const lint = Effect.flatMap(store.snapshot, (after) =>
        check(Snapshot.empty, after, [...after.nodes.values()].map((node) => ({ _tag: "Put", node }))),
      )

      // @card UX-0001
      const agenda = (focus?: ReadonlySet<string>) =>
        Effect.gen(function* () {
          const loadedGraph = yield* store.load
          const items = yield* each<ReadonlyArray<AgendaItem>>("agenda", {})
          return [...hostItems, ...problemItems(loadedGraph), ...defined(items).flat()]
            .filter((item) => inFocus(focus, item.about))
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
        })

      const suggest = (focus?: ReadonlySet<string>) =>
        Effect.map(each<ReadonlyArray<AgendaItem>>("suggest", {}), (items) => defined(items).flat().filter((item) => inFocus(focus, item.about)))

      const render = (focus?: ReadonlySet<string>) =>
        Effect.map(each<string>("render", focus === undefined ? {} : { focus: [...focus] }), (parts) => defined(parts).filter((s) => s.length > 0).join("\n\n"))

      const affected = (before: Snapshot.Snapshot, after: Snapshot.Snapshot) =>
        Effect.map(each<Affected>("affected", { before: json(before), after: json(after) }), (parts) => ({
          cards: [...new Set(defined(parts).flatMap((p) => p.cards))].sort(),
          removed: [...new Set(defined(parts).flatMap((p) => p.removed))].sort(),
        }))

      return {
        tools: loaded.flatMap((m) =>
          Object.entries(m.methods)
            .filter(([k, spec]) => spec.agents && !RESERVED.has(k))
            .map(([k, spec]) => ({ name: `${m.name}/${k}`, description: spec.doc, params: spec.params })),
        ),
        manifests: loaded,
        call,
        lint,
        agenda,
        suggest,
        render,
        affected,
        exclusive: Semaphore.withPermits(lock, 1),
      }
    }),
  )
