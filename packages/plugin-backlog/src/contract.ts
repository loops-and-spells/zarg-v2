import { Schema } from "effect"
import { pluginContract } from "@zarg/plugin-sdk"

export const Severity = Schema.Literals(["high", "medium", "low"])
/** A report as its source files it: what it is about (a ref with the version seen), where, who, what, and the source's first call on it. */
export const FiledEntry = Schema.Struct({
  ref: Schema.String,
  journeys: Schema.Array(Schema.String),
  persona: Schema.String,
  kind: Schema.String,
  severity: Severity,
  note: Schema.String,
  from: Schema.Struct({ agent: Schema.String, run: Schema.String }),
  triage: Schema.Struct({ on: Schema.Boolean, why: Schema.String }),
})
export type FiledEntry = typeof FiledEntry.Type
export const FeedbackState = Schema.Literals(["open", "stale", "planned", "closed"])
export type FeedbackState = typeof FeedbackState.Type

/** The backlog's surface for other plugins: file feedback, ask where it stands. */
export const Backlog = pluginContract("backlog", {
  file: { params: Schema.Struct({ entries: Schema.Array(FiledEntry) }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
  status: { params: Schema.Struct({ ids: Schema.Array(Schema.String) }), success: Schema.Array(Schema.Struct({ id: Schema.String, state: FeedbackState, on: Schema.Boolean })) },
})
