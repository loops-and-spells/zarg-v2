import { Effect, Schema } from "effect"
import { Backlog } from "@zarg/plugin-backlog/contract"
import { Gherkin } from "@zarg/plugin-gherkin/contract"
import { Agents, Config, definePlugin, Entities, Files, Inbox, Models, PluginFailure, Views } from "@zarg/plugin-sdk"
import { type Checkpoint, EMPTY, type JourneyInfo, type Statement } from "./checkpoint"
import { makeIntent } from "./intent"
import { intentView } from "./view"
import { IntentView } from "./views"

const FILE = ".zarg/intent/checkpoint.json"
type Data = { readonly props: Readonly<Record<string, unknown>>; readonly edges: ReadonlyArray<{ readonly type: string; readonly to: string }> }

/** The Intent Agent: reconciles the intent's outcomes and constraints into plans on the Backlog. */
export default definePlugin({
  name: "intent",
  service: "Intent",
  archetype: "agent",
  // reasoning: let the model reason before answering (off by default, as triage).
  config: Schema.Struct({ reasoning: Schema.optionalKey(Schema.Boolean) }),
  pluginDependencies: [Gherkin, Backlog],
  scopes: { models: ["driver"], agents: true, inbox: true, code: true, entities: { read: ["gherkin/*"] }, fs: { read: [".zarg/intent/**"], write: [".zarg/intent/**"] } },
  views: [IntentView],
  methods: {
    tick: { doc: "Reconcile what is due: changed, new or uncovered statements and journeys serving nothing, one round at a time (the core wakes it when the graph changes).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 30 * 60_000 },
    answered: { doc: "The operator answered one of the Intent Agent's inbox topics.", params: Schema.Struct({ id: Schema.String, key: Schema.optionalKey(Schema.String), answer: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
    act: { doc: "The Intent Agent's view: r refreshes it.", params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }), success: Schema.Struct({ notice: Schema.String }) },
  },
  make: Effect.gen(function* () {
    const gherkin = yield* Gherkin
    const backlog = yield* Backlog
    const entities = yield* Entities
    const models = yield* Models
    const inbox = yield* Inbox
    const files = yield* Files
    const agents = yield* Agents
    const views = yield* Views
    const config = (yield* Config).value as { reasoning?: boolean } | undefined
    let started = false
    const data = (e: { readonly data: unknown }) => e.data as Data
    const statements = () =>
      Effect.gen(function* () {
        const intents = yield* entities.query({ type: "gherkin/intent" })
        const journeys = yield* entities.query({ type: "gherkin/journey" })
        const out: Array<Statement> = []
        for (const kind of ["outcome", "constraint"] as const)
          for (const e of yield* entities.query({ type: `gherkin/${kind}` })) {
            const i = intents.find((x) => data(x).edges.some((ed) => ed.type === "gherkin/has" && ed.to === e.id))
            if (i === undefined) continue
            const linked =
              kind === "outcome"
                ? journeys.filter((j) => data(j).edges.some((ed) => ed.type === "gherkin/serves" && ed.to === e.id)).map((j) => j.id)
                : data(e).edges.filter((ed) => ed.type === "gherkin/bounds" && ed.to.startsWith("J-")).map((ed) => ed.to)
            const problem = data(i).props.problem
            out.push({ id: e.id, kind, text: String(data(e).props.text ?? ""), version: e.version, intent: { id: i.id, title: String(data(i).props.title ?? i.id), ...(typeof problem === "string" ? { problem } : {}) }, journeys: linked })
          }
        return out
      })
    const journeysOf = () =>
      Effect.gen(function* () {
        const listed = yield* gherkin.journeys({})
        const es = yield* entities.query({ type: "gherkin/journey" })
        return listed.map((j): JourneyInfo => {
          const e = es.find((x) => x.id === j.id)
          return { id: j.id, name: j.name, version: e?.version ?? "", scenarios: j.scenarios, serves: e === undefined ? [] : data(e).edges.filter((ed) => ed.type === "gherkin/serves").map((ed) => ed.to) }
        })
      })
    // A scenario as Gherkin with its states' ids, so the model reuses them.
    const sceneText = (scenario: string) =>
      Effect.map(gherkin.scene({ scenario }), (s) => {
        const x = s as { title: string; given: string; when: string; thens: ReadonlyArray<string>; ids?: { given: string; thens: ReadonlyArray<string> } } | null
        if (x === null) return `${scenario} (not in the graph)`
        const id = (v: string | undefined) => (v !== undefined ? `  # ${v}` : "")
        return [`${scenario} ${x.title}`, `Given ${x.given}${id(x.ids?.given)}`, `When  ${x.when}`, ...x.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}${id(x.ids?.thens[i])}`)].join("\n")
      })
    const load = files.read(FILE).pipe(
      Effect.map((t) => JSON.parse(t) as Checkpoint),
      Effect.orElseSucceed(() => EMPTY),
    )
    const render: Effect.Effect<void> = Effect.suspend(() =>
      Effect.gen(function* () {
        if (!started) {
          started = true
          yield* Effect.ignore(agents.start({ id: "intent", title: "intent", view: "intent", task: "Reconciles the intent's outcomes and constraints into plans on the Backlog." }))
        }
        const v = intentView(a.rounds())
        yield* views.set("intent", IntentView, "summary", { markdown: v.summary })
        yield* views.set("intent", IntentView, "rounds", { rows: v.rows })
        yield* views.set("intent", IntentView, "detail", { markdown: "", rows: v.details })
      }),
    ).pipe(Effect.ignore)
    const a = makeIntent(
      {
        statements,
        journeys: journeysOf,
        scene: sceneText,
        code: (scenario) => entities.code(`gherkin/scenario:${scenario}`),
        dryRun: (draft) => gherkin.dryRun({ draft }),
        complete: (req) => models.complete({ role: "driver", ...req }),
        version: (ref) => entities.version(ref),
        plan: (p) => backlog.plan(p as never),
        dropServing: (statement) => backlog.dropServing({ statement }),
        post: (t) => inbox.post(t as never),
        settle: (id, why) => inbox.settle(id, why),
        load,
        save: (cp) => files.write(FILE, `${JSON.stringify(cp, null, 2)}\n`),
        log: (text) => Effect.ignore(agents.step({ id: "intent", text })),
        render,
      },
      config?.reasoning === true,
    )
    const failure = (e: unknown) => new PluginFailure({ tag: "IntentError", message: String((e as { message?: unknown })?.message ?? e) })
    return {
      tick: () => Effect.as(a.tick, null).pipe(Effect.mapError(failure)),
      answered: ({ key, answer, text }: { id: string; key?: string; answer?: string; text?: string }) =>
        Effect.gen(function* () {
          const notice = key === undefined ? "no key" : yield* a.answered(key, answer, text)
          // A decision makes its statement due: reconcile now, not on the next graph change.
          yield* Effect.forkDetach(Effect.ignore(a.tick))
          return { notice }
        }).pipe(Effect.mapError(failure)),
      act: () => Effect.as(render, { notice: "" }),
    }
  }),
})
