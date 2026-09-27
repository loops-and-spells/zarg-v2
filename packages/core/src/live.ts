import { BunServices } from "@effect/platform-bun"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Layer, Schema, Scope as EffectScope, Semaphore, Stream } from "effect"
import { LayoutSchema } from "@zarg/view"
import { Decisions, layer as decisionsLayer } from "@zarg/decisions"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { type Bound } from "@zarg/kernel"
import { Config, Env, layer as envLayer, Model, redact, type SensitiveValue } from "@zarg/model"
import { makeGrants } from "@zarg/plugin/runtime"
import { PluginHost } from "@zarg/plugin/server"
import { openrouter } from "@zarg/provider-openrouter"
import { zargRouter } from "@zarg/provider-zarg-router"
import { type Asker, decisionsService, fsRead, graph, inquire, pluginService, Rlm, type Scope, settings } from "@zarg/rlm"
import { askFirst } from "./driver"
import { judgeGaps } from "./gaps"
import { outsideReads } from "./outside"
import { nextGoals, type NextOption } from "./intent"
import { makeActions } from "./actions"
import { chosenFindings, commitGraph as commitGraphFindings, findingsService } from "./findings"
import { makeLog } from "./log"
import { pluginAgents } from "./plugin-agents"
import { forDriver, makeYolo, PluginControl, pluginHostLayer, USER_DIR, vaultFrom } from "./plugins"
import { STUB_MODEL, stubLayer } from "./stub"
import { reasonOf, reconcileGate, type ReconcileSettings } from "./phases"
import { checkoutProblem, gitRun } from "@zarg/reconcile"
import { makeReconcile } from "./reconcile"
import type { ReconcileAnswer } from "./server"
import { makeThreads } from "./threads"
import * as E from "./events"
import type { AgendaItem } from "@zarg/plugin/server"

/**
 * Everything a real core needs for a project: the 2a runtime, the thread log and the threads.
 * With `stub`, every role uses the scripted stub model (see `stubLayer`).
 */
