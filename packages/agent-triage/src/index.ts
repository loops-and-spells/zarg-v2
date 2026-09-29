import { Effect, Schema } from "effect"
import { Rehearse } from "@zarg/agent-rehearse/contract"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Clock, Config, definePlugin, Models, Views } from "@zarg/plugin-sdk"
import { makeTriage } from "./triage"
import { triageView } from "./view"
import { TriageView } from "./views"

/** The Triage Agent: proposes card changes for a journey's feedback, re-rehearses the drafted cards, drafts the plan. */
export default definePlugin({
  name: "triage",
  service: "Triage",
  archetype: "agent",
  config: Schema.Struct({}),
  pluginDependencies: [Gherkin, Backlog, Rehearse],
  scopes: { models: ["driver"], agents: true },
  views: [TriageView],
  methods: {
    act: { doc: "The Triage Agent's view: d drafts a card again, p pauses or resumes.", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
    tick: { doc: "Do the agent's part of every journey's triage stage (the core wakes it).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 30 * 60_000 },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const backlog = yield* Backlog
    const rehearse = yield* Rehearse
    const models = yield* Models
    const agents = yield* Agents
    const views = yield* Views
    const clock = yield* Clock
    yield* Config
    let shown = false
    const show = Effect.gen(function* () {
      if (shown) return
      shown = true
      yield* Effect.ignore(agents.start({ id: "triage", title: "Triage Agent", view: "triage", task: "Refines journeys' feedback into card changes, re-rehearses them, drafts the plan." }))
    })
    const status = (text: string) => Effect.andThen(show, Effect.ignore(agents.status({ id: "triage", text })))
    // Its history: each card drafted, left out (and why), each run.
    const log = (text: string) => Effect.andThen(show, Effect.ignore(agents.step({ id: "triage", text })))
    /** Each drafted card of a round as a diff: the card now, and as the draft leaves it. */
    const lines = (x: { given: string; when: string; thens: ReadonlyArray<string> } | null) => (x === null ? [] : [`Given ${x.given}`, `When  ${x.when}`, ...x.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}`)])
    const diffOf = (card: string, draft: ReadonlyArray<{ tool: string; params: unknown }>) =>
      Effect.gen(function* () {
        const before = lines((yield* gherkin.step({ card }).pipe(Effect.orElseSucceed(() => null))) as never)
        const after = lines((yield* gherkin.step({ card, draft }).pipe(Effect.orElseSucceed(() => null))) as never)
        const out = [...before.filter((l) => !after.includes(l)).map((l) => `- ${l}`), ...after.map((l) => `${before.includes(l) ? " " : "+"} ${l}`)]
        return ["```diff", ...out, "```"].join("\n")
      })
    // The agent (and its view) starts with the first draw.
    const render = Effect.gen(function* () {
      yield* show
      const stages = yield* backlog.stages({})
      const named = yield* gherkin.journeys({})
      const journeys = yield* Effect.forEach(named, (j) => Effect.map(backlog.feedbackOf({ journey: j.name }).pipe(Effect.orElseSucceed(() => [])), (es) => ({ name: j.name, open: es.length })))
      const { working, paused } = t.state()
      const round = stages.find((s) => s.journey === working?.journey) ?? stages.find((s) => s.stage !== "triage" && s.stage !== "planned")
      const diffs: Record<string, string> = {}
      for (const p of round?.proposals ?? []) if (p.status === "accepted") diffs[p.card] = yield* diffOf(p.card, p.changes)
      const v = triageView({ stages, journeys, ...(working !== undefined ? { working } : {}), now: yield* clock.now, paused, diffs })
      yield* views.set("triage", TriageView, "summary", { markdown: v.summary })
      yield* views.set("triage", TriageView, "cards", { rows: v.cards })
      yield* views.set("triage", TriageView, "detail", { markdown: "", rows: v.details })
      yield* views.set("triage", TriageView, "journeys", { rows: v.journeys })
    }).pipe(Effect.ignore)
    const t = makeTriage({
      stages: () => backlog.stages({}),
      feedbackOf: (journey) => backlog.feedbackOf({ journey }),
      journeys: () => gherkin.journeys({}),
      step: (card, draft) => gherkin.step({ card, draft }) as never,
      dryRun: (draft) => gherkin.dryRun({ draft }),
      complete: (req) => models.complete({ role: "driver", ...req }),
      propose: (p) => backlog.propose(p as never),
      rehearsing: (p) => backlog.rehearsing(p),
      rehearsed: (p) => backlog.rehearsed(p as never),
      drafted: (p) => backlog.drafted(p),
      redraft: (p) => backlog.redraft(p),
      run: (p) => Effect.map(rehearse.run(p), (r) => r as { run?: string; refused?: string }),
      result: (run) => rehearse.result({ run }),
      status,
      log,
      now: clock.now,
      render,
    })
    return {
      tick: () => Effect.as(Effect.andThen(t.tick, render), null),
      act: ({ action, rows }: { action: string; rows: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          if (action === "pause") {
            const now = t.pause()
            yield* render
            return { notice: now ? "paused: it stops after the card in flight" : "resumed" }
          }
          if (action === "draft-again" && rows[0] !== undefined) {
            // The round the card is in: the one being worked, else the one the view shows.
            const stages = yield* backlog.stages({})
            const st = stages.find((s) => s.journey === t.state().working?.journey && s.proposals.some((p) => p.card === rows[0])) ?? stages.find((s) => s.stage !== "triage" && s.stage !== "planned" && s.proposals.some((p) => p.card === rows[0]))
            if (st === undefined) return { notice: `${rows[0]} is in no round` }
            const r = yield* backlog.redo({ journey: st.journey, card: rows[0] })
            yield* render
            return r
          }
          yield* render
          return { notice: "" }
        }).pipe(Effect.mapError((e) => e)),
    }
  }),
})
