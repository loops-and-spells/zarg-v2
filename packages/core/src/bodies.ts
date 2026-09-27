import { Effect, Schema } from "effect"
import type { ThreadLog } from "./log"

/** What an agent's body shows: history lines, text lines, and tables in tabs with actions on selected rows. */
const BodyPartSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("history"), lines: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))) }),
  Schema.Struct({ kind: Schema.Literal("lines"), lines: Schema.Array(Schema.Struct({ text: Schema.String, tone: Schema.optionalKey(Schema.String) })) }),
  Schema.Struct({
    kind: Schema.Literal("tabs"),
    tabs: Schema.Array(Schema.Struct({ title: Schema.String, columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Struct({ id: Schema.String, cells: Schema.Array(Schema.String) })) })),
    actions: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, key: Schema.String })),
  }),
])
const BodySchema = Schema.Struct({ parts: Schema.Array(BodyPartSchema) })
export type BodyPart = typeof BodyPartSchema.Type
export type Body = typeof BodySchema.Type
const decodeBody = Schema.decodeUnknownEffect(BodySchema)
const line = (text: string): Body => ({ parts: [{ kind: "lines", lines: [{ text, tone: "error" }] }] })

type Invoke = (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly message: string }>

/** A plugin agent's id is `<plugin>:<id>`; an RLM's has no colon. */
const owner = (agent: string) => {
  const at = agent.indexOf(":")
  return at < 0 ? undefined : { plugin: agent.slice(0, at), id: agent.slice(at + 1) }
}

/**
 * Agents' bodies: an RLM's is its history; a plugin agent's comes from the plugin's `body`, with its history
 * parts filled from the transcript (a plugin cannot read transcripts). Actions go to the plugin's `act`.
 */
export const makeBodies = (deps: { readonly log: ThreadLog; readonly invoke: Invoke; readonly onApply?: (plugin: string, rows: ReadonlyArray<string>) => void }) => ({
  body: (thread: string, agent: string): Effect.Effect<Body | undefined> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ parts: [{ kind: "history", lines: deps.log.history(thread, agent) }] })
    // What the plugin drew is checked here: a malformed part never reaches the TUI; a gone plugin says so.
    return deps.invoke(o.plugin, "body", { agent: o.id }).pipe(
      Effect.flatMap((b) =>
        decodeBody(b ?? { parts: [] }).pipe(
          Effect.map((body): Body => ({ parts: body.parts.map((p) => (p.kind === "history" ? { kind: "history" as const, lines: deps.log.history(thread, agent) } : p)) })),
          Effect.orElseSucceed(() => line(`${o.plugin} drew an invalid body`)),
        ),
      ),
      Effect.catch((e) => Effect.succeed(line(e.message))),
    )
  },
  act: (_thread: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no actions` })
    return deps.invoke(o.plugin, "act", { agent: o.id, action, ...(section !== undefined ? { section } : {}), rows }).pipe(
      Effect.tap(() => Effect.sync(() => (action === "apply" ? deps.onApply?.(o.plugin, rows) : undefined))),
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
})

export type Bodies = ReturnType<typeof makeBodies>
