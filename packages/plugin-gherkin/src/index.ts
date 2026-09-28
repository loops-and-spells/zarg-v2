import { Effect, Schema } from "effect"
import { diff, type Node, Snapshot } from "@zarg/graph/pure"
import { definePlugin, Graph, PluginFailure } from "@zarg/plugin-sdk"
import { affectedCards } from "./affected"
import { agenda, suggest } from "./agenda"
import { Gherkin, StepParams, StepView, StoriesParams, StoriesResult } from "./contract"
import type { Finding } from "./kit"
import { clauseShape, stateText } from "./lints"
import { CARD, CardProps, PERSONA, PersonaProps, STATE, StateProps } from "./model"
import { render } from "./render"
import { planStories, stepView } from "./stories"
import { tools } from "./tools"

const SnapshotJson = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })
const ToolResult = Schema.Struct({ changes: Schema.Array(Schema.Unknown), message: Schema.String })
const Findings = Schema.Struct({ findings: Schema.Array(Schema.Unknown) })
const Items = Schema.Array(Schema.Unknown)
const snapshotOf = (j: { readonly nodes: ReadonlyArray<unknown> }) => Snapshot.make(j.nodes as ReadonlyArray<Node>)

const PROPS: Record<string, Schema.Codec<any, any>> = { [STATE]: StateProps, [CARD]: CardProps, [PERSONA]: PersonaProps }

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

/** The atomic Gherkin user action graph (states and cards), running in its own locked process. */
export default definePlugin({
  name: "gherkin",
  service: "Gherkin",
  archetype: "graph",
  implements: Gherkin,
  config: Schema.Struct({}),
  scopes: { graph: "write" },
  graph: {
    nodes: { state: StateProps, card: CardProps, persona: PersonaProps },
    edges: {
      arrives: { from: "card", to: "state", min: 1, max: 1 },
      given: { from: "card", to: "state", max: 3 },
      then: { from: "card", to: "state", min: 1, max: 5 },
      // Who acts in the card; none is an agenda item, not a structural error.
      by: { from: "card", to: "persona" },
    },
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
    affected: {
      doc: "Cards a change affects.",
      params: Schema.Struct({ before: SnapshotJson, after: SnapshotJson }),
      success: Schema.Struct({ cards: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }),
    },
  },
  make: Effect.gen(function* () {
    const graph = yield* Graph
    const snap = graph.snapshot.pipe(Effect.orDie)
    const runTool = (t: (typeof tools)[number]) => (p: unknown) =>
      Effect.flatMap(snap, (s) => t.run(p as never, s)).pipe(Effect.mapError((e) => new PluginFailure({ tag: "ToolError", message: e.message })))
    return {
      ...(Object.fromEntries(tools.map((t) => [t.name, runTool(t)])) as Record<string, (p: unknown) => Effect.Effect<any, PluginFailure>>),
      validate: ({ changes }: { changes: ReadonlyArray<unknown> }) => Effect.sync(() => ({ findings: validateProps(changes) })),
      lint: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => {
          const ctx = { before: snapshotOf(before), after: snapshotOf(after), diff: diff(snapshotOf(before), snapshotOf(after)) }
          return { findings: [clauseShape, stateText].flatMap((l) => l(ctx)) }
        }),
      agenda: () => Effect.map(snap, agenda),
      suggest: () => Effect.map(snap, suggest),
      render: ({ focus }: { focus?: ReadonlyArray<string> }) => Effect.map(snap, (s) => render(s, focus === undefined ? undefined : new Set(focus))),
      stories: ({ strategy, focus }: { strategy: "edge-pair" | "teleport"; focus?: ReadonlyArray<string> }) =>
        Effect.map(snap, (s) => planStories(s, strategy, focus === undefined || focus.length === 0 ? undefined : new Set(focus))),
      step: ({ card, via }: { card: string; via?: string }) => Effect.map(snap, (s) => stepView(s, card, via) ?? null),
      affected: ({ before, after }: { before: { nodes: ReadonlyArray<unknown> }; after: { nodes: ReadonlyArray<unknown> } }) =>
        Effect.sync(() => affectedCards(snapshotOf(before), snapshotOf(after))),
    } as never
  }),
})
