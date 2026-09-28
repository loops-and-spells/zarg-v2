import { Cause, Context, Data, Effect, Exit, Layer, type Redacted, Scope, Semaphore } from "effect"
import { keysProblem, type Layout, opensProblem, reviewProblem, surfacesProblem, tonesProblem } from "@zarg/view"
import { diff, type Expect, GraphStore, type GraphError, hash, type IoError, type Loaded, Snapshot } from "@zarg/graph"
import { type Ask, type Grants, type ManifestScopes, makePowers, PLUGIN_NAME, PluginCallError, type PluginProcess, scopesDigest, served, spawnPlugin, warnings } from "../runtime"
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
    /** Stories for testers over every graph plugin that plans them (rehearse). */
    readonly stories: (strategy: "edge-pair" | "teleport", focus?: ReadonlySet<string>) => Effect.Effect<{ readonly stories: ReadonlyArray<ReadonlyArray<string>>; readonly unreachable: number }, IoError>
    /** What a tester sees at a card, from the plugin that owns it; undefined for an unknown card. */
    readonly step: (card: string, via?: string) => Effect.Effect<Record<string, unknown> | undefined, IoError>
    /** Slash commands the loaded plugins add. */
    readonly commands: () => ReadonlyArray<{ readonly plugin: string; readonly cmd: string; readonly desc: string; readonly method: string; readonly arg: unknown }>
    /** Call any method of a loaded plugin (the core's reserved calls: act, finding, resolved, stop). */
    readonly invoke: (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>
    /** Run `effect` with no tool call committing meanwhile (e.g. while landing a commit that writes graph files). */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    /**
     * Load plugins that lacked only their load grant: with YOLO on for a plugin it loads as declared (nothing is
     * saved); otherwise the operator is asked (Allow saves the grant). Dependents follow their dependencies.
     */
    readonly loadWaiting: Effect.Effect<void>
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
  /** zarg's user directory (grants, installed plugins): never reachable by a plugin's file powers. */
  readonly userDir?: string
  /** The project: plugins' relative paths and fs globs are under it. */
  readonly projectRoot?: string
  /** The decision model for plugins with the decisions scope. */
  readonly decide?: (req: unknown) => Effect.Effect<unknown, unknown>
  /** A model role for plugins with the models scope. */
  readonly complete?: (req: { readonly role: string; readonly messages: ReadonlyArray<unknown>; readonly outputSchema?: unknown; readonly maxTokens?: number }) => Effect.Effect<{ readonly text: string; readonly promptTokens: number; readonly completionTokens: number }, unknown>
  /** A plugin's agents events (start, status, step, end), for the agents pane. */
  readonly agents?: (plugin: string, event: unknown) => void
  /** A plugin said its agenda changed. */
  readonly agendaChanged?: (plugin: string) => void
  /** Per plugin: decisions and tokens per hour. */
  readonly budget?: (plugin: string) => { readonly decisionsPerHour: number; readonly tokensPerHour: number } | undefined
}

/** Names cells already use: a plugin can never take one over (e.g. become `Inquire` and answer for you). */
const RESERVED_SERVICES = new Set(["Graph", "Fs", "Sh", "Verify", "Agenda", "Inquire", "Decisions", "Rlm", "Effect", "Eff", "Failure", "console"])
const SERVICE = /^[A-Z][A-Za-z0-9]*$/
const METHOD = /^[a-z][a-zA-Z0-9]*(-[a-z0-9]+)*$/

