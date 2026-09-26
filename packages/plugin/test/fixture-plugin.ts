import { Effect, Schema } from "effect"
import { Put, Snapshot } from "@zarg/graph"
import { server, tool, ToolError } from "../src/server"

/** A tiny plugin: notes that must link to exactly one topic. */
export const notes = server({
  name: "notes",
  nodes: {
    topic: Schema.Struct({ name: Schema.String }),
    note: Schema.Struct({ text: Schema.String }),
  },
  edges: { about: { from: "note", to: "topic", min: 1, max: 1 } },
  lints: [
    ({ diff }) =>
      [...diff.added, ...diff.changed.map((c) => c.after)]
        .filter((n) => n.type === "notes/note" && String(n.props.text).includes("TODO"))
        .map((n) => ({ severity: "warn" as const, code: "todo", message: `${n.id} has a TODO`, about: [n.id] })),
    ({ diff }) =>
      diff.added
        .filter((n) => n.type === "notes/topic" && n.props.name === "")
        .map((n) => ({ severity: "error" as const, code: "empty-name", message: `${n.id}: name is empty`, about: [n.id] })),
  ],
  tools: [
    tool({
      name: "add-topic",
      description: "Add a topic",
      params: Schema.Struct({ name: Schema.String }),
      run: ({ name }, snap) => {
        const id = Snapshot.nextId(snap, "T")
        return Effect.succeed({
          changes: [Put({ id, type: "notes/topic", props: { name }, edges: [] })],
          message: `created ${id}`,
        })
      },
    }),
    tool({
      name: "add-note",
      description: "Add a note about a topic",
      params: Schema.Struct({ text: Schema.String, topic: Schema.String }),
      run: ({ text, topic }, snap) => {
        if (!snap.nodes.has(topic)) return Effect.fail(new ToolError({ message: `no topic ${topic}` }))
        const id = Snapshot.nextId(snap, "N")
        return Effect.succeed({
          changes: [Put({ id, type: "notes/note", props: { text }, edges: [{ type: "notes/about", to: topic }] })],
          message: `created ${id}`,
        })
      },
    }),
  ],
  agenda: (snap) =>
    Snapshot.byType(snap, "notes/topic")
      .filter((t) => Snapshot.inbound(snap, t.id, "notes/about").length === 0)
      .map((t) => ({ id: `empty:${t.id}`, title: `${t.id} has no notes`, detail: "", about: [t.id], priority: 2 })),
  render: (snap, focus) =>
    Snapshot.byType(snap, "notes/topic")
      .filter((t) => focus === undefined || focus.has(t.id))
      .map((t) => `# ${String(t.props.name)}`)
      .join("\n"),
})
