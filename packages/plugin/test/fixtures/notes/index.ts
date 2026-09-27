import { Effect, Schema } from "effect"
import { diff, Put, Snapshot } from "@zarg/graph/pure"
import { definePlugin, Graph, PluginFailure } from "@zarg/plugin-sdk"

/** A tiny graph plugin on the SDK: notes that must link to exactly one topic (the host tests' fixture). */
const TopicProps = Schema.Struct({ name: Schema.String })
const NoteProps = Schema.Struct({ text: Schema.String })
const Json = Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })
const ToolResult = Schema.Struct({ changes: Schema.Array(Schema.Unknown), message: Schema.String })
const Findings = Schema.Struct({ findings: Schema.Array(Schema.Unknown) })
const Items = Schema.Array(Schema.Unknown)
const snapOf = (j: { nodes: ReadonlyArray<unknown> }) => Snapshot.make(j.nodes as never)

export default definePlugin({
  name: "notes",
  service: "Notes",
  archetype: "graph",
  config: Schema.Struct({}),
  scopes: { graph: "write" },
  graph: { nodes: { topic: TopicProps, note: NoteProps }, edges: { about: { from: "note", to: "topic", min: 1, max: 1 } } },
  methods: {
    "add-topic": { doc: "Add a topic", params: Schema.Struct({ name: Schema.String }), success: ToolResult, agents: true },
    "add-note": { doc: "Add a note about a topic", params: Schema.Struct({ text: Schema.String, topic: Schema.String }), success: ToolResult, agents: true },
    spin: { doc: "Never answers (restart tests).", params: Schema.Struct({}), success: Schema.Null, deadlineMs: 300 },
    validate: { doc: "Node props.", params: Schema.Struct({ changes: Schema.Array(Schema.Unknown) }), success: Findings },
    lint: { doc: "Lints.", params: Schema.Struct({ before: Json, after: Json }), success: Findings },
    agenda: { doc: "Topics without notes.", params: Schema.Struct({}), success: Items },
    render: { doc: "Topics.", params: Schema.Struct({ focus: Schema.optionalKey(Schema.Array(Schema.String)) }), success: Schema.String },
    affected: { doc: "Added notes.", params: Schema.Struct({ before: Json, after: Json }), success: Schema.Struct({ cards: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }) },
  },
  make: Effect.gen(function* () {
    const graph = yield* Graph
    const snap = graph.snapshot.pipe(Effect.orDie)
    return {
      "add-topic": ({ name }) =>
        Effect.map(snap, (s) => {
          const id = Snapshot.nextId(s, "T")
          return { changes: [Put({ id, type: "notes/topic", props: { name }, edges: [] })], message: `created ${id}` }
        }),
      "add-note": ({ text, topic }) =>
        Effect.flatMap(snap, (s) => {
          if (!s.nodes.has(topic)) return Effect.fail(new PluginFailure({ tag: "ToolError", message: `no topic ${topic}` }))
          const id = Snapshot.nextId(s, "N")
          return Effect.succeed({ changes: [Put({ id, type: "notes/note", props: { text }, edges: [{ type: "notes/about", to: topic }] })], message: `created ${id}` })
        }),
      spin: () => Effect.never,
      validate: ({ changes }) =>
        Effect.sync(() => ({
          findings: (changes as ReadonlyArray<{ _tag: string; node?: { id: string; type: string; props: unknown } }>).flatMap((c) => {
            if (c._tag !== "Put" || c.node === undefined) return []
            const schema = c.node.type === "notes/topic" ? TopicProps : c.node.type === "notes/note" ? NoteProps : undefined
            if (schema === undefined) return []
            return Schema.is(schema)(c.node.props) ? [] : [{ severity: "error", code: "invalid-props", message: `${c.node.id}: props do not match ${c.node.type}`, about: [c.node.id] }]
          }),
        })),
      lint: ({ before, after }) =>
        Effect.sync(() => {
          const d = diff(snapOf(before), snapOf(after))
          const touched = [...d.added, ...d.changed.map((c) => c.after)]
          return {
            findings: [
              ...touched.filter((n) => n.type === "notes/note" && String(n.props.text).includes("TODO")).map((n) => ({ severity: "warn", code: "todo", message: `${n.id} has a TODO`, about: [n.id] })),
              ...d.added.filter((n) => n.type === "notes/topic" && n.props.name === "").map((n) => ({ severity: "error", code: "empty-name", message: `${n.id}: name is empty`, about: [n.id] })),
            ],
          }
        }),
      agenda: () =>
        Effect.map(snap, (s) =>
          Snapshot.byType(s, "notes/topic")
            .filter((t) => Snapshot.inbound(s, t.id, "notes/about").length === 0)
            .map((t) => ({ id: `empty:${t.id}`, title: `${t.id} has no notes`, detail: "", about: [t.id], priority: 2 })),
        ),
      render: ({ focus }) =>
        Effect.map(snap, (s) =>
          Snapshot.byType(s, "notes/topic")
            .filter((t) => focus === undefined || focus.includes(t.id))
            .map((t) => `# ${String(t.props.name)}`)
            .join("\n"),
        ),
      affected: ({ before, after }) => Effect.sync(() => ({ cards: diff(snapOf(before), snapOf(after)).added.filter((n) => n.type === "notes/note").map((n) => n.id).sort(), removed: [] })),
    }
  }),
})