/** Why a manifest cannot load, before any of its code runs. */
const manifestProblem = (m: Manifest): string | undefined => {
  if (!PLUGIN_NAME.test(String(m.name))) return `name "${m.name}" must be kebab-case (no doubled or trailing dash)`
  if (!SERVICE.test(String(m.service))) return `service "${m.service}" must be PascalCase`
  if (RESERVED_SERVICES.has(m.service)) return `service "${m.service}" is zarg's own`
  if (m.archetype !== "graph" && m.archetype !== "provider" && m.archetype !== "service" && m.archetype !== "agent") return `archetype "${m.archetype}" is unknown`
  // A bundle runs sandboxed; trusted agents are zarg's own packages, which the core loads itself.
  if (m.runtime === "trusted") return "a plugin bundle cannot run trusted: trusted agents are zarg's own packages, loaded by the core"
  const bad = Object.keys(m.methods ?? {}).find((k) => !METHOD.test(k))
  if (bad !== undefined) return `method "${bad}" is not a method name`
  const command = (m.commands ?? []).map(commandProblem(m)).find((p) => p !== undefined)
  if (command !== undefined) return command
  // An action on a key the shell keeps (or one key twice): the SDK refuses it at build, a hand-made manifest here.
  const views = Array.isArray(m.views) ? m.views : []
  const view = views.map(viewProblem).find((p) => p !== undefined)
  if (view !== undefined) return view
  const review = views.map((v) => { try { return reviewProblem(v as Layout) } catch { return "a view is malformed" } }).find((p) => p !== undefined)
  if (review !== undefined) return review
  const surfaces = surfacesProblem(m.surfaces, views as ReadonlyArray<Layout>)
  if (surfaces !== undefined) return surfaces
  const tones = (() => { try { return tonesProblem(views as ReadonlyArray<Layout>) } catch { return "a view is malformed" } })()
  if (tones !== undefined) return tones
  return opensProblem(views as ReadonlyArray<Layout>, Array.isArray(m.surfaces) ? (m.surfaces as ReadonlyArray<{ name: string }>) : [])
}

/** A view's key mappings, checked; a manifest is untrusted, so a view that is not even a layout is refused too. */
const viewProblem = (v: unknown): string | undefined => {
  try {
    return keysProblem(v as Layout)
  } catch {
    return "a view is malformed"
  }
}

/** Methods the core calls for the operator: while one runs, the plugin may open tiles, sheets and popovers. */
const GESTURES = new Set(["act", "$answer", "$message"])

/** zarg's own slash commands: no plugin may take one. */
const BUILT_IN_COMMANDS = new Set(["/reconcile", "/yolo"])
const ARG_KINDS = new Set(["none", "choice", "text", "path"])
const commandProblem = (m: Manifest) => (c: { readonly cmd: unknown; readonly desc: unknown; readonly method: unknown; readonly arg: unknown }): string | undefined => {
  const cmd = String(c?.cmd)
  if (!/^\/[a-z][a-z0-9-]*$/.test(cmd)) return `command "${cmd}" must be /kebab-case`
  if (BUILT_IN_COMMANDS.has(cmd)) return `command ${cmd} is zarg's own`
  if (typeof c.desc !== "string") return `command ${cmd} has no description`
  const method = String(c.method)
  if (!Object.hasOwn(m.methods ?? {}, method) || RESERVED.has(method)) return `command ${cmd} calls ${method}, which is not one of its methods`
  const kind = (c.arg as { kind?: unknown } | null)?.kind
  return typeof kind === "string" && ARG_KINDS.has(kind) ? undefined : `command ${cmd} has an unknown argument kind`
}

/** Replace every secret value the plugin was served, anywhere in what it returns. */
const scrub = (value: unknown, secrets: ReadonlySet<string>): unknown => {
  if (secrets.size === 0) return value
  if (typeof value === "string") {
    let out = value
    for (const s of secrets) out = out.replaceAll(s, "<redacted:plugin-secret>")
    return out
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets))
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, secrets), scrub(v, secrets)]))
  return value
}

/** Methods the host calls on graph plugins; never offered as tools. */
const RESERVED = new Set(["validate", "lint", "agenda", "suggest", "render", "affected", "stories", "step", "personas", "journeys", "act", "finding", "resolved", "stop"])
const IDLE_MS = 10 * 60_000
const RESTART_WINDOW_MS = 10 * 60_000
const MAX_RESTARTS = 3

const problemItems = (loaded: Loaded): ReadonlyArray<AgendaItem> =>
  loaded.problems.map((p) => ({ id: `invalid-file:${p.file}`, title: `Fix ${p.file}`, detail: p.message, about: [], priority: 1 }))

