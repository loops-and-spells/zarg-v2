import { Effect } from "effect"
import type { Asker, Rlm } from "@zarg/rlm"
import type { ThreadLog } from "./log"
import type { Threads } from "./server"
import { makeThread, type Thread, type ThreadDeps } from "./thread"

export interface ThreadsDeps {
  readonly log: ThreadLog
  readonly agenda: ThreadDeps["agenda"]
  readonly render?: ThreadDeps["render"]
  readonly suggest?: ThreadDeps["suggest"]
  readonly whatNext?: ThreadDeps["whatNext"]
  /** An RLM runner whose Inquire uses `asker` and whose events go to `observe`. */
  readonly makeRlm: (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
  /** Threads that exist from the start besides `main` (the `plan` and `implement` views). */
  readonly extra?: ReadonlyArray<Thread>
  /** Stopping main also stops this (a rehearse run: the developer's stop is for everything). */
  readonly alsoStop?: Effect.Effect<void>
}

/** Threads by id, created on first use. `main` exists from the start. */
export const makeThreads = (deps: ThreadsDeps) =>
  Effect.gen(function* () {
    const threads = new Map<string, Thread>()
    const create = (id: string, focus: ReadonlyArray<string>) =>
      makeThread({
        id,
        focus,
        log: deps.log,
        agenda: deps.agenda,
        ...(deps.render !== undefined ? { render: deps.render } : {}),
        ...(deps.suggest !== undefined ? { suggest: deps.suggest } : {}),
        ...(deps.whatNext !== undefined ? { whatNext: deps.whatNext } : {}),
        driver: (spec, asker, observe) => Effect.flatMap(deps.makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
      })
    const main = yield* create("main", [])
    threads.set("main", deps.alsoStop === undefined ? main : { ...main, stop: Effect.andThen(main.stop, deps.alsoStop) })
    for (const t of deps.extra ?? []) threads.set(t.id, t)
    const registry: Threads["Service"] = {
      get: (id, focus) =>
        Effect.gen(function* () {
          const existing = threads.get(id)
          if (existing !== undefined) return existing
          const t = yield* create(id, focus)
          threads.set(id, t)
          return t
        }),
      list: () => [...threads.values()],
      add: (t) => void threads.set(t.id, t),
    }
    return registry
  })