export const liveCore = (root: string, opts: { readonly stub?: boolean } = {}) =>
  Effect.gen(function* () {
    const config = yield* Config.Config
    const roles: Readonly<Record<string, string>> = opts.stub
      ? { ...Object.fromEntries(Object.keys(config.roles).map((r) => [r, STUB_MODEL])), driver: STUB_MODEL, plan: STUB_MODEL, implement: STUB_MODEL }
      : config.roles
    const model = yield* Model.Model
    const env = yield* Env
    const host = yield* PluginHost
    const store = yield* GraphStore
    const decisions = yield* Decisions
    const sensitive = yield* env.sensitive
    const rlmSettings = yield* settings(config.extra.rlm)
    const log = yield* makeLog(join(root, ".zarg", "threads"), (t) => redact(t, sensitive))
    const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))

    // Agents may read outside the repository (porting from another project) once the developer allows it.
    const agentGrants = yield* makeGrants({ file: join(USER_DIR, "grants.json"), project: root })
    // /yolo (for every plugin) also lets agents' reads outside the repository through without asking.
    const control = yield* PluginControl
    const yoloControl = control.yolo
    // The developer's applied findings, recorded by the core (the findings gate reads them).
    const chosen = chosenFindings(join(root, ".zarg", "findings"))
    // A child's graph focus must name real nodes.
    const unknownIds = (ids: ReadonlyArray<string>) => Effect.map(store.snapshot, (snap) => ids.filter((id) => !snap.nodes.has(id))).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      // One driver item: graph writes wait for an answered question.
      const guard = askFirst(asker)
      const outside = outsideReads({ grants: agentGrants, userDir: USER_DIR, ask: asker.ask, yolo: () => yoloControl.on("zarg:agents") })
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        // A plugin's agent methods, by the service name its manifest declares; graph writes wait for an answer.
        const plugin = host.manifests.find((m) => m.service === name)
        // Graph writes wait for the developer; a service plugin's tools (Rehearse.run) do not write the graph.
        if (plugin !== undefined) return plugin.archetype === "service" ? pluginService(plugin, ctx) : guard.gate(pluginService(plugin, ctx))
        if (name === "Fs:read") return fsRead({ root, scope, sensitive, outside })
        if (name === "Inquire") return inquire(guard.asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        if (name === "Findings")
          return findingsService({
            dir: join(root, ".zarg", "findings"),
            invoke: (plugin, method, params) => host.invoke(plugin, method, params),
            guard,
            chosen,
            trusted: (plugin) => control.firstParty(plugin),
            neighbors: (card) => Effect.map(store.snapshot, (snap) => (snap.nodes.get(card)?.edges ?? []).map((e) => e.to)).pipe(Effect.orElseSucceed(() => [])),
            commit: (ids, message) => host.exclusive(commitGraphFindings(root, ids, message)),
          })
        return undefined
      }
      return Rlm.make({ settings: rlmSettings, services: factory, roles, decisions, observe, unknownIds }).pipe(
        Effect.provideService(Model.Model, model),
      )
    }
    // Plan and implement: the reconcile loop, unless `[reconcile] enabled = false`.
    // The core's own scope: reconcile started later (by /reconcile) closes with the core.
    const scope = yield* Effect.scope
    const startReconcile = (settings: ReconcileSettings) =>
      makeReconcile({
        repo: root,
        settings,
        log,
        sensitive,
        makeRlm: (services, observe) =>
          Rlm.make({ settings: rlmSettings, services, roles, decisions, observe, unknownIds }).pipe(Effect.provideService(Model.Model, model)),
        extra: (name) => (name === "Decisions" ? decisionsService(decisions as never) : undefined),
        // Landing writes graph files: no driver write may land halfway through it.
        withGraphLock: (effect) => host.exclusive(effect),
        pluginHost: pluginsFor(root, env, config, sensitive),
        affected: (before, after) => host.affected(before, after),
      }).pipe(Effect.provideService(EffectScope.Scope, scope))
    const gate = yield* reconcileGate(root, config.extra, roles)
    // stderr: stdout carries the `ready` handshake a starting client waits for.
    if (!gate.on) yield* Effect.sync(() => console.error(`zarg-core: ${gate.reason}`))
    let reconcile = gate.on ? yield* startReconcile(gate.settings) : undefined
    const agenda = (focus: ReadonlySet<string> | undefined) =>
      Effect.map(host.agenda(focus), (items): ReadonlyArray<AgendaItem> => [...(reconcile?.agenda(focus) ?? []), ...forDriver(items)])
    // The same scope filter the driver's Graph.render applies.
    const render = (ids: ReadonlyArray<string>, scope: Scope) => Effect.map(graph({ host, snapshot, scope }).handlers.render!({ focus: ids }), String)
    // What next: failure candidates a decision model judges real.
    const suggest = (focus: ReadonlySet<string> | undefined) => Effect.flatMap(host.suggest(focus), (c) => judgeGaps(decisions.decide, c))
    // What zarg offers when nothing is open: the intent's next goals; without an intent, where journeys start.
    const whatNext = (focus: ReadonlySet<string> | undefined) =>
      Effect.gen(function* () {
        const dir = join(root, "intent")
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : []
        const goals = files.flatMap((f) => nextGoals(readFileSync(join(dir, f), "utf8"), `intent/${f}`))
        if (goals.length > 0) return goals
        const snap = yield* store.snapshot
        return [...snap.nodes.values()]
          .filter((n) => n.type === "gherkin/state" && n.props.entry === true && (focus === undefined || focus.has(n.id)))
          .map((n): NextOption => ({ id: n.id, label: String(n.props.text ?? n.id), task: `Work on the journey that starts at "${String(n.props.text ?? n.id)}" (${n.id}).` }))
      })
    const threads = yield* makeThreads({
      log,
      agenda,
      render,
      suggest,
      whatNext,
      makeRlm,
      extra: reconcile?.threads ?? [],
      // The developer's stop is for everything: service plugins that run in the background stop too.
      alsoStop: Effect.suspend(() =>
        Effect.forEach(host.manifests.filter((m) => m.archetype === "service" && m.methods.stop !== undefined), (m) => Effect.ignore(host.invoke(m.name, "stop", {})), { discard: true }),
      ),
    })
    // A plugin's grant question is asked on main, like any driver question.
    const main = yield* threads.get("main", [])
    const yolo = makeYolo(log, control.yolo, host.loadWaiting)
    // This core's YOLO state (on with --yolo, off otherwise): a replayed state from an earlier core must not linger.
    yield* yolo.announce
    // A plugin's agenda changed (findings to take up): the driver wakes if it waits on nothing.
    control.setAgendaChanged(() => Effect.runFork(main.wake))
    // Plugins' agents show in main's agents pane, each plugin in its own stream.
    // A plugin agent's view is one its manifest declares; a malformed one fails that agent's start.
    const layoutOf = (plugin: string, view: string) => {
      const l = host.manifests.find((m) => m.name === plugin)?.views?.find((v) => v.name === view)
      return l === undefined ? undefined : Schema.decodeUnknownSync(LayoutSchema)(l)
    }
    control.setAgents(pluginAgents(log, "main", layoutOf) as (plugin: string, event: unknown) => void)
    control.setAsk((q) =>
      main
        .ask({
          question: `Plugin ${q.plugin} wants to ${q.what}.`,
          options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.id === "once" ? { recommended: true } : {}) })),
          allowOther: false,
        })
        .pipe(Effect.map((a) => q.options.find((o) => o.id === a.choice)?.id ?? "deny")),
    )
    // Plugins that lack only their load grant: asked about now that main can ask (YOLO loads them without asking).
    yield* Effect.forkDetach(host.loadWaiting)

    // @card UX-0058 @card UX-0059
    /** `/reconcile`: turn plan and implement on for this session (the config's section and `enabled` are overridden). */
    // One at a time, and never cut short halfway: two presses must not start two reconcilers.
    const turnOnLock = yield* Semaphore.make(1)
    const turnOn = Effect.gen(function* () {
      const forced = reconcile === undefined ? yield* reconcileGate(root, config.extra, roles, { force: true }) : undefined
      if (forced !== undefined && !forced.on) return { on: false, reason: forced.reason } satisfies ReconcileAnswer
      // A checkout no pass can land on (detached HEAD, a rebase in progress): say so rather than promise a pass.
      const problem = yield* checkoutProblem(root).pipe(Effect.orElseSucceed(() => undefined))
      if (problem !== undefined) return { on: false, reason: `no pass can run: ${problem}` } satisfies ReconcileAnswer
      if (reconcile === undefined && forced?.on) {
        reconcile = yield* startReconcile(forced.settings)
        for (const t of reconcile.threads) threads.add(t)
      }
      if (reconcile === undefined) return { on: false, reason: "reconcile could not start" } satisfies ReconcileAnswer
      reconcile.notify()
      return { on: true, pending: yield* reconcile.pending } satisfies ReconcileAnswer
    }).pipe(
      Effect.catchCause((cause) => Effect.succeed({ on: false, reason: reasonOf(Cause.squash(cause), sensitive) } satisfies ReconcileAnswer)),
      Effect.uninterruptible,
      Semaphore.withPermits(turnOnLock, 1),
    )
    const actions = makeActions({ invoke: (plugin, method, params) => host.invoke(plugin, method, params), onApply: (plugin, rows) => chosen.add(plugin, rows) })
    // A plugin's slash command calls its method with the words after it; its notice shows.
    const commands = {
      list: () => host.commands(),
      run: (plugin: string, cmd: string, args: ReadonlyArray<string>) => {
        const c = host.commands().find((x) => x.plugin === plugin && x.cmd === cmd)
        if (c === undefined) return Effect.succeed({ notice: `unknown command: ${cmd}` })
        return host.invoke(plugin, c.method, { args }).pipe(
          Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
          Effect.catch((e) => Effect.succeed({ notice: e.message })),
        )
      },
    }
    return { log, threads, driver: roles.driver, turnOn, yolo, actions, commands }
  })

