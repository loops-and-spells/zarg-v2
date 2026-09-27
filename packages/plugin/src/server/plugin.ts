import { Data } from "effect"
import type { Change, Diff, Snapshot } from "@zarg/graph"

/** Edge cardinality between two of the plugin's node types (local names, e.g. "card"). */
export interface EdgeSpec {
  readonly from: string
  readonly to: string
  readonly min?: number
  readonly max?: number
}

export interface Finding {
  readonly severity: "error" | "warn"
  readonly code: string
  readonly message: string
  readonly about: ReadonlyArray<string>
}

export interface LintContext {
  readonly before: Snapshot.Snapshot
  readonly after: Snapshot.Snapshot
  readonly diff: Diff
}

export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

export interface ToolResult {
  readonly changes: ReadonlyArray<Change>
  /** One line for the agent: what happened, with the ids it created. */
  readonly message: string
}

export interface AgendaItem {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly about: ReadonlyArray<string>
  /** 1 is most urgent. */
  readonly priority: number
}
