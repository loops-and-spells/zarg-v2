import { Data, type Effect, type Schema } from "effect"
import type { Change, Diff, Snapshot } from "@zarg/graph/pure"

/** The Gherkin plugin's own building blocks (bundled with it, so nothing here may reach the host). */

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

/** Pure check over a proposed change. Look at `diff` to only judge what changed. */
export type Lint = (ctx: LintContext) => ReadonlyArray<Finding>

export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

export interface ToolResult {
  readonly changes: ReadonlyArray<Change>
  /** One line for the agent: what happened, with the ids it created. */
  readonly message: string
}

export interface Tool<A = any> {
  readonly name: string
  readonly description: string
  readonly params: Schema.Codec<A, any>
  readonly run: (params: A, snapshot: Snapshot.Snapshot) => Effect.Effect<ToolResult, ToolError>
}

/** Helper that infers `run`'s params from the schema. */
export const tool = <A>(t: Tool<A>): Tool<A> => t

export interface AgendaItem {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly about: ReadonlyArray<string>
  /** 1 is most urgent. */
  readonly priority: number
}
