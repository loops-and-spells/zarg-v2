import { readdirSync } from "node:fs"
import { Effect } from "effect"
import type { AgentHost } from "@zarg/agent-host"
import type { ThreadLog } from "@zarg/core"
import type { Decisions } from "@zarg/decisions"
import { type GraphStore, hash } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { Model } from "@zarg/model"
import type { PluginHost } from "@zarg/plugin/server"
import { type Asker, decisionsService, entitiesService, fsRead, graph, inquire, pluginService, Rlm, type RlmSettings, type Scope } from "@zarg/rlm"
import { tags } from "@zarg/audit"
import { commitGraph } from "@zarg/reconcile"
import { askFirst } from "./driver"
import { judgeGaps } from "./gaps"
import { nextOutcomes, nextWhenServed, type NextOption } from "./intent"
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
      // The nodes as they are (props and edges): a newer edit merges when it changed other parts.
      const nodesOf = (ids: ReadonlyArray<string>) =>
        Effect.map(store.snapshot, (snap) => Object.fromEntries(ids.map((id) => { const n = snap.nodes.get(id); return [id, n === undefined ? undefined : { props: n.props, edges: n.edges }] }))).pipe(Effect.orElseSucceed(() => ({})))
      // A change shown with its draft: checked as a write would be (gherkin's dry run) before the operator sees it.
      const dryRun = (draft: ReadonlyArray<{ readonly tool: string; readonly params: unknown }>) =>
        Effect.map(plugins.invoke("gherkin", "dryRun", { draft }), (r) => r as { readonly ok: boolean; readonly problems: ReadonlyArray<string> }).pipe(Effect.orElseSucceed(() => ({ ok: true, problems: [] as ReadonlyArray<string> })))
      const guard = askFirst(asker, versions, (ids, message) => commitGraph(root, ids, message), nodesOf, dryRun)
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
      return Rlm.make({ settings: rlmSettings, services: factory, roles: host.roles, decisions, observe, unknownIds }).pipe(
        Effect.provideService(Model.Model, model),
        Effect.map((rlm) => ({
          rlm,
          // The item's end: commit what it wrote, and hand on a change the operator added that it never wrote.
          flush: Effect.andThen(guard.flush, Effect.suspend(() => {
            const owed = guard.owed()
            return owed !== undefined && asker.owed !== undefined ? asker.owed(owed) : Effect.void
          })),
        })),
      )
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
        // What is built: the scenarios with code tagged to them (unknown when the repo cannot be searched).
        const built = yield* tags(root).pipe(Effect.map((t) => new Set(t.map((x) => x.id))), Effect.orElseSucceed(() => undefined))
        // Picking Build turns reconcile on here, as /reconcile does: zarg says what it answered.
        const turnOn = host.reconcile === undefined
          ? undefined
          : Effect.map(host.reconcile.turnOn, (a) => (a.on ? `Reconcile is on${a.pending !== undefined && a.pending > 0 ? `; a pass is starting (${a.pending} scenario${a.pending === 1 ? "" : "s"})` : ""}: it implements, verifies and commits each scenario.` : `Reconcile stays off: ${a.reason ?? "it could not start"}.`))
        return nextWhenServed(snap, focus, built, host.reconcile?.on() ?? false, turnOn)
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
          // What every driver item starts from: the graph in a few lines, so its first turns are not spent rediscovering it.
          overview: () =>
            Effect.map(store.snapshot, (snap) => {
              const all = [...snap.nodes.values()]
              const of = (type: string) => all.filter((n) => n.type === type)
              const has = (id: string) => (snap.nodes.get(id)?.edges ?? []).filter((e) => e.type === "gherkin/has").map((e) => e.to)
              const intents = of("gherkin/intent").map((i) => `- ${i.id} ${String(i.props.title ?? "")}: ${has(i.id).join(", ") || "no statements yet"}`)
              const personas = of("gherkin/persona").map((p) => String(p.props.name ?? p.id))
              const journeys = of("gherkin/journey").map((j) => `${j.id} ${String(j.props.name ?? "")}`)
              return [
                `Intents (${intents.length}):`, ...intents.slice(0, 10),
                `Personas (${personas.length}): ${personas.slice(0, 12).join(", ") || "none yet"}`,
                `Journeys (${journeys.length}): ${journeys.slice(0, 12).join("; ") || "none yet"}`,
                `Scenarios: ${of("gherkin/scenario").length}; states: ${of("gherkin/state").length}.`,
                "Graph ids are bare (I-0001); Entities refs (gherkin/intent:I-0001@…) name the same nodes.",
                // What the project has to read before asking the developer what it says.
                `Project files: ${(() => { try { return readdirSync(root).filter((f) => !f.startsWith(".") && f !== "node_modules").slice(0, 20).join(", ") || "none" } catch { return "unknown" } })()}`,
              ].join("\n")
            }).pipe(Effect.orElseSucceed(() => "")),
          // @scenario S-0102
          isGoal: (text) =>
            Effect.map(
              decisions.decide({ state: `The developer wrote, instead of answering zarg's question:\n${text}`, questions: { goal: { type: "noul", instructions: "Does it state a goal or a rule for the product (something it should do or must keep), not only a reply to the question?" } } }),
              (a) => { const g = a.goal as { answer?: boolean; probability?: number } | undefined; return g?.answer === true && (g.probability ?? 0) >= 0.6 },
            ).pipe(Effect.orElseSucceed(() => false)),
          ...(host.inbox !== undefined ? { inbox: host.inbox } : {}),
          // What the item wrote is committed when it ends, however it ends.
          // @scenario S-0038
          // The first turn waits for the driver's model to be warm.
          driver: (spec, asker, observe) =>
            Effect.andThen(host.modelReady ?? Effect.void, Effect.flatMap(makeRlm(asker, observe), ({ rlm, flush }) => rlm.exec(spec).pipe(Effect.ensuring(flush)))),
        }),
    }
  })