/** A plugin's item: marked with its plugin (its text is untrusted), its id under the plugin's name, never above zarg's own. */
const fromPlugin = (name: string) => (i: AgendaItem): AgendaItem => ({
  id: String(i.id).startsWith(`${name}:`) ? String(i.id) : `${name}:${i.id}`,
  title: String(i.title),
  detail: String(i.detail ?? ""),
  about: Array.isArray(i.about) ? i.about.map(String) : [],
  priority: Math.max(1, Number(i.priority) || 1),
  plugin: name,
})

const inFocus = (focus: ReadonlySet<string> | undefined, about: ReadonlyArray<string>) =>
  focus === undefined || about.length === 0 || about.some((id) => focus.has(id))

// Reserved ids (files that failed to load) travel too: a plugin must never hand one out again.
const json = (s: Snapshot.Snapshot) => ({ nodes: [...s.nodes.values()], reserved: [...s.reserved] })

const scopeWords = (s: ManifestScopes) =>
  [
    s.graph === "read" ? "read your graph" : s.graph === "write" ? "change your graph" : undefined,
    ...(s.net === "ask" ? ["reach hosts it asks for"] : (s.net ?? []).map((h) => `reach ${h}`)),
    ...(s.secrets ?? []).map((k) => `use the secret ${k}`),
    ...(s.fs?.read === "ask" ? ["read files it asks for"] : (s.fs?.read ?? []).map((g) => `read ${g}`)),
    ...(s.fs?.write === "ask" ? ["write files it asks for"] : (s.fs?.write ?? []).map((g) => `write ${g}`)),
    s.decisions === true ? "use the decision model" : undefined,
    ...((s.models ?? []).length > 0 ? [`use the model roles ${s.models!.join(", ")}`] : []),
    s.agents === true ? "show agents" : undefined,
  ].filter((p) => p !== undefined)

/** What a plugin asks for, in words: what it gets now and what it may ask for later (both are approved). */
export const describeScopes = (m: { readonly scopes: ManifestScopes; readonly optional: ManifestScopes; readonly pluginDependencies?: ReadonlyArray<{ readonly name: string }> }): string => {
  const now = [...scopeWords(m.scopes), ...(m.pluginDependencies ?? []).map((d) => `use ${d.name} (and read what it serves)`)]
  const later = scopeWords(m.optional ?? {})
  const head = now.length > 0 ? now.join(", ") : later.length > 0 ? "nothing now" : "nothing"
  return later.length > 0 ? `${head}; may ask to ${later.join(", ")}` : head
}

/** A plugin with no network, secret or file scope can only touch the graph. */
const graphOnly = (m: Manifest) => m.scopes.net === undefined && m.scopes.secrets === undefined && m.scopes.fs === undefined

interface Running {
  readonly manifest: Manifest
  readonly process: PluginProcess
  readonly restarts: Array<number>
  disabled: boolean
  inflight: number
  /** Calls it is handling for the operator (an action, an answer, a message, a slash command): its gestures. */
  gestures: number
  /** Questions it waits on the operator for (grants, its agents' conversations): it is not idle then. */
  readonly asking: () => number
  idle?: ReturnType<typeof setTimeout>
  /** Secret values the host served this plugin: scrubbed from all it returns. */
  readonly served: ReadonlySet<string>
}

