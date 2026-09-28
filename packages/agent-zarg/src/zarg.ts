import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { AgentHost } from "@zarg/agent-host"
import type { ChosenFindings, ThreadLog } from "@zarg/core"
import type { Decisions } from "@zarg/decisions"
import type { GraphStore } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { Model } from "@zarg/model"
import type { PluginHost } from "@zarg/plugin/server"
import { type Asker, decisionsService, fsRead, graph, inquire, pluginService, Rlm, type RlmSettings, type Scope } from "@zarg/rlm"
import { askFirst } from "./driver"
import { commitGraph, findingsService } from "./findings"
import { judgeGaps } from "./gaps"
import { nextGoals, type NextOption } from "./intent"
import { makeThread } from "./thread"

/**
 * zarg, the conversational agent: the driver loop on a thread, its RLMs and their services, what next when nothing
 * is open. Everything it touches comes from the core through `host`.
 */
export const makeZarg = (host: AgentHost) =>
  Effect.sync(() => {
    const root = host.root
    const model = host.model as Model.Model["Service"]
    const decisions = host.decisions as Decisions["Service"]
    const plugins = host.plugins as PluginHost["Service"]
    const store = host.store as GraphStore["Service"]
    const log = host.log as ThreadLog
    const rlmSettings = host.rlmSettings as RlmSettings
    const sensitive = host.sensitive as never
    const chosen = host.findings.chosen as ChosenFindings
    const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))
    // A child's graph focus must name real nodes.
    const unknownIds = (ids: ReadonlyArray<string>) =>
      Effect.map(store.snapshot, (snap) => ids.filter((id) => !snap.nodes.has(id))).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      // One driver item: graph writes wait for an answered question.
      const guard = askFirst(asker)
      const outside = host.outsideReads as never
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host: plugins, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        // A plugin's agent methods, by the service name its manifest declares; graph writes wait for an answer.
        const plugin = plugins.manifests.find((m) => m.service === name)
        // Graph writes wait for the operator; service and agent plugins' tools (Rehearse.run) do not write the graph.
        if (plugin !== undefined) return plugin.archetype === "graph" ? guard.gate(pluginService(plugin, ctx)) : pluginService(plugin, ctx)
        if (name === "Fs:read") return fsRead({ root, scope, sensitive, outside })
        if (name === "Inquire") return inquire(guard.asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        if (name === "Findings")
          return findingsService({
            dir: join(root, ".zarg", "findings"),
            invoke: (p, method, params) => plugins.invoke(p, method, params),
            guard,
            chosen,
            trusted: (p) => host.findings.firstParty(p),
            neighbors: (card) => Effect.map(store.snapshot, (snap) => (snap.nodes.get(card)?.edges ?? []).map((e) => e.to)).pipe(Effect.orElseSucceed(() => [])),
            commit: (ids, message) => plugins.exclusive(commitGraph(root, ids, message)),
          })
        return undefined
      }
      return Rlm.make({ settings: rlmSettings, services: factory, roles: host.roles, decisions, observe, unknownIds }).pipe(Effect.provideService(Model.Model, model))
    }
    // The same scope filter the driver's Graph.render applies.
    const render = (ids: ReadonlyArray<string>, scope: Scope) => Effect.map(graph({ host: plugins, snapshot, scope }).handlers.render!({ focus: ids }), String)
    // What next: failure candidates a decision model judges real.
    const suggest = (focus: ReadonlySet<string> | undefined) => Effect.flatMap(plugins.suggest(focus), (c) => judgeGaps(decisions.decide, c))
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
    // zarg's message bar: a shell panel at the bottom, one line, taking keys (the shell draws it as the bar).
    host.panels.open({ name: "bar", view: "zarg", scope: "shell", edge: "bottom", size: 1, input: "onFocus" })
    return {
      makeThread: (id: string, focus: ReadonlyArray<string>) =>
        makeThread({
          id,
          focus,
          log,
          agenda: host.agenda as never,
          render,
          suggest,
          whatNext,
          driver: (spec, asker, observe) => Effect.flatMap(makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
        }),
    }
  })
