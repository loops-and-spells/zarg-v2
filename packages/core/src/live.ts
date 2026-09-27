import { BunServices } from "@effect/platform-bun"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Layer, Scope as EffectScope, Semaphore, Stream } from "effect"
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
import { makeLog } from "./log"
import { makeYolo, PluginControl, pluginHostLayer, USER_DIR, vaultFrom } from "./plugins"
import { STUB_MODEL, stubLayer } from "./stub"
import { reasonOf, reconcileGate, type ReconcileSettings } from "./phases"
import { checkoutProblem, gitRun } from "@zarg/reconcile"
import { makeReconcile } from "./reconcile"
import type { ReconcileAnswer } from "./server"
import { makeThreads } from "./threads"
import * as E from "./events"
import { makeRehearse, type Rehearse } from "./rehearse/run"
import { commitGraph, rehearseService } from "./rehearse/service"
import { rehearseSettings } from "./rehearse/settings"
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
    // Rehearse is made after the threads (it wakes main); the driver's service and the agenda reach it through this.
    const rehearseRef: { current?: Rehearse } = {}
    // A child's graph focus must name real nodes.
    const unknownIds = (ids: ReadonlyArray<string>) => Effect.map(store.snapshot, (snap) => ids.filter((id) => !snap.nodes.has(id))).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      // One driver item: graph writes wait for an answered question.
      const guard = askFirst(asker)
      const outside = outsideReads({ grants: agentGrants, userDir: USER_DIR, ask: asker.ask })
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        // A plugin's agent methods, by the service name its manifest declares; graph writes wait for an answer.
        const plugin = host.manifests.find((m) => m.service === name)
        if (plugin !== undefined) return guard.gate(pluginService(plugin, ctx))
        if (name === "Fs:read") return fsRead({ root, scope, sensitive, outside })
        if (name === "Inquire") return inquire(guard.asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        if (name === "Rehearse")
          return rehearseRef.current === undefined
            ? undefined
            : rehearseService({
                rehearse: rehearseRef.current,
                guard,
                stepNow: (card) => host.step(card).pipe(Effect.orElseSucceed(() => undefined)),
                neighbors: (card) => Effect.map(store.snapshot, (snap) => (snap.nodes.get(card)?.edges ?? []).map((e) => e.to)).pipe(Effect.orElseSucceed(() => [])),
                commit: (ids, message) => host.exclusive(commitGraph(root, ids, message)),
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
      Effect.map(host.agenda(focus), (items): ReadonlyArray<AgendaItem> => [...(reconcile?.agenda(focus) ?? []), ...(rehearseRef.current?.agenda(focus) ?? []), ...items])
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
      alsoStop: Effect.suspend(() => rehearseRef.current?.stop ?? Effect.void),
    })
    // A plugin's grant question is asked on main, like any driver question.
    const main = yield* threads.get("main", [])
    const intentText = () => {
      const dir = join(root, "intent")
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n\n") : ""
    }
    const rehearse = yield* makeRehearse({
      dir: join(root, ".zarg", "rehearse"),
      log,
      stories: (strategy, focus) => host.stories(strategy, focus),
      step: (card, via) => host.step(card, via),
      decide: (req) => decisions.decide(req),
      model,
      settings: rehearseSettings(config.extra, roles),
      intent: intentText,
      built: (card) => Effect.map(gitRun(root, ["grep", "-q", "-w", "-e", `@card ${card}`]), (r) => r.code === 0),
      announce: (text) => Effect.asVoid(Effect.forEach(E.textMessage(`main-${crypto.randomUUID()}`, "assistant", text), (d) => log.append("main", d))),
      // Wake the driver only when it waits on nothing: a question on screen keeps its turn.
      wake: Effect.suspend(() => main.wake),
    })
    rehearseRef.current = rehearse
    threads.add(rehearse.thread)
    yield* rehearse.resume
    const control = yield* PluginControl
    const yolo = makeYolo(log, control.yolo)
    // Started with --yolo: say so on main, so the status line shows it.
    if (control.yolo.any()) yield* yolo.set(true)
    control.setAsk((q) =>
      main
        .ask({
          question: `Plugin ${q.plugin} wants to ${q.what}.`,
          options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.id === "once" ? { recommended: true } : {}) })),
          allowOther: false,
        })
        .pipe(Effect.map((a) => q.options.find((o) => o.id === a.choice)?.id ?? "deny")),
    )

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
    return { log, threads, driver: roles.driver, turnOn, yolo, rehearse }
  })

/** The project's plugin host options from its environment and config (`[plugins.<name>]` tables). */
const pluginsFor = (root: string, env: Env["Service"], config: Config.ZargConfig, sensitive: ReadonlyArray<SensitiveValue>, yolo?: boolean) => {
  const tables = (config.extra.plugins ?? {}) as Readonly<Record<string, unknown>>
  return pluginHostLayer({
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
      return pluginsFor(root, env, yield* Config.Config, yield* env.sensitive, opts.yolo)
    }),
  ).pipe(Layer.provide(config))
  const graphs = Layer.provideMerge(plugins, graphLayer(join(root, ".zarg", "graph")))
  return Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))
}
