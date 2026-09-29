import { Effect } from "effect"

type Invoke = (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, { readonly message: string }>

/** A plugin agent's id is `<plugin>:<id>`; an RLM's has no colon. */
const owner = (agent: string) => {
  const at = agent.indexOf(":")
  return at < 0 ? undefined : { plugin: agent.slice(0, at), id: agent.slice(at + 1) }
}

/** Actions on an agent's view go to its plugin's `act`. */
export const makeActions = (deps: {
  readonly invoke: Invoke
  /** Take a question the agent no longer waits for out of its view (its messages stay). */
  readonly withdraw?: (thread: string, agent: string) => void
  /** The surfaces an action declares it opens (`opens`), looked up in the view (its store key) it came from. */
  readonly opensOf?: (view: string, action: string) => ReadonlyArray<{ readonly surface: string; readonly agent?: string }> | undefined
  /** Open a plugin's surfaces for its agents (local ids), as the operator's own gesture. */
  readonly open?: (plugin: string, surfaces: ReadonlyArray<{ readonly surface: string; readonly agent: string }>) => void
}) => ({
  /** `view`: the view store key the action came from (a panel, popover or sheet of the agent); the agent's start view when absent. */
  act: (_thread: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>, view?: string, text?: string): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no actions` })
    // An action that opens surfaces is the shell's to carry out: the plugin is not called.
    const opens = deps.opensOf?.(view ?? agent, action)
    if (opens !== undefined && deps.open !== undefined) {
      const open = deps.open
      return Effect.sync(() => {
        try {
          open(o.plugin, opens.map((x) => ({ surface: x.surface, agent: x.agent ?? o.id })))
          return { notice: "opened" }
        } catch (e) {
          return { notice: e instanceof Error ? e.message : String(e) }
        }
      })
    }
    return deps.invoke(o.plugin, "act", { agent: o.id, action, ...(section !== undefined ? { section } : {}), rows, ...(text !== undefined ? { text } : {}) }).pipe(
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "done") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
  /** The operator answered a question in a plugin agent's conversation. */
  answer: (thread: string, agent: string, question: string, answer: { readonly choice?: string; readonly other?: string }): Effect.Effect<{ readonly notice: string }> => {
    const o = owner(agent)
    if (o === undefined) return Effect.succeed({ notice: `${agent} has no conversation of its own` })
    return deps.invoke(o.plugin, "$answer", { agent: o.id, question, answer }).pipe(
      Effect.tap((r) => Effect.sync(() => ((r as { withdrawn?: unknown } | null)?.withdrawn === true ? deps.withdraw?.(thread, agent) : undefined))),
      Effect.map((r) => ({ notice: String((r as { notice?: unknown } | null)?.notice ?? "answered") })),
      Effect.catch((e) => Effect.succeed({ notice: e.message })),
    )
  },
  /** The operator wrote to a plugin agent. */
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
