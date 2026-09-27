import { Schema } from "effect"

export const NodeId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/))

export const Edge = Schema.Struct({
  type: Schema.String,
  to: NodeId,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
export type Edge = typeof Edge.Type

export const Node = Schema.Struct({
  id: NodeId,
  type: Schema.String,
  props: Schema.Record(Schema.String, Schema.Json),
  edges: Schema.Array(Edge),
})
export type Node = typeof Node.Type

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** Sorted keys, two-space indent, trailing newline: byte-stable across writers. */
export const canonical = (node: Node): string => `${JSON.stringify(sortKeys(node), null, 2)}\n`
