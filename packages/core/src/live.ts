import { BunServices } from "@effect/platform-bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
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
import { makeThreads } from "./threads"

/** Everything a real core needs for a project: the 2a runtime, the thread log and the threads. */
export const liveCore = (root: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Config
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
      return Rlm.make({ settings: rlmSettings, services: factory, roles: config.roles, decisions, observe }).pipe(
        Effect.provideService(Model.Model, model),
      )
    }
    const threads = yield* makeThreads({ log, agenda: (focus) => host.agenda(focus), makeRlm })
    return { log, threads }
  })

/** Layers for a project root: env, config, models, decisions, graph and plugins. */
export const liveLayer = (root: string) => {
  const base = Layer.merge(envLayer(root), BunServices.layer)
  const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
  const model = Layer.provideMerge(Model.layer([zargRouter, openrouter]), config)
  const decisions = Layer.provideMerge(decisionsLayer(), model)
  const graphs = Layer.provideMerge(hostLayer([gherkin]), graphLayer(join(root, ".zarg", "graph")))
  return Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))
}
