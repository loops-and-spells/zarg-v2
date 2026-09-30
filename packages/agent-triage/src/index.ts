import { Effect, Schema } from "effect"
import { Rehearse } from "@zarg/agent-rehearse/contract"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Clock, Config, Decisions, definePlugin, Entities, Models, Views } from "@zarg/plugin-sdk"
import { makeTriage } from "./triage"
import { rollupView, workerView } from "./view"
import { RollupView, WorkerView } from "./views"

/** The Triage Agent: proposes card changes for a journey's feedback, re-rehearses the drafted cards, drafts the plan. */
/** Triage: a rollup agent and N workers (triage-1…N); each worker takes the next queued journey through Refine, Re-rehearse and Plan. */
export default definePlugin({
  name: "triage",
  service: "Triage",
  archetype: "agent",
  // [plugins.triage] workers: how many journeys are worked at once (each asks the driver model).
  // reasoning: let the model reason before answering (off: on cards it reasoned to its token limit and never answered).
  config: Schema.Struct({ workers: Schema.optionalKey(Schema.Number), reasoning: Schema.optionalKey(Schema.Boolean) }),
  pluginDependencies: [Gherkin, Backlog, Rehearse],
  scopes: { decisions: true, models: ["driver"], agents: true, entities: { read: ["gherkin/*"] } },
  views: [RollupView, WorkerView],
  methods: {
    act: { doc: "Triage's views: p pauses or resumes (the rollup), d drafts a card again (a worker).", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
    tick: { doc: "Hand queued journeys to free workers; each works its journey in the background (the core wakes it).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 30 * 60_000 },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const backlog = yield* Backlog
    const rehearse = yield* Rehearse
    const models = yield* Models
    const entities = yield* Entities
    const decisions = yield* Decisions
    const agents = yield* Agents
    const views = yield* Views
    const clock = yield* Clock
    const config = (yield* Config).value as { workers?: number; reasoning?: boolean } | undefined
    const workers = Math.max(1, Math.floor(config?.workers ?? 2))
    // The triage agent runs while a worker has a journey; with every worker free it is idle (it does not spin).
    let created = false
    let running = false
    const show = Effect.gen(function* () {
      if (running) return
      running = true
      created = true
      yield* Effect.ignore(agents.start({ id: "triage", title: "triage", view: "triage", task: `Refines queued journeys' feedback into card changes with ${workers} workers, re-rehearses them, drafts the plans.` }))
    })
    const status = (agent: string, text: string) => Effect.andThen(show, Effect.ignore(agents.status({ id: agent, text })))
    // A worker's history: each card drafted, left out (and why), each run.
    const log = (agent: string, text: string) => Effect.andThen(show, Effect.ignore(agents.step({ id: agent, text })))
    const worker = (id: string, journey: string | undefined) =>
      journey !== undefined ? Effect.andThen(show, Effect.ignore(agents.start({ id, parent: "triage", title: "triage", view: "worker", task: journey }))) : Effect.ignore(agents.end({ id, ok: true, message: "free" }))
    const idle = Effect.gen(function* () {
      if (!running) return
      running = false
      yield* Effect.ignore(agents.end({ id: "triage", ok: true, message: "idle" }))
    })
    /** Each drafted card as a diff: the card now, and as its changes leave it. */
    const lines = (x: { given: string; when: string; thens: ReadonlyArray<string> } | null) => (x === null ? [] : [`Given ${x.given}`, `When  ${x.when}`, ...x.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}`)])
    const diffOf = (card: string, draft: ReadonlyArray<{ tool: string; params: unknown }>) =>
      Effect.gen(function* () {
        const before = lines((yield* gherkin.step({ card }).pipe(Effect.orElseSucceed(() => null))) as never)
        const after = lines((yield* gherkin.step({ card, draft }).pipe(Effect.orElseSucceed(() => null))) as never)
        const out = [...before.filter((l) => !after.includes(l)).map((l) => `- ${l}`), ...after.map((l) => `${before.includes(l) ? " " : "+"} ${l}`)]
        return ["```diff", ...out, "```"].join("\n")
      })
    // The rollup and every worker's view, from the stages and the workers.
    const render = Effect.gen(function* () {
      // Its views need the agent: it starts with the first draw (and goes idle below when there is nothing to do).
      if (!created) yield* show
      const stages = yield* backlog.stages({})
      const named = yield* gherkin.journeys({})
      const journeys = yield* Effect.forEach(named, (j) => Effect.map(backlog.feedbackOf({ journey: j.name }).pipe(Effect.orElseSucceed(() => [])), (es) => ({ name: j.name, open: es.length })))
      const { workers: ws, paused } = t.state()
      const r = rollupView({ stages, journeys, workers: ws, paused })
      // Every worker free: idle until one takes a journey.
      if (ws.every((w) => w.journey === undefined)) yield* idle
      yield* views.set("triage", RollupView, "summary", { markdown: r.summary })
      yield* views.set("triage", RollupView, "workers", { rows: r.workers })
      yield* views.set("triage", RollupView, "journeys", { rows: r.journeys })
      const now = yield* clock.now
      for (const w of ws) {
        if (w.journey === undefined) continue
        const stage = stages.find((s) => s.journey === w.journey)
        const diffs: Record<string, string> = {}
        for (const p of stage?.proposals ?? []) if (p.status === "accepted") diffs[p.card] = yield* diffOf(p.card, p.changes)
        const v = workerView({ ...(stage !== undefined ? { stage } : {}), ...(w.working !== undefined ? { working: w.working } : {}), now, diffs })
        yield* views.set(w.id, WorkerView, "summary", { markdown: v.summary })
        yield* views.set(w.id, WorkerView, "cards", { rows: v.cards })
        yield* views.set(w.id, WorkerView, "detail", { markdown: "", rows: v.details })
      }
    }).pipe(Effect.ignore)
    const t = makeTriage(
      {
        stages: () => backlog.stages({}),
        feedbackOf: (journey) => backlog.feedbackOf({ journey }),
        journeys: () => gherkin.journeys({}),
        step: (card, draft) => gherkin.step({ card, draft }) as never,
        code: (card) => entities.code(`gherkin/card:${card}`),
        dryRun: (draft) => gherkin.dryRun({ draft }),
        complete: (req) => models.complete({ role: "driver", ...req }),
        propose: (p) => backlog.propose(p as never),
        rehearsing: (p) => backlog.rehearsing(p),
        rehearsed: (p) => backlog.rehearsed(p as never),
        drafted: (p) => backlog.drafted(p),
        plans: (journey, plans) => Effect.asVoid(backlog.plans({ journey, plans })),
        decide: (req) => decisions.decide(req),
        redraft: (p) => backlog.redraft(p),
        stop: (run) => Effect.asVoid(rehearse.stop({ run })),
        status,
        log,
        assign: (journey, w) => Effect.asVoid(backlog.assign({ journey, ...(w !== undefined ? { worker: w } : {}) })),
        worker,
        now: clock.now,
        render,
      },
      workers,
      config?.reasoning === true,
    )
    return {
      tick: () => Effect.as(t.tick, null),
      act: ({ agent, action, rows }: { agent: string; action: string; rows: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          if (action === "pause") {
            const now = t.pause()
            yield* render
            return { notice: now ? "paused: workers stop after the cards in flight" : "resumed" }
          }
          if (action === "draft-again" && rows[0] !== undefined) {
            // The worker's own journey.
            const journey = t.state().workers.find((w) => w.id === agent)?.journey
            if (journey === undefined) return { notice: `${agent} has no journey` }
            const r = yield* backlog.redo({ journey, card: rows[0] })
            yield* render
            return r
          }
          yield* render
          return { notice: "" }
        }),
    }
  }),
})
