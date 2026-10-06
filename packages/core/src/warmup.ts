import { Deferred, Duration, Effect, Fiber, Schedule } from "effect"
import type { Model } from "@zarg/model"

export interface WarmupDeps {
  /** The driver's model reference (`provider:model`), or none yet. */
  readonly driver: () => string | undefined
  readonly model: Pick<Model.Model["Service"], "list" | "warm">
  readonly agentEvents: (plugin: string, event: unknown) => void
  /** The model did not start: why, for setup to show beside the models to pick from. */
  readonly onFailed: (reason: string) => Effect.Effect<void>
  readonly tickMs?: number
}

const AGENT = "warmup"
const why = (e: unknown) => String((e as { message?: unknown })?.message ?? e).split("\n")[0]!

/**
 * The driver's model, warm before its first turn: a cold one is warmed while a warm-up agent shows how long it has
 * taken; `ready` answers once it is (true) or failed to start (false).
 */
// @scenario S-0037 S-0039
export const makeWarmup = (d: WarmupDeps) => {
  const done = Effect.runSync(Deferred.make<boolean>())
  const ensure = Effect.gen(function* () {
    const ref = d.driver()
    const at = ref?.indexOf(":") ?? -1
    if (ref === undefined || at < 0) return yield* Deferred.succeed(done, true).pipe(Effect.as(true))
    const provider = ref.slice(0, at)
    const id = ref.slice(at + 1)
    const info = (yield* d.model.list(provider).pipe(Effect.orElseSucceed(() => []))).find((m) => m.id === id)
    // Only a model its provider says is cold (or loading) is warmed: others answer as they are.
    if (info?.state !== "cold" && info?.state !== "loading") return yield* Deferred.succeed(done, true).pipe(Effect.as(true))
    d.agentEvents("core", { event: "start", id: AGENT, title: `warming ${ref}`, task: `Start ${ref} before zarg's first turn` })
    const started = Date.now()
    const ticker = yield* Effect.forkDetach(
      Effect.repeat(
        Effect.sync(() => d.agentEvents("core", { event: "status", id: AGENT, text: `warming ${ref} · ${Math.round((Date.now() - started) / 1000)}s` })),
        Schedule.spaced(Duration.millis(d.tickMs ?? 2_000)),
      ),
    )
    const r = yield* Effect.result(d.model.warm(ref))
    yield* Fiber.interrupt(ticker)
    if (r._tag === "Success") {
      d.agentEvents("core", { event: "end", id: AGENT, ok: true, message: `${ref} is warm` })
      return yield* Deferred.succeed(done, true).pipe(Effect.as(true))
    }
    const reason = `${ref} did not start: ${why(r.failure)}`
    d.agentEvents("core", { event: "end", id: AGENT, ok: false, message: reason })
    yield* d.onFailed(reason)
    return yield* Deferred.succeed(done, false).pipe(Effect.as(false))
  })
  return { ensure, ready: Deferred.await(done) }
}
