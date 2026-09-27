import { Effect } from "effect"
import type { ThreadLog } from "./log"

/** What an agent's body shows: history lines, text lines, and tables in tabs with actions on selected rows. */
export type BodyPart =
  | { readonly kind: "history"; readonly lines?: ReadonlyArray<Record<string, unknown>> }
  | { readonly kind: "lines"; readonly lines: ReadonlyArray<{ readonly text: string; readonly tone?: string }> }
  | {
      readonly kind: "tabs"
      readonly tabs: ReadonlyArray<{ readonly title: string; readonly columns: ReadonlyArray<string>; readonly rows: ReadonlyArray<{ readonly id: string; readonly cells: ReadonlyArray<string> }> }>
      readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string; readonly key: string }>
    }
export interface Body { readonly parts: ReadonlyArray<BodyPart> }

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
export const makeBodies = (deps: { readonly log: ThreadLog; readonly invoke: Invoke }) => ({
  body: (thread: string, agent: string): Effect.Effect<Body | undefined> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ parts: [{ kind: "history", lines: deps.log.history(thread, agent) }] })
    return deps.invoke(o.plugin, "body", { agent: o.id }).pipe(
      Effect.map((b) => {
        const parts = ((b as Body | null)?.parts ?? []) as ReadonlyArray<BodyPart>
        return { parts: parts.map((p) => (p.kind === "history" ? { kind: "history" as const, lines: deps.log.history(thread, agent) } : p)) }
      }),
      Effect.orElseSucceed(() => undefined),
    )
  },
  act: (_thread: string, agent: string, action: string, rows: ReadonlyArray<string>): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no actions` })
    return deps.invoke(o.plugin, "act", { agent: o.id, action, rows }).pipe(
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
})

export type Bodies = ReturnType<typeof makeBodies>
