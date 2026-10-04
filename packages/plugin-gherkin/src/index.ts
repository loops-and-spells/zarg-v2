import { versionOf } from "@zarg/entities"
import { scenarioLabel, scenarioVersion } from "./entities"
import { Effect, Schema } from "effect"
import { diff, type Node, Snapshot } from "@zarg/graph/pure"
import { definePlugin, Entities, Graph, PluginFailure, Views } from "@zarg/plugin-sdk"
import { affectedScenarios } from "./affected"
import { agenda, suggest } from "./agenda"
import { CompareParams, CompareResult, DryRunParams, DryRunResult, Gherkin, JourneyView, PersonaView, SceneParams, SceneView, StoriesParams, StoriesResult } from "./contract"
import { applyDraft, type Draft, dryRun } from "./draft"
import type { Finding } from "./kit"
import { LINTS } from "./lints"
import { BY, CONSTRAINT, INTENT, intentOf, IntentProps, JOURNEY, JourneyProps, OUTCOME, PERSONA, PersonaProps, personaName, personas, QUESTION, QuestionProps, SCENARIO, ScenarioProps, STATE, StatementProps, StateProps } from "./model"
import { journeyList, journeysView } from "./journeys"
import { IntentsView, JourneysView } from "./views"
import { intentsView } from "./intents"
import { render } from "./render"
import { planStories, sceneView } from "./stories"
import { tools } from "./tools"

const SnapshotJson = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })
const ToolResult = Schema.Struct({ changes: Schema.Array(Schema.Unknown), message: Schema.String })
const Findings = Schema.Struct({ findings: Schema.Array(Schema.Unknown) })
const Items = Schema.Array(Schema.Unknown)
const snapshotOf = (j: { readonly nodes: ReadonlyArray<unknown> }) => Snapshot.make(j.nodes as ReadonlyArray<Node>)

const PROPS: Record<string, Schema.Codec<any, any>> = { [STATE]: StateProps, [SCENARIO]: ScenarioProps, [PERSONA]: PersonaProps, [JOURNEY]: JourneyProps, [INTENT]: IntentProps, [OUTCOME]: StatementProps, [CONSTRAINT]: StatementProps, [QUESTION]: QuestionProps }

/** Node props, as the host's structural check used to do in-process. */
const validateProps = (changes: ReadonlyArray<unknown>): ReadonlyArray<Finding> =>
  (changes as ReadonlyArray<{ _tag: string; node?: Node }>).flatMap((c) => {
    if (c._tag !== "Put" || c.node === undefined) return []
    const schema = PROPS[c.node.type]
    if (schema === undefined) return []
    const decoded = Schema.decodeUnknownExit(schema)(c.node.props)
    return decoded._tag === "Failure"
      ? [{ severity: "error" as const, code: "invalid-props", message: `${c.node.id}: props do not match ${c.node.type}: ${String(decoded.cause)}`, about: [c.node.id] }]
      : []
  })

const toolMethods = Object.fromEntries(tools.map((t) => [t.name, { doc: t.description, params: t.params, success: ToolResult, agents: true as const }]))

const EDGES = {
  arrives: { from: "scenario", to: "state", min: 1, max: 1 },
  given: { from: "scenario", to: "state", max: 3 },
  then: { from: "scenario", to: "state", min: 1, max: 5 },
  // Who acts in the scenario; none is an agenda item, not a structural error.
  by: { from: "scenario", to: "persona" },
  // The journeys a scenario belongs to (any number; none is fine).
  in: { from: "scenario", to: "journey" },
  // An intent's statements: each statement is exactly one intent's (the statement-owner lint).
  has: { from: "intent", to: ["outcome", "constraint", "question"] },
  // The users an intent is for.
  for: { from: "intent", to: "persona" },
  // A journey delivers an outcome (many to many).
  serves: { from: "journey", to: "outcome" },
  // A constraint applies to a journey or a scenario.
  bounds: { from: "constraint", to: ["journey", "scenario"] },
}

