// Live smoke test: one real research RLM against this repository through the configured models.
// Run with `mise run smoke` from the repo root. Needs zarg-router (or the configured providers) up.
import { BunServices } from "@effect/platform-bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Decisions, layer as decisionsLayer } from "@zarg/decisions"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { Config, Env, layer as envLayer, Model } from "@zarg/model"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, gherkinHost } from "../test/gherkin-host"
import { openrouter } from "@zarg/provider-openrouter"
import { zargRouter } from "@zarg/provider-zarg-router"
import { type Bound } from "@zarg/kernel"
import { decisionsService, fsRead, graph, Rlm, type Scope, settings } from "../src"

const root = process.env.ZARG_ROOT ?? process.cwd()
const task = process.argv[2] ?? "Which functions does packages/graph/src/diff.ts export, and what does each do? One sentence each."
const scope: Scope = { paths: ["packages/graph/**"], kind: "research" }

const program = Effect.gen(function* () {
  const config = yield* Config.Config
  const model = yield* Model.Model
  const env = yield* Env
  const host = yield* PluginHost
  const store = yield* GraphStore
  const decisions = yield* Decisions
  const sensitive = yield* env.sensitive
  const role = config.roles.driver
  if (role === undefined) return yield* Effect.fail(new Error("set roles.driver in .zarg/config.toml"))

  console.log(`warming ${role} (a cold router model can take minutes)…`)
  const t0 = Date.now()
  yield* model.warm(role)
  console.log(`warm after ${Math.round((Date.now() - t0) / 1000)}s`)

  const info = yield* model.info(role)
  if (!info.supportsTools) console.log(`warning: ${role} does not advertise tool calling; the run may fail`)

  const factory = (name: string, s: Scope): Bound | undefined => {
    if (name === "Fs:read") return fsRead({ root, scope: s, sensitive })
    if (name === "Graph") return graph({ host, snapshot: store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))), scope: s })
    if (name === "Decisions") return decisionsService(decisions as never)
    return undefined
  }
  const rlm = yield* Rlm.make({ settings: yield* settings(config.extra.rlm), services: factory, roles: config.roles, decisions })
  const t1 = Date.now()
  const outcome = yield* rlm.exec({ task, preset: "research", scope })
  console.log(JSON.stringify({ result: outcome.value, turns: outcome.turns, tokens: outcome.tokens, seconds: Math.round((Date.now() - t1) / 1000) }, null, 2))
})

const base = Layer.merge(envLayer(root), BunServices.layer)
const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
const model = Layer.provideMerge(Model.layer([zargRouter, openrouter]), config)
const decisions = Layer.provideMerge(decisionsLayer(), model)
const graphs = Layer.provideMerge(gherkinHost(), graphLayer(join(root, ".zarg", "graph")))

await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))))).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
