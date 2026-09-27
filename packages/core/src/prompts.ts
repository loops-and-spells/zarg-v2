import { Deferred, Effect } from "effect"
import type { Answer, Question } from "@zarg/rlm"
import * as E from "./events"
import type { ThreadLog } from "./log"

export const PROMPT = "zarg.prompt"
export const PROMPT_DONE = "zarg.prompt.done"

/**
 * Questions the core asks the developer itself (grants): they wait side by side, never behind zarg's own question,
 * and every client shows them as popovers, first in first out. Each is answered by its id.
 */
export const makePrompts = (log: ThreadLog, threadId = "main") => {
  const open = new Map<string, Deferred.Deferred<Answer>>()
  // Plugins' popovers in the same queue: nothing waits on them, they close.
  const shown = new Map<string, { readonly agent: string; readonly view: string }>()
  const done = (id: string, withdrawn: boolean) => log.append(threadId, E.custom(PROMPT_DONE, withdrawn ? { id, withdrawn: true } : { id }))
  return {
    ask: (q: Question): Effect.Effect<Answer> =>
      Effect.gen(function* () {
        const id = `prompt-${crypto.randomUUID()}`
        const answer = yield* Deferred.make<Answer>()
        open.set(id, answer)
        yield* log.append(threadId, E.custom(PROMPT, { id, question: q.question, options: q.options, kind: "grant" }))
        // An asker that goes away (its plugin stopped, the core shutting down) takes its prompt off every screen.
        return yield* Deferred.await(answer).pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => open.delete(id)), Effect.ignore(done(id, true)))))
      }),
    answer: (id: string, a: { readonly choice: string }) =>
      Effect.gen(function* () {
        const waiting = open.get(id)
        if (waiting === undefined) return { notice: "that question is no longer open" }
        open.delete(id)
        yield* Effect.ignore(done(id, false))
        yield* Deferred.succeed(waiting, { choice: a.choice })
        return { notice: "answered" }
      }),
    /** A plugin's popover joins the queue (its view shown, its agent's actions), until it closes. */
    show: (item: { readonly plugin: string; readonly agent: string; readonly view: string; readonly title: string }) =>
      Effect.gen(function* () {
        const id = `prompt-${crypto.randomUUID()}`
        shown.set(id, { agent: item.agent, view: item.view })
        yield* log.append(threadId, E.custom(PROMPT, { id, kind: "surface", question: item.title, options: [], view: item.view, agent: item.agent }))
        return id
      }),
    /** The developer closed a popover (Esc), or its plugin did. */
    close: (id: string) =>
      Effect.gen(function* () {
        if (!shown.delete(id)) return { notice: "that question is no longer open" }
        yield* Effect.ignore(done(id, false))
        return { notice: "closed" }
      }),
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
      return Effect.forEach([...asked].filter((id) => !open.has(id) && !shown.has(id)), (id) => Effect.ignore(done(id, true)), { discard: true })
    }),
  }
}
export type PromptQueue = ReturnType<typeof makePrompts>
