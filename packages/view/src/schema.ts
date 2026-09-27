import { Schema } from "effect"

/** What a line or cell means; each platform picks its own colour for it. */
export const Tone = Schema.Literals(["normal", "ok", "warn", "error", "dim", "accent"])
/** What a section is for; each platform places roles its own way. */
export const Role = Schema.Literals(["summary", "primary", "log", "pinned", "aside"])
/** An action on a table: on the selected rows (or the highlighted one), on the highlighted row, or on none. */
export const Action = Schema.Struct({ id: Schema.String, label: Schema.String, key: Schema.optionalKey(Schema.String), on: Schema.Literals(["selection", "row", "none"]) })
export const Column = Schema.Struct({ id: Schema.String, label: Schema.String })

export const StatsData = Schema.Struct({
  items: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String, tone: Schema.optionalKey(Tone) })),
  progress: Schema.optionalKey(Schema.Struct({ done: Schema.Number, total: Schema.Number })),
})
export const ListData = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, text: Schema.String, detail: Schema.optionalKey(Schema.String), state: Schema.optionalKey(Schema.Literals(["busy", "waiting", "done", "flagged"])), tone: Schema.optionalKey(Tone) }),
  ),
})
export const LogLine = Schema.Struct({ text: Schema.String, tone: Schema.optionalKey(Tone), at: Schema.optionalKey(Schema.Number) })
export const LogData = Schema.Struct({ lines: Schema.Array(LogLine) })
export const TableData = Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String, cells: Schema.Record(Schema.String, Schema.String), tone: Schema.optionalKey(Tone) })) })
export const KeyValueData = Schema.Struct({ pairs: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })) })
export const TextData = Schema.Struct({ markdown: Schema.String })

/** The data each leaf kind holds. `tabs` has none of its own: its tabs do. */
export const DATA = { stats: StatsData, list: ListData, log: LogData, table: TableData, keyvalue: KeyValueData, text: TextData } as const
export type LeafKind = keyof typeof DATA
export type SectionKind = LeafKind | "tabs"
export type LogLine = typeof LogLine.Type

const leafFields = {
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  columns: Schema.optionalKey(Schema.Array(Column)),
  selectable: Schema.optionalKey(Schema.Boolean),
  actions: Schema.optionalKey(Schema.Array(Action)),
}
export const LayoutLeaf = Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text"]) })
export const LayoutSection = Schema.Union([
  Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text"]), role: Role }),
  Schema.Struct({ id: Schema.String, title: Schema.optionalKey(Schema.String), kind: Schema.Literal("tabs"), role: Role, tabs: Schema.Array(LayoutLeaf) }),
])
/** A view as the manifest and the wire carry it. */
export const LayoutSchema = Schema.Struct({ name: Schema.String, sections: Schema.Array(LayoutSection) })
export type Layout = typeof LayoutSchema.Type
export type LayoutSection = typeof LayoutSection.Type
export type LayoutLeaf = typeof LayoutLeaf.Type
