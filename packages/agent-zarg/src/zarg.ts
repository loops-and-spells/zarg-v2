import { Effect } from "effect"
import type { AgentHost } from "@zarg/agent-host"
import type { ThreadLog } from "@zarg/core"
import type { Decisions } from "@zarg/decisions"
import { type GraphStore, hash } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { Model } from "@zarg/model"
import type { PluginHost } from "@zarg/plugin/server"
import { type Asker, decisionsService, entitiesService, fsRead, graph, inquire, pluginService, Rlm, type RlmSettings, type Scope } from "@zarg/rlm"
import { askFirst } from "./driver"
import { judgeGaps } from "./gaps"
import { nextOutcomes, type NextOption } from "./intent"
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
    const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))
    // A child's graph focus must name real nodes.
    const unknownIds = (ids: ReadonlyArray<string>) =>
      Effect.map(store.snapshot, (snap) => ids.filter((id) => !snap.nodes.has(id))).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      // One driver item: graph writes wait for an answered question.
      // @scenario S-0016
      const versions = (ids: ReadonlyArray<string>) =>
        Effect.map(store.snapshot, (snap) => Object.fromEntries(ids.map((id) => { const n = snap.nodes.get(id); return [id, n === undefined ? undefined : hash(n)] }))).pipe(Effect.orElseSucceed(() => ({})))
      const guard = askFirst(asker, versions)
      const outside = host.outsideReads as never
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host: plugins, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        // Commands may write the graph (through its owner's tools): like graph writes, they wait for an answer.
        if (name === "Entities") return guard.gate(entitiesService(ctx, { write: true }))
        if (name === "Entities:read") return entitiesService(ctx, { write: false })
        // A plugin's agent methods, by the service name its manifest declares; graph writes wait for an answer.
        const plugin = plugins.manifests.find((m) => m.service === name)
        // Graph writes wait for the operator; service and agent plugins' tools (Rehearse.run) do not write the graph.
        if (plugin !== undefined) return plugin.archetype === "graph" ? guard.gate(pluginService(plugin, ctx)) : pluginService(plugin, ctx)
        if (name === "Fs:read") return fsRead({ root, scope, sensitive, outside })
        if (name === "Inquire") return inquire(guard.asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        return undefined
      }
      return Rlm.make({ settings: rlmSettings, services: factory, roles: host.roles, decisions, observe, unknownIds }).pipe(Effect.provideService(Model.Model, model))
    }
    // The same scope filter the driver's Graph.render applies.
    const render = (ids: ReadonlyArray<string>, scope: Scope) => Effect.map(graph({ host: plugins, snapshot, scope }).handlers.render!({ focus: ids }), String)
    // What next: failure candidates a decision model judges real.
    const suggest = (focus: ReadonlySet<string> | undefined) => Effect.flatMap(plugins.suggest(focus), (c) => judgeGaps(decisions.decide, c))
    // What zarg offers when nothing is open: the outcomes no journey serves; with none, where journeys start.
    const whatNext = (focus: ReadonlySet<string> | undefined) =>
      Effect.gen(function* () {
        const snap = yield* store.snapshot
        const outcomes = nextOutcomes(snap)
        if (outcomes.length > 0) return outcomes
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
          // @scenario S-0102
          isGoal: (text) =>
            Effect.map(
              decisions.decide({ state: `The developer wrote, instead of answering zarg's question:\n${text}`, questions: { goal: { type: "noul", instructions: "Does it state a goal or a rule for the product (something it should do or must keep), not only a reply to the question?" } } }),
              (a) => { const g = a.goal as { answer?: boolean; probability?: number } | undefined; return g?.answer === true && (g.probability ?? 0) >= 0.6 },
            ).pipe(Effect.orElseSucceed(() => false)),
          ...(host.inbox !== undefined ? { inbox: host.inbox } : {}),
          driver: (spec, asker, observe) => Effect.flatMap(makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
        }),
    }
  })
