import { BunServices } from "@effect/platform-bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Layer, Scope as EffectScope } from "effect"
import { Decisions, layer as decisionsLayer } from "@zarg/decisions"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { type Bound } from "@zarg/kernel"
import { Config, Env, layer as envLayer, Model, redact } from "@zarg/model"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "@zarg/plugin-gherkin/server"
import { openrouter } from "@zarg/provider-openrouter"
import { zargRouter } from "@zarg/provider-zarg-router"
import { type Asker, decisionsService, fsRead, graph, inquire, pluginService, Rlm, type Scope, settings } from "@zarg/rlm"
import { makeLog } from "./log"
import { STUB_MODEL, stubLayer } from "./stub"
import { reconcileGate, type ReconcileSettings } from "./phases"
import { makeReconcile } from "./reconcile"
import type { ReconcileAnswer } from "./server"
import { makeThreads } from "./threads"

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

    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        if (name === "Gherkin") return pluginService(gherkin, ctx)
        if (name === "Fs:read") return fsRead({ root, scope, sensitive })
        if (name === "Inquire") return inquire(asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        return undefined
      }
      return Rlm.make({ settings: rlmSettings, services: factory, roles, decisions, observe }).pipe(
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
          Rlm.make({ settings: rlmSettings, services, roles, decisions, observe }).pipe(Effect.provideService(Model.Model, model)),
        extra: (name) => (name === "Decisions" ? decisionsService(decisions as never) : undefined),
        // Landing writes graph files: no driver write may land halfway through it.
        withGraphLock: (effect) => host.exclusive(effect),
      }).pipe(Effect.provideService(EffectScope.Scope, scope))
    const gate = yield* reconcileGate(root, config.extra, roles)
    // stderr: stdout carries the `ready` handshake a starting client waits for.
    if (!gate.on) yield* Effect.sync(() => console.error(`zarg-core: ${gate.reason}`))
    let reconcile = gate.on ? yield* startReconcile(gate.settings) : undefined
    const agenda = (focus: ReadonlySet<string> | undefined) =>
      Effect.map(host.agenda(focus), (items) => [...(reconcile?.agenda(focus) ?? []), ...items])
    const threads = yield* makeThreads({ log, agenda, makeRlm, extra: reconcile?.threads ?? [] })

    // @card UX-0058 @card UX-0059
    /** `/reconcile`: turn plan and implement on for this session (the config's section and `enabled` are overridden). */
    const turnOn = Effect.gen(function* () {
      if (reconcile === undefined) {
        const forced = yield* reconcileGate(root, config.extra, roles, { force: true })
        if (!forced.on) return { on: false, reason: forced.reason } satisfies ReconcileAnswer
        reconcile = yield* startReconcile(forced.settings)
        for (const t of reconcile.threads) threads.add(t)
      }
      reconcile.notify()
      return { on: true, pending: yield* reconcile.pending } satisfies ReconcileAnswer
    }).pipe(Effect.catchCause((cause) => Effect.succeed({ on: false, reason: String(Cause.squash(cause)) } satisfies ReconcileAnswer)))
    return { log, threads, driver: roles.driver, turnOn }
  })

/** Layers for a project root: env, config, models, decisions, graph and plugins. `stubFile` swaps in the scripted models. */
export const liveLayer = (root: string, stubFile?: string) => {
  const base = Layer.merge(envLayer(root), BunServices.layer)
  const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
  const decisions =
    stubFile !== undefined
      ? Layer.provideMerge(stubLayer(stubFile), config)
      : Layer.provideMerge(decisionsLayer(), Layer.provideMerge(Model.layer([zargRouter, openrouter]), config))
  const graphs = Layer.provideMerge(hostLayer([gherkin]), graphLayer(join(root, ".zarg", "graph")))
  return Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))
}
