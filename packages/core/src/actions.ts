import { Effect } from "effect"

type Invoke = (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly message: string }>

/** A plugin agent's id is `<plugin>:<id>`; an RLM's has no colon. */
const owner = (agent: string) => {
  const at = agent.indexOf(":")
  return at < 0 ? undefined : { plugin: agent.slice(0, at), id: agent.slice(at + 1) }
}

/** Actions on an agent's view go to its plugin's `act`; the core records what the developer applied (the findings gate). */
export const makeActions = (deps: { readonly invoke: Invoke; readonly onApply?: (plugin: string, rows: ReadonlyArray<string>) => void }) => ({
  act: (_thread: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no actions` })
    return deps.invoke(o.plugin, "act", { agent: o.id, action, ...(section !== undefined ? { section } : {}), rows }).pipe(
      Effect.tap(() => Effect.sync(() => (action === "apply" ? deps.onApply?.(o.plugin, rows) : undefined))),
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
  /** The developer answered a question in a plugin agent's conversation. */
  answer: (_thread: string, agent: string, question: string, answer: { readonly choice?: string; readonly other?: string }): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no conversation of its own` })
    return deps.invoke(o.plugin, "$answer", { agent: o.id, question, answer }).pipe(
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "answered") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
  /** The developer wrote to a plugin agent. */
  message: (_thread: string, agent: string, text: string): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no conversation of its own` })
    return deps.invoke(o.plugin, "$message", { agent: o.id, text }).pipe(
      Effect.as({ notice: "sent" }),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
})
export type Actions = ReturnType<typeof makeActions>