/** The atomic Gherkin user action graph (states and scenarios), running in its own locked process. */
export default definePlugin({
  name: "gherkin",
  service: "Gherkin",
  archetype: "graph",
  implements: Gherkin,
  config: Schema.Struct({}),
  // agents: its Journeys view (the nav item's), which no agent row carries.
  // entities: the Backlog's plans, shown beside the statements they serve.
  scopes: { graph: "write", agents: true, entities: { read: ["backlog/item"] } },
  views: [JourneysView, IntentsView],
  surfaces: [{ kind: "nav", name: "journeys", view: "journeys", label: "Journeys" }, { kind: "nav", name: "intents", view: "intents", label: "Intents" }],
  // As entities: the host serves get and query from the graph; gherkin labels them, and versions a scenario by what a tester reads.
  entities: {
    scenario: { doc: "A user action: Given, When, Then, and who acts in it.", data: ScenarioProps, tone: "scenario", glyph: "◇", ops: ["label", "version", "context"] },
    state: { doc: "A Given or Then sentence.", data: StateProps, tone: "state", glyph: "○", ops: ["label"] },
    persona: { doc: "Someone who acts in scenarios.", data: PersonaProps, tone: "persona", glyph: "◎", ops: ["label"] },
    journey: { doc: "A named group of scenarios.", data: JourneyProps, tone: "journey", glyph: "↝", ops: ["label"], open: "journeys" },
    intent: { doc: "What one product (or one area of it) is for: a title, the problem, its outcomes, constraints and questions.", data: IntentProps, tone: "accent", glyph: "◈", ops: ["label"], open: "intents", commands: { "add-outcome": "add-outcome", "add-constraint": "add-constraint", "ask-question": "ask-question", edit: "edit-intent", remove: "remove" } },
    outcome: { doc: "One result an intent wants for its users; journeys serve it.", data: StatementProps, tone: "ok", glyph: "▸", ops: ["label"], open: "intents", commands: { edit: "edit-outcome", remove: "remove" } },
    constraint: { doc: "One rule that must hold where it bounds.", data: StatementProps, tone: "attention", glyph: "▪", ops: ["label"], open: "intents", commands: { edit: "edit-constraint", remove: "remove" } },
    question: { doc: "One thing an intent has not decided yet; open until answered.", data: QuestionProps, tone: "dim", glyph: "?", ops: ["label"], open: "intents", commands: { edit: "edit-question", answer: "answer-question", remove: "remove" } },
  },
  graph: {
    nodes: { state: StateProps, scenario: ScenarioProps, persona: PersonaProps, journey: JourneyProps, intent: IntentProps, outcome: StatementProps, constraint: StatementProps, question: QuestionProps },
    edges: EDGES,
  },
  methods: {
    ...toolMethods,
    validate: { doc: "Node props check.", params: Schema.Struct({ changes: Schema.Array(Schema.Unknown) }), success: Findings },
    lint: { doc: "Lints over a proposed change.", params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }), success: Findings },
    agenda: { doc: "Open items.", params: Schema.Struct({}), success: Items },
    suggest: { doc: "What next when the agenda is empty.", params: Schema.Struct({}), success: Items },
    render: { doc: "Gherkin text.", params: Schema.Struct({ focus: Schema.optionalKey(Schema.Array(Schema.String)) }), success: Schema.String },
    stories: { doc: "Stories for testers to walk.", params: StoriesParams, success: StoriesResult },
    scene: { doc: "What a tester sees at a scene: a scenario in a story.", params: SceneParams, success: SceneView },
    personas: { doc: "Personas, each with the scenarios that name it.", params: Schema.Struct({}), success: Schema.Array(PersonaView) },
    act: {
      doc: "The Journeys and Intents views: open (or refresh) one; on Intents, add, edit, answer or remove a row.",
      params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String), text: Schema.optionalKey(Schema.String) }),
      success: Schema.Struct({ notice: Schema.String }),
    },
    journeys: { doc: "Journeys, each with its scenarios.", params: Schema.Struct({}), success: Schema.Array(JourneyView) },
    dryRun: { doc: "Check a draft (gherkin tool calls, in order) as a write would, without writing.", params: DryRunParams, success: DryRunResult },
    compare: { doc: "Every scenario a draft touches (and any named): as it is, as the draft leaves it, as text; one call.", params: CompareParams, success: CompareResult },
    affected: {
      doc: "Scenarios a change affects.",
      params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }),
      success: Schema.Struct({ scenarios: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }),
    },
  },
  make: Effect.gen(function* () {
    const graph = yield* Graph
    const snap = graph.snapshot.pipe(Effect.orDie)
    const views = yield* Views
    const entities_ = yield* Entities
    // The graph as a draft would leave it (the graph itself when there is none).
    const drafted = (draft: Draft | undefined) => (draft === undefined || draft.length === 0 ? snap : Effect.flatMap(snap, (s) => Effect.map(applyDraft(s, draft, tools, EDGES), (a) => a.snapshot)))
    const runTool = (t: (typeof tools)[number]) => (p: unknown) =>
      Effect.flatMap(snap, (s) => t.run(p as never, s)).pipe(Effect.mapError((e) => new PluginFailure({ tag: "ToolError", message: e.message })))
    // Entity handlers read the graph as it is now; `get` feeds the other ops (the host serves get itself).
    const nodes = (ids: ReadonlyArray<string>) => Effect.map(snap, (s) => ids.flatMap((id) => { const n = s.nodes.get(id); return n === undefined ? [] : [{ id, data: { props: n.props, edges: n.edges } }] }))
    type E = { readonly id: string; readonly data: { readonly props: Readonly<Record<string, unknown>> } }
    // ponytail: the snapshot the latest get read; concurrent calls may see a newer one (still current). Pass it per call if that matters.
    let seen: Snapshot.Snapshot | undefined
    const current = (ids: ReadonlyArray<string>) => Effect.flatMap(snap, (s) => ((seen = s), nodes(ids)))
    const entities = {
      scenario: {
        get: current,
        label: (e: E) => (seen !== undefined ? scenarioLabel(seen, e.id) : undefined) ?? e.id,
        version: (e: E) => (seen !== undefined ? scenarioVersion(seen, e.id) : undefined) ?? versionOf(e.data),
        context: (e: E) => Effect.map(snap, (s) => render(s, new Set([e.id]))),
      },
      state: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      persona: { get: nodes, label: (e: E) => String(e.data.props.name ?? e.id) },
      journey: { get: nodes, label: (e: E) => String(e.data.props.name ?? e.id) },
      intent: { get: nodes, label: (e: E) => String(e.data.props.title ?? e.id) },
      outcome: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      constraint: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      question: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
    }
    // @scenario S-0099
    const showIntents = Effect.gen(function* () {
      // The plans serving each statement (none without the backlog).
      const items = yield* entities_.query({ type: "backlog/item" }).pipe(Effect.orElseSucceed(() => []))
      const plans = items.flatMap((e) => {
        const d = e.data as { title?: string; status?: string; serves?: string; dropped?: boolean }
        return d.serves !== undefined && d.dropped !== true ? [{ id: e.id, title: String(d.title ?? e.id), status: String(d.status ?? ""), serves: d.serves }] : []
      })
      const v = intentsView(yield* snap, plans)
      yield* views.set("intents", IntentsView, "summary", v.summary)
      yield* views.set("intents", IntentsView, "list", { rows: v.rows })
      yield* views.set("intents", IntentsView, "detail", { markdown: "No intents yet. Tell zarg what the product is for, or add one with gherkin/add-intent.", rows: v.details })
      const [i, o, u] = v.summary.items
      return `${i!.value} ${i!.label}: ${o!.value} ${o!.label}, ${u!.value} uncovered`
    })
    const KIND: Readonly<Record<string, string>> = { [INTENT]: "intent", [OUTCOME]: "outcome", [CONSTRAINT]: "constraint", [QUESTION]: "question" }
    /** An Intents row's action: a command on the row's own kind (the host's write pipeline: tools, lints, commit), then the view again. */
    const intentsAct = (action: string, row: string | undefined, text: string | undefined) =>
      Effect.gen(function* () {
        if (action === "open") return { notice: yield* showIntents }
        const s = yield* snap
        const node = row === undefined ? undefined : s.nodes.get(row)
        const kind = node === undefined ? undefined : KIND[node.type]
        if (node === undefined || kind === undefined) return { notice: `${row ?? "nothing"} is not an intent or a statement` }
        const ref = `gherkin/${kind}:${node.id}`
        const intent = node.type === INTENT ? node.id : intentOf(s, node.id)
        const command = (r: string, name: string, args: Record<string, unknown>) => Effect.map(entities_.command(r, name, args), (res) => String((res as { message?: unknown }).message ?? "done"))
        const notice: string = yield* (() => {
          // @scenario S-0100
          if (action === "add-outcome" || action === "add-constraint" || action === "ask-question")
            return intent === undefined || text === undefined ? Effect.succeed("nothing to add") : command(`gherkin/intent:${intent}`, action, { intent, text })
          if (action === "edit") return text === undefined ? Effect.succeed("nothing to change") : command(ref, "edit", node.type === INTENT ? { title: text } : { text })
          // @scenario S-0101
          if (action === "answer") return node.type !== QUESTION ? Effect.succeed(`${node.id} is not a question`) : text === undefined ? Effect.succeed("no answer given") : command(ref, "answer", { answer: text })
          if (action === "remove") return text !== "yes" ? Effect.succeed(`kept ${node.id}`) : command(ref, "remove", {})
          return Effect.succeed(`no action ${action}`)
        })()
        yield* showIntents
        return { notice }
      }).pipe(Effect.catch((e: { readonly message?: string }) => Effect.succeed({ notice: e.message ?? String(e) })))
    return {
      entities,
      ...(Object.fromEntries(tools.map((t) => [t.name, runTool(t)])) as Record<string, (p: unknown) => Effect.Effect<any, PluginFailure>>),
      validate: ({ changes }: { changes: ReadonlyArray<unknown> }) => Effect.sync(() => ({ findings: validateProps(changes) })),
      lint: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => {
          const ctx = { before: snapshotOf(before), after: snapshotOf(after), diff: diff(snapshotOf(before), snapshotOf(after)) }
          return { findings: LINTS.flatMap((l) => l(ctx)) }
        }),
      agenda: () => Effect.map(snap, agenda),
      suggest: () => Effect.map(snap, suggest),
      render: ({ focus }: { focus?: ReadonlyArray<string> }) => Effect.map(snap, (s) => render(s, focus === undefined ? undefined : new Set(focus))),
      stories: ({ strategy, focus, draft }: { strategy: "journey" | "edge-pair" | "teleport"; focus?: ReadonlyArray<string>; draft?: Draft }) =>
        Effect.map(drafted(draft), (s) => planStories(s, strategy, focus === undefined || focus.length === 0 ? undefined : new Set(focus))),
      scene: ({ scenario, via, draft }: { scenario: string; via?: string; draft?: Draft }) => Effect.map(drafted(draft), (s) => sceneView(s, scenario, via) ?? null),
      dryRun: ({ draft }: { draft: Draft }) => Effect.flatMap(snap, (s) => dryRun(s, draft, tools, (c) => validateProps(c), LINTS, EDGES)),
      // The graph read once, the draft applied once: a plan's whole picture in one call.
      compare: ({ draft, scenarios }: { draft: Draft; scenarios?: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          const s = yield* snap
          const checked = yield* dryRun(s, draft, tools, (c) => validateProps(c), LINTS, EDGES)
          const after = yield* applyDraft(s, draft, tools, EDGES).pipe(Effect.map((a) => a.snapshot), Effect.orElseSucceed(() => s))
          const ids = [...new Set([...(scenarios ?? []), ...checked.scenarios])].filter((id) => s.nodes.get(id)?.type === "gherkin/scenario" || after.nodes.get(id)?.type === "gherkin/scenario")
          return { ok: checked.ok, problems: checked.problems, scenarios: ids.map((id) => ({ id, before: sceneView(s, id) ?? null, after: sceneView(after, id) ?? null, text: s.nodes.has(id) ? render(s, new Set([id])) : "" })) }
        }),
      journeys: () => Effect.map(snap, journeyList),
      // The nav item opens the view (Refresh reloads it): every journey, with every journey's flow for the one highlighted.
      act: ({ agent, action, rows, text }: { agent: string; action: string; rows: ReadonlyArray<string>; text?: string }) =>
        Effect.gen(function* () {
          if (agent === "intents") return yield* intentsAct(action, rows[0], text)
          if (agent !== "journeys") return { notice: `gherkin has no agent ${agent}` }
          const v = journeysView(yield* snap)
          yield* views.set("journeys", JourneysView, "summary", v.summary)
          yield* views.set("journeys", JourneysView, "list", { rows: v.rows })
          yield* views.set("journeys", JourneysView, "flow", { markdown: 'No journeys yet. Add one with gherkin/add-journey, then tag scenarios with link {edge: "in"}.', rows: v.flows })
          return { notice: v.rows.length === 0 ? "no journeys yet" : `${v.rows.length} journey${v.rows.length === 1 ? "" : "s"}: ${v.rows.map((r) => r.cells.name).join(", ")}` }
        }).pipe(Effect.mapError((e) => new PluginFailure({ tag: "ViewError", message: String((e as { message?: unknown }).message ?? e) }))),
      personas: () =>
        Effect.map(snap, (s) =>
          personas(s).map((p) => ({ id: p.id, name: personaName(p), kind: p.props.kind as "human" | "cli" | "agent", text: String(p.props.text ?? ""), scenarios: Snapshot.inbound(s, p.id, BY).map((e) => e.from).sort() })),
        ),
      affected: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => affectedScenarios(snapshotOf(before), snapshotOf(after))),
    } as never
  }),
})
