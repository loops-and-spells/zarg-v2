import { versionOf } from "@zarg/entities"
import { cardLabel, cardVersion } from "./entities"
import { Effect, Schema } from "effect"
import { diff, type Node, Snapshot } from "@zarg/graph/pure"
import { definePlugin, Graph, PluginFailure, Views } from "@zarg/plugin-sdk"
import { affectedCards } from "./affected"
import { agenda, suggest } from "./agenda"
import { DryRunParams, DryRunResult, Gherkin, JourneyView, PersonaView, StepParams, StepView, StoriesParams, StoriesResult } from "./contract"
import { applyDraft, type Draft, dryRun } from "./draft"
import type { Finding } from "./kit"
import { clauseShape, journeyShape, personaShape, stateText } from "./lints"
import { BY, CARD, CardProps, JOURNEY, JourneyProps, PERSONA, PersonaProps, personaName, personas, STATE, StateProps } from "./model"
import { journeyList, journeysView } from "./journeys"
import { JourneysView } from "./views"
import { render } from "./render"
import { planStories, stepView } from "./stories"
import { tools } from "./tools"

const SnapshotJson = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })
const ToolResult = Schema.Struct({ changes: Schema.Array(Schema.Unknown), message: Schema.String })
const Findings = Schema.Struct({ findings: Schema.Array(Schema.Unknown) })
const Items = Schema.Array(Schema.Unknown)
const snapshotOf = (j: { readonly nodes: ReadonlyArray<unknown> }) => Snapshot.make(j.nodes as ReadonlyArray<Node>)

const PROPS: Record<string, Schema.Codec<any, any>> = { [STATE]: StateProps, [CARD]: CardProps, [PERSONA]: PersonaProps, [JOURNEY]: JourneyProps }

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
  arrives: { from: "card", to: "state", min: 1, max: 1 },
  given: { from: "card", to: "state", max: 3 },
  then: { from: "card", to: "state", min: 1, max: 5 },
  // Who acts in the card; none is an agenda item, not a structural error.
  by: { from: "card", to: "persona" },
  // The journeys a card belongs to (any number; none is fine).
  in: { from: "card", to: "journey" },
}