export const layer = (plugins: ReadonlyArray<LoadedPlugin>, opts: HostOptions): Layer.Layer<PluginHost, PluginConfigError, GraphStore> =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const store = yield* GraphStore
      const scope = yield* Effect.scope
      const hostItems: Array<AgendaItem> = [...(opts.notices ?? [])]
      const running = new Map<string, Running>()
      const failed = (m: Manifest, why: string) =>
        void hostItems.push({ id: `plugin-failed:${m.name}`, title: `Plugin ${m.name} failed to load`, detail: why, about: [], priority: 1 })
      const services = new Set<string>()

      // Dependencies: a plugin in a cycle, or needing one that is not here, does not start at all.
      const byName = new Map(plugins.map((p) => [p.manifest.name, p.manifest]))
      const depsOf = (m: Manifest) => (m.pluginDependencies ?? []).map((d) => d.name)
      const cyclic = new Set<string>()
      for (const p of plugins) {
        const path: Array<string> = []
        const walk = (n: string): boolean => {
          if (path.includes(n)) {
            if (path[0] === n) path.forEach((x) => cyclic.add(x))
            return path[0] === n
          }
          const m = byName.get(n)
          if (m === undefined) return false
          path.push(n)
          const hit = depsOf(m).some(walk)
          path.pop()
          return hit
        }
        walk(p.manifest.name)
      }
      const needs = (m: Manifest, dep: string, why: string) =>
        void hostItems.push({ id: `plugin-needs:${m.name}:${dep}`, title: `Plugin ${m.name} needs ${dep}, which is not loaded`, detail: why, about: [], priority: 1 })
      const startable = plugins.filter((p) => {
        const m = p.manifest
        if (cyclic.has(m.name)) {
          failed(m, `its pluginDependencies form a cycle (${[...cyclic].join(" → ")})`)
          return false
        }
        const missing = depsOf(m).find((d) => !byName.has(d))
        if (missing !== undefined) {
          needs(m, missing, `${missing} is not installed.`)
          return false
        }
        return true
      })

      // Plugins that only lack their load grant: YOLO or the operator can still let them load (`loadWaiting`).
      const waiting: Array<LoadedPlugin> = []
      /** Start one plugin's process (its grant already settled); undefined, with an agenda item, when it cannot. */
      const spawnOne = (p: LoadedPlugin, digest: string) => Effect.gen(function* () {
        const m = p.manifest
        const restarts: Array<number> = []
        // While one of its questions waits on the operator, the plugin's call deadline stops.
        let asking = 0
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
          asking: (open) => void (asking += open ? 1 : -1),
          ...(opts.decide !== undefined ? { decide: (req: unknown) => Effect.runPromise(opts.decide!(req).pipe(Effect.mapError((e) => ({ tag: "DecisionError", message: String((e as { message?: string }).message ?? e) })))) } : {}),
          ...(opts.complete !== undefined ? { complete: (req: Parameters<NonNullable<HostOptions["complete"]>>[0]) => Effect.runPromise(opts.complete!(req).pipe(Effect.mapError((e) => ({ tag: "ModelError", message: String((e as { message?: string }).message ?? e) })))) } : {}),
          agendaChanged: () => opts.agendaChanged?.(m.name),
          // The host says whether the plugin acts for the operator now; a plugin's own `gesture` field is overwritten.
          agents: (e: unknown) => opts.agents?.(m.name, { ...(e !== null && typeof e === "object" ? e : {}), gesture: (running.get(m.name)?.gestures ?? 0) > 0 }),
          ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
          // A plugin working in the background (calling powers) is not idle.
          active: () => {
            const r = running.get(m.name)
            if (r?.disabled === true) throw { tag: "PluginError", message: `${m.name} is disabled` }
            if (r !== undefined && r.idle !== undefined && r.inflight === 0) {
              clearTimeout(r.idle)
              r.idle = setTimeout(() => { if (r.inflight === 0 && r.asking() === 0) Effect.runFork(r.process.stop) }, opts.idleMs ?? IDLE_MS)
              r.idle.unref()
            }
          },
          ...(opts.budget?.(m.name) !== undefined ? { budget: opts.budget(m.name)! } : {}),
          dependencies: (m.pluginDependencies ?? []).map((d) => ({ name: d.name, methods: byName.get(d.name)?.contract?.methods ?? [] })),
          // Looked up at call time: the dependency is running by then (checked below), or the call fails typed.
          callPlugin: (name, method, params) => {
            const dep = running.get(name)
            if (dep === undefined) return Promise.reject({ tag: "PluginError", message: `${name} is not loaded` })
            return Effect.runPromise(invoke(dep, method, params).pipe(Effect.mapError((e) => ({ tag: e._tag, message: e.message }))))
          },
          ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
        })
        const spawned = yield* spawnPlugin({
          name: m.name,
          bundle: p.bundle,
          powers,
          paused: () => asking > 0,
          onExit: (why) => {
            if (why === "stop") return
            const now = Date.now()
            restarts.push(now)
            while (restarts.length > 0 && now - restarts[0]! > RESTART_WINDOW_MS) restarts.shift()
            const r = running.get(m.name)
            if (r !== undefined && restarts.length >= MAX_RESTARTS && !r.disabled) {
              r.disabled = true
              hostItems.push({ id: `plugin-disabled:${m.name}`, title: `Plugin ${m.name} was disabled after ${MAX_RESTARTS} restarts`, detail: "It crashed or ran past its deadline three times in ten minutes. Restart zarg to try it again.", about: [], priority: 1 })
              disableDependents(m.name)
            }
          },
        }).pipe(Scope.provide(scope), Effect.exit)
        if (Exit.isFailure(spawned)) {
          const cause = spawned.cause.reasons.find((r) => r._tag === "Fail")?.error as { message?: string } | undefined
          return failed(m, String(cause?.message ?? "unknown error"))
        }
        // The bundle must be the plugin its manifest describes: grants and names come from the manifest.
        const id = spawned.value.identity
        if (id.name !== m.name || id.service !== m.service || id.archetype !== m.archetype) {
          yield* spawned.value.stop
          return failed(m, `its bundle says it is ${id.name ?? "?"}/${id.service ?? "?"}/${id.archetype ?? "?"}, its manifest ${m.name}/${m.service}/${m.archetype}`)
        }
        const r: Running = { manifest: m, process: spawned.value, restarts, disabled: false, inflight: 0, gestures: 0, served: served(powers), asking: () => asking }
        // A service plugin's services start now, not on its first call: a run a restart cut short resumes.
        if (m.archetype === "service" || m.archetype === "agent") yield* Effect.forkDetach(Effect.ignore(spawned.value.call("$start", {})))
        return r
      })
      // Checked and started together (a slow plugin does not hold up the others), kept in their given order.
      const started = yield* Effect.forEach(startable, (p) => Effect.gen(function* () {
        const m = p.manifest
        const problem = manifestProblem(m)
        if (problem !== undefined) return failed(m, problem)
        const digest = scopesDigest(m.scopes, m.optional, depsOf(m))
        const granted = (yield* opts.grants.of(m.name, digest)).loaded
        if (!granted && opts.firstParty(p) && graphOnly(m)) yield* opts.grants.approveLoad(m.name, digest)
        else if (!granted) {
          hostItems.push({
            id: `plugin-grant:${m.name}`,
            title: `Plugin ${m.name} asks for: ${describeScopes(m)}`,
            detail: [...warnings(m.scopes, m.optional, depsOf(m)).map((w) => `It ${w}.`), "zarg asks you to allow it (or /yolo on loads it)."].join(" "),
            about: [],
            priority: 1,
          })
          waiting.push(p)
          return undefined
        }
        return yield* spawnOne(p, digest)
      }), { concurrency: "unbounded" })
      /** A disabled plugin takes every plugin that needs it (directly or not) with it. */
      const disableDependents = (name: string) => {
        for (const d of running.values()) {
          if (d.disabled || !depsOf(d.manifest).includes(name)) continue
          d.disabled = true
          // Its background work must not go on without what it needs.
          Effect.runFork(d.process.stop)
          hostItems.push({ id: `plugin-disabled:${d.manifest.name}`, title: `Plugin ${d.manifest.name} was disabled: ${name}, which it needs, was disabled`, detail: "Restart zarg to try them again.", about: [], priority: 1 })
          disableDependents(d.manifest.name)
        }
      }
      for (const r of started) {
        if (r === undefined) continue
        if (running.has(r.manifest.name) || services.has(r.manifest.service)) {
          yield* r.process.stop
          failed(r.manifest, `another plugin already uses the name ${r.manifest.name} or the service ${r.manifest.service}`)
          continue
        }
        services.add(r.manifest.service)
        running.set(r.manifest.name, r)
      }

      // Dependencies in order: each must be running and serve the contract this plugin was built against.
      const order = [...running.keys()]
      let changed = true
      while (changed) {
        changed = false
        for (const name of order) {
          const r = running.get(name)
          if (r === undefined) continue
          for (const d of r.manifest.pluginDependencies ?? []) {
            const dep = running.get(d.name)
            const why = dep === undefined ? "it did not load (see its own item)" : dep.manifest.contract?.digest !== d.digest ? `${name} was built against a different ${d.name} (its contract changed); rebuild ${name}` : undefined
            if (why === undefined) continue
            yield* r.process.stop
            running.delete(name)
            services.delete(r.manifest.service)
            // A dependency waiting on its grant: this plugin waits with it and loads after it.
            const self = plugins.find((p) => p.manifest.name === name)
            if (dep === undefined && waiting.some((w) => w.manifest.name === d.name) && self !== undefined) waiting.push(self)
            else needs(r.manifest, d.name, why)
            changed = true
            break
          }
        }
      }

      yield* Effect.addFinalizer(() => Effect.sync(() => { for (const r of running.values()) if (r.idle !== undefined) clearTimeout(r.idle) }))
      const loaded: Array<Manifest> = [...running.values()].map((r) => r.manifest)
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
          const gesture = GESTURES.has(method) || (r.manifest.commands ?? []).some((c) => c.method === method)
          if (gesture) r.gestures++
          return yield* r.process.call(method, params, r.manifest.methods[method]?.deadlineMs).pipe(
            Effect.map((v) => scrub(v, r.served)),
            Effect.mapError((e) => new PluginCallError({ _tag: e._tag, message: scrub(e.message, r.served) as string })),
            Effect.ensuring(Effect.sync(() => {
              if (gesture) r.gestures--
              r.inflight--
              if (r.inflight === 0) {
                r.idle = setTimeout(() => { if (r.inflight === 0 && r.asking() === 0) Effect.runFork(r.process.stop) }, opts.idleMs ?? IDLE_MS)
                // An idle timer must never keep a finished command (or the core) alive.
                r.idle.unref()
              }
            })),
          )
        })

      // Only graph plugins granted graph access are shown the graph (hooks receive it whole).
      const graphPlugins = (method: string) =>
        [...running.values()].filter((r) => r.manifest.archetype === "graph" && r.manifest.scopes.graph !== undefined && r.manifest.methods[method] !== undefined)
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
          // A check that cannot run fails the write: never let a change through unchecked.
          const couldNot = (plugin: string, e: { readonly message: string }): ReadonlyArray<Finding> => [
            { severity: "error", code: "check-failed", message: `could not check with ${plugin}: ${e.message}`, about: [] },
          ]
          const findingsOf = (r: Running, method: string, params: unknown) =>
            invoke(r, method, params).pipe(
              Effect.map((v) => (v as { findings?: ReadonlyArray<Finding> }).findings ?? []),
              Effect.catch((e) => Effect.succeed(couldNot(r.manifest.name, e))),
            )
          const props = yield* Effect.forEach([...owners], (o) => {
            const r = running.get(o)
            if (r === undefined) return Effect.succeed(couldNot(o, { message: "the plugin that owns these nodes is not running" }))
            return r.manifest.methods.validate === undefined ? Effect.succeed([]) : findingsOf(r, "validate", { changes })
          })
          const lints = yield* Effect.forEach(graphPlugins("lint"), (r) => findingsOf(r, "lint", { before: json(before), after: json(after) }))
          return [...structure, ...props.flat(), ...lints.flat()]
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
          if (result.changes.length > 0 && r.manifest.scopes.graph !== "write") {
            return yield* new ToolError({ message: `${name}: plugin ${plugin} may not change the graph (its graph scope is ${r.manifest.scopes.graph ?? "none"})` })
          }
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
          // Every plugin with an agenda: graph plugins and service plugins alike.
          const items = yield* Effect.forEach(
            [...running.values()].filter((r) => r.manifest.methods.agenda !== undefined && (r.manifest.archetype !== "graph" || r.manifest.scopes.graph !== undefined)),
            (r) => invoke(r, "agenda", {}).pipe(Effect.map((v) => (v as ReadonlyArray<AgendaItem>).map(fromPlugin(r.manifest.name))), Effect.orElseSucceed(() => undefined)),
          )
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

      const stories = (strategy: "edge-pair" | "teleport", focus?: ReadonlySet<string>) =>
        Effect.map(each<{ stories: ReadonlyArray<ReadonlyArray<string>>; unreachable: number }>("stories", { strategy, ...(focus !== undefined ? { focus: [...focus] } : {}) }), (parts) => ({
          stories: defined(parts).flatMap((p) => p.stories),
          unreachable: defined(parts).reduce((n, p) => n + p.unreachable, 0),
        }))
      const step = (card: string, via?: string) =>
        Effect.map(each<Record<string, unknown> | null>("step", { card, ...(via !== undefined ? { via } : {}) }), (parts) => defined(parts).find((p) => p !== null) ?? undefined)

      const toolsOf = (m: Manifest): ReadonlyArray<ToolInfo> =>
        Object.entries(m.methods)
          .filter(([k, spec]) => spec.agents && !RESERVED.has(k))
          .map(([k, spec]) => ({ name: `${m.name}/${k}`, description: spec.doc, params: spec.params }))
      const tools: Array<ToolInfo> = loaded.flatMap(toolsOf)

      /** Start a waiting plugin now: its dependencies running with the contract it was built against. */
      const loadLate = (p: LoadedPlugin) =>
        Effect.gen(function* () {
          const m = p.manifest
          const ready = (m.pluginDependencies ?? []).every((d) => running.get(d.name)?.manifest.contract?.digest === d.digest)
          if (!ready || running.has(m.name) || services.has(m.service)) return false
          const r = yield* spawnOne(p, scopesDigest(m.scopes, m.optional, depsOf(m)))
          if (r === undefined) return false
          services.add(m.service)
          running.set(m.name, r)
          loaded.push(m)
          tools.push(...toolsOf(m))
          const at = hostItems.findIndex((i) => i.id === `plugin-grant:${m.name}`)
          if (at >= 0) hostItems.splice(at, 1)
          return true
        })
      const loadingLock = yield* Semaphore.make(1)
      const loadWaiting = Effect.gen(function* () {
        const declined = new Set<string>()
        for (let progress = true; progress; ) {
          progress = false
          for (const p of [...waiting]) {
            const m = p.manifest
            if (declined.has(m.name) || !depsOf(m).every((d) => running.has(d))) continue
            // A graph plugin changes the node types every tool checks against: it loads on the next start.
            if (m.archetype === "graph") continue
            const digest = scopesDigest(m.scopes, m.optional, depsOf(m))
            const granted = (yield* opts.grants.of(m.name, digest).pipe(Effect.orElseSucceed(() => ({ loaded: false })))).loaded
            if (!granted && !opts.yolo.on(m.name)) {
              const what = [`load, to ${describeScopes(m)}`, ...warnings(m.scopes, m.optional, depsOf(m)).map((w) => `(it ${w})`)].join(" ")
              const a = yield* opts.ask({ plugin: m.name, what, options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }] })
              if (a !== "always") {
                declined.add(m.name)
                continue
              }
              yield* opts.grants.approveLoad(m.name, digest).pipe(Effect.ignore)
            }
            waiting.splice(waiting.indexOf(p), 1)
            if (yield* loadLate(p)) progress = true
          }
        }
      }).pipe(Semaphore.withPermits(loadingLock, 1), Effect.catchCause((c) => Effect.sync(() => opts.log(`loading waiting plugins failed: ${Cause.pretty(c)}`))))

      return {
        tools,
        manifests: loaded,
        loadWaiting,
        call,
        lint,
        agenda,
        suggest,
        render,
        affected,
        stories,
        step,
        commands: () =>
          [...running.values()]
            .filter((r) => !r.disabled)
            .flatMap((r) => (r.manifest.commands ?? []).map((c) => ({ plugin: r.manifest.name, cmd: c.cmd, desc: c.desc, method: c.method, arg: c.arg }))),
        invoke: (plugin: string, method: string, params: unknown) => {
          const r = running.get(plugin)
          return r === undefined ? Effect.fail({ _tag: "NotLoaded", message: `plugin ${plugin} is not loaded` }) : invoke(r, method, params)
        },
        exclusive: Semaphore.withPermits(lock, 1),
      }
    }),
  )
