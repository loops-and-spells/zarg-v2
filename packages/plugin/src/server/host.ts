import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  diff,
  type Expect,
  GraphStore,
  type GraphError,
  hash,
  type IoError,
  type Loaded,
  Snapshot,
} from "@zarg/graph"
import { type AgendaItem, type Finding, type ServerPlugin, type Tool, ToolError } from "./plugin"
import { check, PluginConfigError, registry } from "./validate"

export class LintFailed extends Data.TaggedError("LintFailed")<{ readonly findings: ReadonlyArray<Finding> }> {}

export interface ToolInfo {
  readonly name: string
  readonly description: string
  readonly params: unknown
}

export interface CallResult {
  readonly message: string
  readonly added: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<Finding>
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly tools: ReadonlyArray<ToolInfo>
    /** Run a tool through the write pipeline: decode params, run, check, commit. */
    readonly call: (
      name: string,
      params: unknown,
      expect?: Expect,
    ) => Effect.Effect<CallResult, ToolError | LintFailed | GraphError>
    /** Check the whole graph as if every node were new. */
    readonly lint: Effect.Effect<ReadonlyArray<Finding>, IoError>
    readonly agenda: (focus?: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<AgendaItem>, IoError>
    readonly render: (focus?: ReadonlySet<string>) => Effect.Effect<string, IoError>
  }
>()("@zarg/plugin/PluginHost") {}

const problemItems = (loaded: Loaded): ReadonlyArray<AgendaItem> =>
  loaded.problems.map((p) => ({
    id: `invalid-file:${p.file}`,
    title: `Fix ${p.file}`,
    detail: p.message,
    about: [],
    priority: 1,
  }))

const inFocus = (focus: ReadonlySet<string> | undefined, about: ReadonlyArray<string>) =>
  focus === undefined || about.length === 0 || about.some((id) => focus.has(id))

export const layer = (
  plugins: ReadonlyArray<ServerPlugin>,
): Layer.Layer<PluginHost, PluginConfigError, GraphStore> =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const store = yield* GraphStore
      const reg = yield* Effect.try({
        try: () => registry(plugins),
        catch: (e) => (e instanceof PluginConfigError ? e : new PluginConfigError(String(e))),
      })
      const tools = new Map<string, Tool>()
      for (const p of plugins) for (const t of p.tools ?? []) tools.set(`${p.name}/${t.name}`, t)

      const call = (name: string, raw: unknown, expect: Expect = {}) =>
        Effect.gen(function* () {
          const t = tools.get(name)
          if (t === undefined) {
            return yield* new ToolError({ message: `unknown tool "${name}"; run \`zarg tool list\`` })
          }
          const params = yield* Schema.decodeUnknownEffect(t.params)(raw).pipe(
            Effect.mapError((e) => new ToolError({ message: `${name}: invalid params: ${e.message}` })),
          )
          const before = yield* store.snapshot
          const result = yield* t.run(params, before)
          const after = Snapshot.applyChanges(before, result.changes)
          const d = diff(before, after)
          const findings = check(reg, { before, after, diff: d })
          const errors = findings.filter((f) => f.severity === "error")
          if (errors.length > 0) return yield* new LintFailed({ findings: errors })
          // Guard against writes that land between our read and our commit.
          const touched: Record<string, string> = {}
          for (const c of result.changes) {
            const id = c._tag === "Put" ? c.node.id : c.id
            const cur = before.nodes.get(id)
            touched[id] = cur === undefined ? "absent" : hash(cur)
          }
          yield* store.commit(result.changes, { ...touched, ...expect })
          return {
            message: result.message,
            added: d.added.map((n) => n.id),
            changed: d.changed.map((c) => c.id),
            removed: d.removed.map((n) => n.id),
            warnings: findings,
          }
        })

      const lint = Effect.map(store.snapshot, (after) =>
        check(reg, { before: Snapshot.empty, after, diff: diff(Snapshot.empty, after) }),
      )

      const agenda = (focus?: ReadonlySet<string>) =>
        Effect.map(store.load, (loaded) =>
          [...problemItems(loaded), ...plugins.flatMap((p) => p.agenda?.(loaded.snapshot) ?? [])]
            .filter((item) => inFocus(focus, item.about))
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
        )

      const render = (focus?: ReadonlySet<string>) =>
        Effect.map(store.snapshot, (snap) =>
          plugins
            .flatMap((p) => (p.render === undefined ? [] : [p.render(snap, focus)]))
            .filter((s) => s.length > 0)
            .join("\n\n"),
        )

      return {
        tools: [...tools].map(([name, t]) => ({
          name,
          description: t.description,
          params: Schema.toJsonSchemaDocument(t.params),
        })),
        call,
        lint,
        agenda,
        render,
      }
    }),
  )
