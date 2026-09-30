import { Effect } from "effect"
import * as E from "./events"
import type { ThreadLog } from "./log"

export const PROMPT = "zarg.prompt"
export const PROMPT_DONE = "zarg.prompt.done"

/**
 * Questions the core asks the operator itself (grants): they wait side by side, never behind zarg's own question,
 * and every client shows them as popovers, first in first out. Each is answered by its id.
 */
export const makePrompts = (log: ThreadLog, threadId = "main") => {
  // Plugins' popovers in the same queue: nothing waits on them, they close.
  const shown = new Map<string, { readonly agent: string; readonly view: string }>()
  const done = (id: string, withdrawn: boolean) => log.append(threadId, E.custom(PROMPT_DONE, withdrawn ? { id, withdrawn: true } : { id }))
  return {
    /** A grant popover from an older core (grants are inbox topics now): nothing waits on it. */
    answer: (_id: string, _a: { readonly choice: string }) => Effect.succeed({ notice: "that question is no longer open" }),
    /** A plugin's popover joins the queue (its view shown, its agent's actions), until it closes. */
    show: (item: { readonly plugin: string; readonly agent: string; readonly view: string; readonly title: string }) =>
      Effect.gen(function* () {
        const id = `prompt-${crypto.randomUUID()}`
        shown.set(id, { agent: item.agent, view: item.view })
        yield* log.append(threadId, E.custom(PROMPT, { id, kind: "surface", question: item.title, options: [], view: item.view, agent: item.agent }))
        return id
      }),
    /** The operator closed a popover (Esc), or its plugin did. */
    close: (id: string) =>
      Effect.gen(function* () {
        if (!shown.delete(id)) return { notice: "that question is no longer open" }
        yield* Effect.ignore(done(id, false))
        return { notice: "closed" }
      }),
    /** Whether one of this plugin's popovers is up (a plugin gets one place in the queue at a time). */
    shownBy: (plugin: string) => [...shown.values()].some((v) => v.agent.startsWith(`${plugin}:`)),
    /** The popover showing this agent's view, if one is up. */
    shownFor: (agent: string, view: string) => [...shown.entries()].find(([, v]) => v.agent === agent && v.view === view)?.[0],
    /** An agent that ended takes its popovers with it. */
    closeAgent: (agent: string) =>
      Effect.forEach(
        [...shown.entries()].filter(([, v]) => v.agent === agent).map(([id]) => id),
        (id) => Effect.andThen(Effect.sync(() => shown.delete(id)), Effect.ignore(done(id, true))),
        { discard: true },
      ),
    /** Prompts the last core left open have no one waiting: withdraw them. */
    closeStale: Effect.suspend(() => {
      const asked = new Set<string>()
      for (const e of log.all()) {
        if (e.type !== "CUSTOM") continue
        const id = String((e.value as { id?: unknown } | undefined)?.id)
        if (e.name === PROMPT) asked.add(id)
        if (e.name === PROMPT_DONE) asked.delete(id)
      }
      return Effect.forEach([...asked].filter((id) => !shown.has(id)), (id) => Effect.ignore(done(id, true)), { discard: true })
    }),
  }
}
export type PromptQueue = ReturnType<typeof makePrompts>
