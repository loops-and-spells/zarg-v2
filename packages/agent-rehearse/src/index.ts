import { Effect, Schema } from "effect"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agenda, Agents, Attention, Clock, Config, Decisions, definePlugin, Files, Models, Surfaces, Views } from "@zarg/plugin-sdk"
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

/** Testers roleplay the journeys; findings wait for the developer to pick which to apply. */
export default definePlugin({
  name: "rehearse",
  service: "Rehearse",
  archetype: "agent",
  config: Schema.Struct({
    auto_apply: Schema.optionalKey(Schema.Boolean),
    feel_below: Schema.optionalKey(Schema.Number),
    fail_at: Schema.optionalKey(Schema.Number),
    fork_below: Schema.optionalKey(Schema.Number),
    seam_below: Schema.optionalKey(Schema.Number),
    real_keep: Schema.optionalKey(Schema.Number),
    real_drop: Schema.optionalKey(Schema.Number),
    in_flight: Schema.optionalKey(Schema.Number),
  }),
  pluginDependencies: [Gherkin],
  views: [TesterView, RunView, StatusView],
  surfaces: [{ kind: "panel", name: "status", view: "status", scope: "shell", edge: "bottom", size: 1, input: "none" }],
  scopes: { decisions: true, models: ["rehearse"], agents: true, fs: { read: [".zarg/rehearse/**", "intent/**"], write: [".zarg/rehearse/**"] } },
  commands: [
    {
      cmd: "/rehearse",
      desc: "testers walk the journeys and report findings to review",
      method: "command",
      arg: { kind: "choice", choices: ["edge-pair", "teleport"], hint: "edge-pair|teleport", params: { keys: ["focus"] } },
    },
  ],
  methods: {
    run: { doc: "Start a rehearsal in the background (when the graph is ready, or the developer asks). Findings wait for the developer in the agents pane.", params: Params, success: Schema.Unknown, agents: true, deadlineMs: START_DEADLINE_MS },
    command: { doc: "/rehearse", params: Schema.Struct({ args: Schema.Array(Schema.String) }), success: Notice, deadlineMs: START_DEADLINE_MS },
    agenda: { doc: "Findings the developer chose to apply.", params: Schema.Struct({}), success: Schema.Unknown },
    act: { doc: "Apply or dismiss selected findings.", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Notice },
    finding: { doc: "A finding for the findings gate.", params: Schema.Struct({ id: Schema.String }), success: Schema.Unknown },
    resolved: { doc: "Findings the driver resolved.", params: Schema.Struct({ run: Schema.String, ids: Schema.Array(Schema.String) }), success: Schema.Null },
    stop: { doc: "Stop the running rehearsal.", params: Schema.Struct({}), success: Schema.Null },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const decisions = yield* Decisions
    const models = yield* Models
    const agents = yield* Agents
    const clock = yield* Clock
    const files = yield* Files
    const agenda = yield* Agenda
    const views = yield* Views
    const surfaces = yield* Surfaces
    const attention = yield* Attention
    const config = (yield* Config).value as Record<string, unknown>
    const r = yield* makeRehearse({
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
      agendaChanged: agenda.changed,
      attention,
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
      agenda: () => Effect.succeed(r.agenda()),
      act: ({ action, section, rows }: { action: string; section?: string; rows: ReadonlyArray<string> }) => r.act(action, section ?? "review.findings", rows),
      finding: ({ id }: { id: string }) => r.finding(id),
      resolved: ({ run: id, ids }: { run: string; ids: ReadonlyArray<string> }) => Effect.as(r.resolved(id, ids), null),
      stop: () => Effect.as(r.stop, null),
    } as never
  }),
})