/** The atomic Gherkin user action graph (states and cards), running in its own locked process. */
export default definePlugin({
  name: "gherkin",
  service: "Gherkin",
  archetype: "graph",
  implements: Gherkin,
  config: Schema.Struct({}),
  // agents: its Journeys view (the nav item's), which no agent row carries.
  scopes: { graph: "write", agents: true },
  views: [JourneysView],
  surfaces: [{ kind: "nav", name: "journeys", view: "journeys", label: "Journeys" }],
  // As entities: the host serves get and query from the graph; gherkin labels them, and versions a card by what a tester reads.
  entities: {
    card: { doc: "A user action: Given, When, Then, and who acts in it.", data: CardProps, tone: "card", glyph: "◇", ops: ["label", "version", "context"] },
    state: { doc: "A Given or Then sentence.", data: StateProps, tone: "state", glyph: "○", ops: ["label"] },
    persona: { doc: "Someone who acts in cards.", data: PersonaProps, tone: "persona", glyph: "◎", ops: ["label"] },
    journey: { doc: "A named group of cards.", data: JourneyProps, tone: "journey", glyph: "↝", ops: ["label"], open: "journeys" },
  },
  graph: {
    nodes: { state: StateProps, card: CardProps, persona: PersonaProps, journey: JourneyProps },
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
    step: { doc: "What a tester sees at a step.", params: StepParams, success: StepView },
    personas: { doc: "Personas, each with the cards that name it.", params: Schema.Struct({}), success: Schema.Array(PersonaView) },
    act: {
      doc: "The Journeys view: open (or refresh) it, or show a journey's flow.",
      params: Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) }),
      success: Schema.Struct({ notice: Schema.String }),
    },
    journeys: { doc: "Journeys, each with its cards.", params: Schema.Struct({}), success: Schema.Array(JourneyView) },
    dryRun: { doc: "Check a draft (gherkin tool calls, in order) as a write would, without writing.", params: DryRunParams, success: DryRunResult },
    affected: {
      doc: "Cards a change affects.",
      params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }),
      success: Schema.Struct({ cards: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }),
    },
  },
  make: Effect.gen(function* () {
    const graph = yield* Graph
    const snap = graph.snapshot.pipe(Effect.orDie)
    const views = yield* Views
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
      card: {
        get: current,
        label: (e: E) => (seen !== undefined ? cardLabel(seen, e.id) : undefined) ?? e.id,
        version: (e: E) => (seen !== undefined ? cardVersion(seen, e.id) : undefined) ?? versionOf(e.data),
        context: (e: E) => Effect.map(snap, (s) => render(s, new Set([e.id]))),
      },
      state: { get: nodes, label: (e: E) => String(e.data.props.text ?? e.id) },
      persona: { get: nodes, label: (e: E) => String(e.data.props.name ?? e.id) },
      journey: { get: nodes, label: (e: E) => String(e.data.props.name ?? e.id) },
    }
    return {
      entities,
      ...(Object.fromEntries(tools.map((t) => [t.name, runTool(t)])) as Record<string, (p: unknown) => Effect.Effect<any, PluginFailure>>),
      validate: ({ changes }: { changes: ReadonlyArray<unknown> }) => Effect.sync(() => ({ findings: validateProps(changes) })),
      lint: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => {
          const ctx = { before: snapshotOf(before), after: snapshotOf(after), diff: diff(snapshotOf(before), snapshotOf(after)) }
          return { findings: [clauseShape, stateText, personaShape, journeyShape].flatMap((l) => l(ctx)) }
        }),
      agenda: () => Effect.map(snap, agenda),
      suggest: () => Effect.map(snap, suggest),
      render: ({ focus }: { focus?: ReadonlyArray<string> }) => Effect.map(snap, (s) => render(s, focus === undefined ? undefined : new Set(focus))),
      stories: ({ strategy, focus, draft }: { strategy: "journey" | "edge-pair" | "teleport"; focus?: ReadonlyArray<string>; draft?: Draft }) =>
        Effect.map(drafted(draft), (s) => planStories(s, strategy, focus === undefined || focus.length === 0 ? undefined : new Set(focus))),
      step: ({ card, via, draft }: { card: string; via?: string; draft?: Draft }) => Effect.map(drafted(draft), (s) => stepView(s, card, via) ?? null),
      dryRun: ({ draft }: { draft: Draft }) => Effect.flatMap(snap, (s) => dryRun(s, draft, tools, (c) => validateProps(c), [clauseShape, stateText, personaShape, journeyShape], EDGES)),
      journeys: () => Effect.map(snap, journeyList),
      // The nav item opens the view (Refresh reloads it): every journey, with every journey's flow for the one highlighted.
      act: ({ agent }: { agent: string; action: string; rows: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          if (agent !== "journeys") return { notice: `gherkin has no agent ${agent}` }
          const v = journeysView(yield* snap)
          yield* views.set("journeys", JourneysView, "summary", v.summary)
          yield* views.set("journeys", JourneysView, "list", { rows: v.rows })
          yield* views.set("journeys", JourneysView, "flow", { markdown: 'No journeys yet. Add one with gherkin/add-journey, then tag cards with link {edge: "in"}.', rows: v.flows })
          return { notice: v.rows.length === 0 ? "no journeys yet" : `${v.rows.length} journey${v.rows.length === 1 ? "" : "s"}: ${v.rows.map((r) => r.cells.name).join(", ")}` }
        }).pipe(Effect.mapError((e) => new PluginFailure({ tag: "ViewError", message: String((e as { message?: unknown }).message ?? e) }))),
      personas: () =>
        Effect.map(snap, (s) =>
          personas(s).map((p) => ({ id: p.id, name: personaName(p), kind: p.props.kind as "human" | "cli" | "agent", text: String(p.props.text ?? ""), cards: Snapshot.inbound(s, p.id, BY).map((e) => e.from).sort() })),
        ),
      affected: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => affectedCards(snapshotOf(before), snapshotOf(after))),
    } as never
  }),
})
