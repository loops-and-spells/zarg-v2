import { Data, Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { Failure, FromPlugin, ToPlugin } from "./protocol"

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{ readonly name: string; readonly message: string }> {}
export type PluginCallTag = "NotGranted" | "PluginCrashed" | "Deadline" | "PluginError" | "UnknownMethod"
/** A failed plugin call; `_tag` is the kind, so callers can `Effect.catchTag` on it. */
export class PluginCallError extends Data.Error<{ readonly _tag: PluginCallTag; readonly message: string }> {}

export type Powers = { readonly [power: string]: (args: unknown) => Promise<unknown> }

export interface PluginProcess {
  readonly call: (method: string, params: unknown, deadlineMs?: number) => Effect.Effect<unknown, PluginCallError>
  readonly stream: (method: string, params: unknown) => Stream.Stream<unknown, PluginCallError>
  readonly stop: Effect.Effect<void>
}

const RUNNER = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_DEADLINE_MS = 10_000

type Waiter = { readonly onChunk?: (v: unknown) => void; readonly done: (r: { ok: true; value: unknown } | { ok: false; error: Failure | { tag: "PluginCrashed" | "Deadline"; message: string } }) => void }

/**
 * One plugin in its own Bun process (empty environment, locked down, one Compartment). A call past its
 * deadline, or a crash, kills the process; the next call starts a fresh one with the same bundle.
 */
export const spawnPlugin = (opts: {
  readonly name: string
  readonly bundle: string
  readonly powers: Powers
  readonly deadlineMs?: number
  readonly onExit?: (reason: "crash" | "deadline" | "stop") => void
}): Effect.Effect<PluginProcess, PluginLoadError, Scope.Scope> =>
  Effect.gen(function* () {
    let child: ReturnType<typeof Bun.spawn> | undefined
    let ready: Promise<void> | undefined
    let nextId = 0
    const waiters = new Map<number, Waiter>()
    // Each process has a generation: an old process's exit must not touch the state of its successor.
    let generation = 0

    const failAll = (tag: "PluginCrashed" | "Deadline", message: string) => {
      for (const [, w] of waiters) w.done({ ok: false, error: { tag, message } })
      waiters.clear()
    }

    const start = () =>
      new Promise<void>((resolve, reject) => {
        const gen = ++generation
        const proc = Bun.spawn([process.execPath, RUNNER], {
          env: {},
          stdio: ["ignore", "ignore", "ignore"],
          ipc: (m: FromPlugin) => {
            if (m.type === "ready") proc.send({ type: "load", bundle: opts.bundle } satisfies ToPlugin)
            else if (m.type === "loaded") resolve()
            else if (m.type === "load-failed") reject(new PluginLoadError({ name: opts.name, message: m.message }))
            else if (m.type === "power") {
              const handler = opts.powers[m.power]
              const reply = (r: ToPlugin) => proc.send(r)
              if (handler === undefined) reply({ type: "power-reply", id: m.id, ok: false, error: { tag: "NotGranted", message: `power "${m.power}" is not granted to ${opts.name}` } })
              else handler(m.args).then(
                (value) => reply({ type: "power-reply", id: m.id, ok: true, value }),
                (e) => reply({ type: "power-reply", id: m.id, ok: false, error: { tag: e?.tag === "NotGranted" ? "NotGranted" : "PluginError", message: String(e?.message ?? e) } }),
              )
            } else if (m.type === "chunk") waiters.get(m.id)?.onChunk?.(m.value)
            else if (m.type === "end") { waiters.get(m.id)?.done({ ok: true, value: undefined }); waiters.delete(m.id) }
            else if (m.type === "reply") {
              const w = waiters.get(m.id)
              waiters.delete(m.id)
              w?.done(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error })
            }
          },
          onExit: () => {
            reject(new PluginLoadError({ name: opts.name, message: "plugin process exited while loading" }))
            // Killed on purpose: kill() already reset the state and reported why.
            if (gen !== generation) return
            child = undefined
            ready = undefined
            failAll("PluginCrashed", `${opts.name}: plugin process exited`)
            opts.onExit?.("crash")
          },
        })
        child = proc
      })

    const ensure = Effect.tryPromise({
      try: () => (ready ??= start()),
      catch: (e) => (e instanceof PluginLoadError ? e : new PluginLoadError({ name: opts.name, message: String(e) })),
    })

    const kill = (why: "deadline" | "stop") => Effect.sync(() => {
      if (child === undefined) return
      const old = child
      generation++
      child = undefined
      ready = undefined
      failAll(why === "deadline" ? "Deadline" : "PluginCrashed", why === "deadline" ? `${opts.name}: another call exceeded its deadline` : `${opts.name}: plugin stopped`)
      old.kill()
      opts.onExit?.(why)
    })

    // Load once now, so a broken bundle fails here and not on the first call.
    yield* ensure
    yield* Effect.addFinalizer(() => kill("stop"))

    const toError = (e: Failure | { tag: "PluginCrashed" | "Deadline"; message: string }) => new PluginCallError({ _tag: e.tag, message: e.message })

    const call = (method: string, params: unknown, deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS) =>
      Effect.gen(function* () {
        yield* ensure.pipe(Effect.mapError((e) => new PluginCallError({ _tag: "PluginCrashed", message: e.message })))
        const id = ++nextId
        const done = yield* Deferred.make<unknown, PluginCallError>()
        waiters.set(id, { done: (r) => Deferred.doneUnsafe(done, r.ok ? Effect.succeed(r.value) : Effect.fail(toError(r.error))) })
        child!.send({ type: "call", id, method, params } satisfies ToPlugin)
        return yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.andThen(kill("deadline"), Effect.fail(new PluginCallError({ _tag: "Deadline", message: `${opts.name}.${method}: no answer within ${deadlineMs} ms` }))) }),
        )
      })

    const stream = (method: string, params: unknown) =>
      Stream.callback<unknown, PluginCallError>((queue) =>
        Effect.gen(function* () {
          yield* ensure.pipe(Effect.mapError((e) => new PluginCallError({ _tag: "PluginCrashed", message: e.message })))
          const id = ++nextId
          waiters.set(id, {
            onChunk: (v) => Queue.offerUnsafe(queue, v),
            done: (r) => (r.ok ? Queue.endUnsafe(queue) : Queue.failCauseUnsafe(queue, toError(r.error) as never)),
          })
          child!.send({ type: "call", id, method, params } satisfies ToPlugin)
          yield* Effect.addFinalizer(() => Effect.sync(() => { if (waiters.delete(id)) child?.send({ type: "cancel", id } satisfies ToPlugin) }))
        }),
      )

    return { call, stream, stop: kill("stop") } satisfies PluginProcess
  })
