import { Data, type Effect, type Schema } from "effect"
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
  readonly params: Schema.ConstraintDecoder<A>
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

export interface ServerPlugin {
  readonly name: string
  readonly requires?: ReadonlyArray<string>
  readonly nodes?: Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>
  readonly edges?: Readonly<Record<string, EdgeSpec>>
  readonly lints?: ReadonlyArray<Lint>
  readonly tools?: ReadonlyArray<Tool>
  readonly agenda?: (snapshot: Snapshot.Snapshot) => ReadonlyArray<AgendaItem>
  /** Gaps worth working on when the agenda is empty (not problems): what the driver offers as "what next". */
  readonly suggest?: (snapshot: Snapshot.Snapshot) => ReadonlyArray<AgendaItem>
  /** Human-readable view of the plugin's part of the graph, limited to `focus` ids when given. */
  readonly render?: (snapshot: Snapshot.Snapshot, focus?: ReadonlySet<string>) => string
}

export const server = (plugin: ServerPlugin): ServerPlugin => plugin