/** The project's plugin host options from its environment and config (`[plugins.<name>]` tables). */
const pluginsFor = (
  root: string,
  env: Env["Service"],
  config: Config.ZargConfig,
  sensitive: ReadonlyArray<SensitiveValue>,
  yolo?: boolean,
  models?: { readonly decide: NonNullable<Parameters<typeof pluginHostLayer>[0]["decide"]>; readonly complete: NonNullable<Parameters<typeof pluginHostLayer>[0]["complete"]> },
) => {
  const tables = (config.extra.plugins ?? {}) as Readonly<Record<string, unknown>>
  return pluginHostLayer({
    ...(models ?? {}),
    root,
    listed: Object.keys(tables).filter((name) => (tables[name] as { source?: unknown } | undefined)?.source !== undefined),
    pluginConfig: (name) => tables[name] ?? {},
    vault: vaultFrom(env.get),
    redact: (t) => redact(t, sensitive),
    ...(yolo !== undefined ? { yolo } : {}),
  })
}

/** Layers for a project root: env, config, models, decisions, graph and plugins. `stubFile` swaps in the scripted models. */
export const liveLayer = (root: string, stubFile?: string, opts: { readonly yolo?: boolean } = {}) => {
  const base = Layer.merge(envLayer(root), BunServices.layer)
  const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
  const decisions =
    stubFile !== undefined
      ? Layer.provideMerge(stubLayer(stubFile), config)
      : Layer.provideMerge(decisionsLayer(), Layer.provideMerge(Model.layer([zargRouter, openrouter]), config))
  const plugins = Layer.unwrap(
    Effect.gen(function* () {
      const env = yield* Env
      const cfg = yield* Config.Config
      const decisions = yield* Decisions
      const model = yield* Model.Model
      // Service plugins reach the decision model and the model roles through the core's own services.
      const roles: Readonly<Record<string, string>> = stubFile !== undefined ? Object.fromEntries(Object.keys(cfg.roles).map((r) => [r, STUB_MODEL])) : cfg.roles
      const complete = (req: { readonly role: string; readonly messages: ReadonlyArray<unknown>; readonly outputSchema?: unknown; readonly maxTokens?: number }) =>
        Effect.gen(function* () {
          const ref = roles[req.role] ?? roles.driver ?? STUB_MODEL
          const events = yield* Stream.runCollect(
            model.stream({ model: ref, messages: req.messages as never, ...(req.outputSchema !== undefined ? { outputSchema: req.outputSchema as Record<string, unknown> } : {}), ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}) }),
          )
          let text = ""
          let promptTokens = 0
          let completionTokens = 0
          for (const e of events) {
            if (e.type === "text") text += e.delta
            if (e.type === "usage") {
              promptTokens += e.usage.promptTokens
              completionTokens += e.usage.completionTokens
            }
          }
          return { text, promptTokens, completionTokens }
        })
      return pluginsFor(root, env, cfg, yield* env.sensitive, opts.yolo, { decide: (req) => decisions.decide(req as never), complete })
    }),
  ).pipe(Layer.provide(decisions))
  const graphs = Layer.provideMerge(plugins, graphLayer(join(root, ".zarg", "graph")))
  return Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))
}
