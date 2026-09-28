import { Effect, Schema } from "effect"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Clock, Config, Decisions, definePlugin, Entities, Files, Models, Surfaces, Views } from "@zarg/plugin-sdk"
import { makeRehearse } from "./run"
import { rehearseSettings } from "./settings"
import { RunView, StatusView, TesterView } from "./views"

const Params = Schema.Struct({
  strategy: Schema.optionalKey(Schema.Literals(["edge-pair", "teleport"])).annotate({ description: "edge-pair (default): every journey step and step pair; teleport: each card once, alone (quick)." }),
  focus: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Card or state ids: only stories through them." }),
  personas: Schema.optionalKey(Schema.Array(Schema.String)),
})
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
  pluginDependencies: [Gherkin, Backlog],
  views: [TesterView, RunView, StatusView],
  surfaces: [
    { kind: "panel", name: "status", view: "status", scope: "shell", edge: "bottom", size: 1, input: "none" },
    // One card per run: its progress and its testers.
    { kind: "card", name: "run", view: "run", headline: "progress", recent: "testers" },
  ],
  scopes: { decisions: true, models: ["rehearse"], agents: true, entities: { read: ["gherkin/*"] }, fs: { read: [".zarg/rehearse/**", "intent/**"], write: [".zarg/rehearse/**"] } },
  commands: [
    {
      cmd: "/rehearse",
      desc: "testers walk the journeys and file feedback (triage it in Feedback)",
      method: "command",
      arg: { kind: "choice", choices: ["edge-pair", "teleport"], hint: "edge-pair|teleport", params: { keys: ["focus"] } },
    },
  ],
  methods: {
    run: { doc: "Start a rehearsal in the background (when the graph is ready, or the operator asks). What the testers find is filed as feedback, triaged in Feedback.", params: Params, success: Schema.Unknown, agents: true, deadlineMs: START_DEADLINE_MS },
    command: { doc: "/rehearse", params: Schema.Struct({ args: Schema.Array(Schema.String) }), success: Notice, deadlineMs: START_DEADLINE_MS },
    act: { doc: "Refresh the run's tables (where its feedback stands now).", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Notice },
    stop: { doc: "Stop the running rehearsal.", params: Schema.Struct({}), success: Schema.Null },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const decisions = yield* Decisions
    const models = yield* Models
    const agents = yield* Agents
    const clock = yield* Clock
    const files = yield* Files
    const backlog = yield* Backlog
    const entities = yield* Entities
    const views = yield* Views
    const surfaces = yield* Surfaces
    const config = (yield* Config).value as Record<string, unknown>
    const r = yield* makeRehearse({
      personas: () => gherkin.personas({}),
      stories: (strategy, focus) => gherkin.stories({ strategy, ...(focus !== undefined ? { focus } : {}) }),
      step: (card, via) => gherkin.step({ card, ...(via !== undefined ? { via } : {}) }),
      decide: (req) => decisions.decide(req),
      complete: (req) => models.complete({ role: "rehearse", ...req }).pipe(Effect.mapError((e) => ({ message: e.message }))),
      agents,
      now: clock.now,
      uuid: clock.uuid,
      read: files.read,
      write: files.write,
      list: files.list,
      version: (card) => entities.version(`gherkin/card:${card}`),
      file: (entries) => backlog.file({ entries: entries as never }),
      status: (ids) => backlog.status({ ids }),
      views: { set: (a, v, path, data) => views.set(a, v as never, path as never, data as never), append: (a, v, path, lines) => views.append(a, v as never, path as never, lines) },
      surfaces: { open: (surface, agent) => surfaces.open({ surface, agent }) },
      settings: rehearseSettings(config ?? {}, "rehearse"),
    })
    // A run a restart cut short continues (the plugin loads on its first call).
    yield* r.resume
    const run = (p: { readonly strategy?: "edge-pair" | "teleport"; readonly focus?: ReadonlyArray<string>; readonly personas?: ReadonlyArray<string> }) => r.start(p)
    return {
      run,
      command: ({ args }: { args: ReadonlyArray<string> }) =>
        Effect.map(
          run({
            ...(args.includes("teleport") ? { strategy: "teleport" as const } : args.includes("edge-pair") ? { strategy: "edge-pair" as const } : {}),
            focus: (args.find((a) => a.startsWith("focus="))?.slice("focus=".length) ?? "").split(",").filter((x) => x.length > 0),
          }),
          (s) =>
            "refused" in s
              ? { notice: `Rehearse did not start: ${s.refused}` }
              : { notice: `Rehearse run ${s.run} started: ${s.stories} stories, ${s.steps} steps, testers: ${s.personas.join(", ")}. Watch it in the agents pane (Tab).` },
        ),
      act: () => Effect.as(r.refresh, { notice: "refreshed" }),
      stop: () => Effect.as(r.stop, null),
    } as never
  }),
})
