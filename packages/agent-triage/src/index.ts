import { Effect, Schema } from "effect"
import { Rehearse } from "@zarg/agent-rehearse/contract"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Config, definePlugin, Models } from "@zarg/plugin-sdk"
import { makeTriage } from "./triage"

/** The Triage Agent: proposes card changes for a journey's feedback, re-rehearses the drafted cards, drafts the plan. */
export default definePlugin({
  name: "triage",
  service: "Triage",
  archetype: "agent",
  config: Schema.Struct({}),
  pluginDependencies: [Gherkin, Backlog, Rehearse],
  scopes: { models: ["driver"], agents: true },
  methods: {
    tick: { doc: "Do the agent's part of every journey's triage stage (the core wakes it).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 30 * 60_000 },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const backlog = yield* Backlog
    const rehearse = yield* Rehearse
    const models = yield* Models
    const agents = yield* Agents
    yield* Config
    let shown = false
    const status = (text: string) =>
      Effect.gen(function* () {
        if (!shown) {
          shown = true
          yield* Effect.ignore(agents.start({ id: "triage", title: "Triage Agent", task: "Refines journeys' feedback into card changes, re-rehearses them, drafts the plan." }))
        }
        yield* Effect.ignore(agents.status({ id: "triage", text }))
      })
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
    })
    return { tick: () => Effect.as(t.tick, null) }
  }),
})
