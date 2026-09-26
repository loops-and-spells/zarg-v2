import { Effect } from "effect"
import type { Asker, Rlm } from "@zarg/rlm"
import type { ThreadLog } from "./log"
import type { Threads } from "./server"
import { makeThread, type Thread, type ThreadDeps } from "./thread"

export interface ThreadsDeps {
  readonly log: ThreadLog
  readonly agenda: ThreadDeps["agenda"]
  /** An RLM runner whose Inquire uses `asker` and whose events go to `observe`. */
  readonly makeRlm: (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
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
        driver: (spec, asker, observe) => Effect.flatMap(deps.makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
      })
    threads.set("main", yield* create("main", []))
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
    }
    return registry
  })
