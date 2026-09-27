import { Effect } from "effect"
import type { Thread } from "@zarg/agent-host"
import type { Threads } from "./server"

export interface ThreadsDeps {
  /** A thread from the agent that holds the conversation (zarg), by id and focus. */
  readonly makeThread: (id: string, focus: ReadonlyArray<string>) => Effect.Effect<Thread>
  /** Threads that exist from the start besides `main` (the `plan` and `implement` views). */
  readonly extra?: ReadonlyArray<Thread>
  /** Stopping main also stops this (service plugins running in the background). */
  readonly alsoStop?: Effect.Effect<void>
}

/** Threads by id, created on first use. `main` exists from the start. */
export const makeThreads = (deps: ThreadsDeps) =>
  Effect.gen(function* () {
    const threads = new Map<string, Thread>()
    const main = yield* deps.makeThread("main", [])
    threads.set("main", deps.alsoStop === undefined ? main : { ...main, stop: Effect.andThen(main.stop, deps.alsoStop) })
    for (const t of deps.extra ?? []) threads.set(t.id, t)
    const registry: Threads["Service"] = {
      get: (id, focus) =>
        Effect.gen(function* () {
          const existing = threads.get(id)
          if (existing !== undefined) return existing
          const t = yield* deps.makeThread(id, focus)
          threads.set(id, t)
          return t
        }),
      list: () => [...threads.values()],
      add: (t) => void threads.set(t.id, t),
    }
    return registry
  })
