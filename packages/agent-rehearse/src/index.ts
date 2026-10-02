import { Effect, Schema } from "effect"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agenda, Agents, Clock, Config, Decisions, definePlugin, Entities, Files, Models, Surfaces, Views } from "@zarg/plugin-sdk"
import { Rehearse, RunParams, RunResult } from "./contract"
import { makeRehearse } from "./run"
import { rehearseSettings } from "./settings"
import { RunView, StatusView, TesterView } from "./views"

const Notice = Schema.Struct({ notice: Schema.String })
// Starting asks the decision model once per persona and plans every story: slow on a CPU decision model.
const START_DEADLINE_MS = 10 * 60_000

/** Testers roleplay the journeys; what they find is filed as feedback with the backlog (triaged in Feedback). */
export default definePlugin({
  name: "rehearse",
  service: "Rehearse",
  archetype: "agent",
  config: Schema.Struct({
    feel_below: Schema.optionalKey(Schema.Number),
    fail_at: Schema.optionalKey(Schema.Number),
    fork_below: Schema.optionalKey(Schema.Number),
    seam_below: Schema.optionalKey(Schema.Number),
    real_keep: Schema.optionalKey(Schema.Number),
    real_drop: Schema.optionalKey(Schema.Number),
    in_flight: Schema.optionalKey(Schema.Number),
  }),
  implements: Rehearse,
  pluginDependencies: [Gherkin, Backlog],
  views: [TesterView, RunView, StatusView],
  surfaces: [
    { kind: "panel", name: "status", view: "status", scope: "shell", edge: "bottom", size: 1, input: "none" },
    // One scenario per run: its progress and its testers.
    { kind: "card", name: "run", view: "run", headline: "progress", recent: "testers" },
  ],
  scopes: { decisions: true, models: ["rehearse"], agents: true, code: true, entities: { read: ["gherkin/*"] }, fs: { read: [".zarg/rehearse/**", "intent/**"], write: [".zarg/rehearse/**"] } },
  commands: [
    {
      cmd: "/rehearse",
      desc: "testers walk the journeys and file feedback (triage it in Feedback)",
      method: "command",
      arg: { kind: "choice", choices: ["journey", "edge-pair", "teleport"], hint: "journey|edge-pair|teleport", params: { keys: ["focus"] } },
    },
  ],
  methods: {
    run: { doc: "Start a rehearsal in the background (when the graph is ready, or the operator asks). What the testers find is filed as feedback, triaged in Feedback.", params: RunParams, success: Schema.Unknown, agents: true, deadlineMs: START_DEADLINE_MS },
    result: { doc: "What a run found (a run over a draft keeps its findings here).", params: Schema.Struct({ run: Schema.String }), success: RunResult },
    command: { doc: "/rehearse", params: Schema.Struct({ args: Schema.Array(Schema.String) }), success: Notice, deadlineMs: START_DEADLINE_MS },
    act: { doc: "Refresh the run's tables (where its feedback stands now).", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Notice },
    stop: { doc: "Stop the running rehearsal (with a run: only when it is that run).", params: Schema.Struct({ run: Schema.optionalKey(Schema.String) }), success: Schema.Null },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const decisions = yield* Decisions
    const models = yield* Models
    const agents = yield* Agents
    const clock = yield* Clock
    const files = yield* Files
    const backlog = yield* Backlog
    const agendaPower = yield* Agenda
    const entities = yield* Entities
    const views = yield* Views
    const surfaces = yield* Surfaces
    const config = (yield* Config).value as Record<string, unknown>
    const r = yield* makeRehearse({
      personas: () => gherkin.personas({}),
      stories: (strategy, focus, draft) => gherkin.stories({ strategy, ...(focus !== undefined ? { focus } : {}), ...(draft !== undefined ? { draft } : {}) }),
      scene: (scenario, via, draft) => gherkin.scene({ scenario, ...(via !== undefined ? { via } : {}), ...(draft !== undefined ? { draft } : {}) }),
      code: (scenario) => entities.code(`gherkin/scenario:${scenario}`),
      agendaChanged: agendaPower.changed,
      decide: (req) => decisions.decide(req),
      complete: (req) => models.complete({ role: "rehearse", ...req }).pipe(Effect.mapError((e) => ({ message: e.message }))),
      agents,
      now: clock.now,
      uuid: clock.uuid,
      read: files.read,
      write: files.write,
      list: files.list,
      version: (scenario) => entities.version(`gherkin/scenario:${scenario}`),
      walking: (run, journeys) => Effect.asVoid(backlog.walking({ run, journeys })),
      journeysOf: (scenarios) => Effect.map(gherkin.journeys({}), (js) => js.filter((j) => j.scenarios.some((c) => scenarios.includes(c))).map((j) => j.name)),
      file: (entries, opts) => backlog.file({ entries: entries as never, ...(opts?.walked !== undefined ? { walked: opts.walked } : {}), ...(opts?.run !== undefined ? { run: opts.run } : {}) }),
      status: (ids) => backlog.status({ ids }),
      views: { set: (a, v, path, data) => views.set(a, v as never, path as never, data as never), append: (a, v, path, lines) => views.append(a, v as never, path as never, lines) },
      surfaces: { open: (surface, agent) => surfaces.open({ surface, agent }) },
      settings: rehearseSettings(config ?? {}, "rehearse"),
    })
    // A run a restart cut short continues (the plugin loads on its first call).
    yield* r.resume
    const run = (p: Parameters<typeof r.start>[0]) => r.start(p)
    return {
      run,
      command: ({ args }: { args: ReadonlyArray<string> }) =>
        Effect.map(
          run({
            ...(args.includes("teleport") ? { strategy: "teleport" as const } : args.includes("edge-pair") ? { strategy: "edge-pair" as const } : { strategy: "journey" as const }),
            focus: (args.find((a) => a.startsWith("focus="))?.slice("focus=".length) ?? "").split(",").filter((x) => x.length > 0),
          }),
          (s) =>
            "refused" in s
              ? { notice: `Rehearse did not start: ${s.refused}` }
              : { notice: `Rehearse run ${s.run} started: ${s.stories} stories, ${s.scenes} scenes, testers: ${s.personas.join(", ")}.${(s.notes ?? []).length > 0 ? ` Not walked: ${s.notes!.join("; ")}.` : ""} Watch it in the agents pane (Tab).` },
        ),
      act: () => Effect.as(r.refresh, { notice: "refreshed" }),
      result: ({ run: id }: { run: string }) => Effect.succeed(r.result(id)),
      stop: (p?: { run?: string }) => Effect.as(r.stop(p?.run), null),
    } as never
  }),
})
