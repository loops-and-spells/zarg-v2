import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Data, Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { Failure, FromPlugin, Identity, ToPlugin } from "./protocol"
import { isPower } from "./powers"

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{ readonly name: string; readonly message: string }> {}
export type PluginCallTag = "NotGranted" | "BudgetExceeded" | "PluginCrashed" | "Deadline" | "PluginError" | "UnknownMethod"
/** A failed plugin call; `_tag` is the kind, so callers can `Effect.catchTag` on it. */
export class PluginCallError extends Data.Error<{ readonly _tag: PluginCallTag; readonly message: string }> {}

export type Powers = { readonly [power: string]: (args: unknown) => Promise<unknown> }

export interface PluginProcess {
  readonly call: (method: string, params: unknown, deadlineMs?: number) => Effect.Effect<unknown, PluginCallError>
  readonly stream: (method: string, params: unknown) => Stream.Stream<unknown, PluginCallError>
  readonly stop: Effect.Effect<void>
  /** What the bundle said it is when it loaded (name, service, archetype), to compare with its manifest. */
  readonly identity: Identity
}

const RUNNER = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_DEADLINE_MS = 10_000
const DEFAULT_LOAD_TIMEOUT_MS = 10_000
const TICK_MS = 50

type Waiter = { readonly onChunk?: (v: unknown) => void; readonly done: (r: { ok: true; value: unknown } | { ok: false; error: Failure | { tag: "PluginCrashed" | "Deadline"; message: string } }) => void }

/**
 * One plugin in its own Bun process (empty environment, an empty working directory, locked down, one
 * Compartment). A call past its deadline, or a crash, kills the process; the next call starts a fresh one
 * with the same bundle. A bundle that does not load within `loadTimeoutMs` is killed and reported.
 */
export const spawnPlugin = (opts: {
  readonly name: string
  readonly bundle: string
  readonly powers: Powers
  readonly deadlineMs?: number
  readonly loadTimeoutMs?: number
  /** True while the plugin waits on the operator (a grant question): its call's deadline stops. */
  readonly paused?: () => boolean
  readonly onExit?: (reason: "crash" | "deadline" | "stop") => void
}): Effect.Effect<PluginProcess, PluginLoadError, Scope.Scope> =>
  Effect.gen(function* () {
    let child: ReturnType<typeof Bun.spawn> | undefined
    let ready: Promise<void> | undefined
    let identity: Identity = {}
    let nextId = 0
    const waiters = new Map<number, Waiter>()
    // Each process has a generation: an old process's exit must not touch the state of its successor.
    let generation = 0
    // Nothing to read here, and no bunfig.toml whose preload would run before lockdown().
    const cwd = mkdtempSync(join(tmpdir(), "zarg-plugin-cwd-"))

    const failAll = (tag: "PluginCrashed" | "Deadline", message: string) => {
      for (const [, w] of waiters) w.done({ ok: false, error: { tag, message } })
      waiters.clear()
    }

    /** A send to a process that just died is a crash of that call, never an error in the core. */
    const sendTo = (proc: ReturnType<typeof Bun.spawn> | undefined, m: ToPlugin) => {
      try {
        if (proc === undefined || proc.killed) return false
        proc.send(m)
        return true
      } catch {
        return false
      }
    }

    const start = () =>
      new Promise<void>((resolve, reject) => {
        const gen = ++generation
        const loadTimer = setTimeout(() => {
          reject(new PluginLoadError({ name: opts.name, message: `${opts.name} did not load within ${opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS} ms` }))
          if (gen === generation) {
            generation++
            child = undefined
            ready = undefined
          }
          proc.kill()
        }, opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
        const proc = Bun.spawn([process.execPath, RUNNER], {
          env: {},
          cwd,
          stdio: ["ignore", "ignore", "ignore"],
          ipc: (m: FromPlugin) => {
            if (m.type === "ready") sendTo(proc, { type: "load", bundle: opts.bundle })
            else if (m.type === "loaded") {
              clearTimeout(loadTimer)
              identity = m.identity ?? {}
              resolve()
            } else if (m.type === "load-failed") {
              clearTimeout(loadTimer)
              reject(new PluginLoadError({ name: opts.name, message: m.message }))
            } else if (m.type === "power") {
              const reply = (r: ToPlugin) => void sendTo(proc, r)
              if (!isPower(opts.powers, String(m.power))) {
                reply({ type: "power-reply", id: m.id, ok: false, error: { tag: "NotGranted", message: `"${String(m.power).slice(0, 60)}" is not a power ${opts.name} was given` } })
                return
              }
              opts.powers[m.power]!(m.args).then(
                (value) => reply({ type: "power-reply", id: m.id, ok: true, value }),
                (e) => reply({ type: "power-reply", id: m.id, ok: false, error: { tag: e?.tag === "NotGranted" || e?.tag === "BudgetExceeded" ? e.tag : "PluginError", message: String(e?.message ?? e) } }),
              )
            } else if (m.type === "chunk") waiters.get(m.id)?.onChunk?.(m.value)
            else if (m.type === "end") {
              waiters.get(m.id)?.done({ ok: true, value: undefined })
              waiters.delete(m.id)
            } else if (m.type === "reply") {
              const w = waiters.get(m.id)
              waiters.delete(m.id)
              w?.done(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error })
            }
          },
          onExit: () => {
            clearTimeout(loadTimer)
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
    yield* Effect.addFinalizer(() => Effect.andThen(kill("stop"), Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))))

    const toError = (e: Failure | { tag: "PluginCrashed" | "Deadline"; message: string }) => new PluginCallError({ _tag: e.tag, message: e.message })
    const crashed = (message: string) => new PluginCallError({ _tag: "PluginCrashed", message })

    /** Fails once `deadlineMs` of the plugin's own time has passed; time spent waiting on the operator does not count. */
    const deadline = (method: string, deadlineMs: number) =>
      Effect.gen(function* () {
        let used = 0
        while (used < deadlineMs) {
          yield* Effect.sleep(TICK_MS)
          if (opts.paused?.() !== true) used += TICK_MS
        }
        yield* kill("deadline")
        return yield* Effect.fail(new PluginCallError({ _tag: "Deadline", message: `${opts.name}.${method}: no answer within ${deadlineMs} ms` }))
      })

    const call = (method: string, params: unknown, deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS) =>
      Effect.raceFirst(
        Effect.gen(function* () {
          yield* ensure.pipe(Effect.mapError((e) => crashed(e.message)))
          const id = ++nextId
          const done = yield* Deferred.make<unknown, PluginCallError>()
          waiters.set(id, { done: (r) => Deferred.doneUnsafe(done, r.ok ? Effect.succeed(r.value) : Effect.fail(toError(r.error))) })
          if (!sendTo(child, { type: "call", id, method, params })) {
            waiters.delete(id)
            return yield* Effect.fail(crashed(`${opts.name}: plugin process is gone`))
          }
          return yield* Deferred.await(done)
        }),
        deadline(method, deadlineMs),
      )

    const stream = (method: string, params: unknown) =>
      Stream.callback<unknown, PluginCallError>((queue) =>
        Effect.gen(function* () {
          yield* ensure.pipe(Effect.mapError((e) => crashed(e.message)))
          const id = ++nextId
          waiters.set(id, {
            onChunk: (v) => Queue.offerUnsafe(queue, v),
            done: (r) => (r.ok ? Queue.endUnsafe(queue) : Queue.failCauseUnsafe(queue, toError(r.error) as never)),
          })
          if (!sendTo(child, { type: "call", id, method, params })) {
            waiters.delete(id)
            return yield* Effect.fail(crashed(`${opts.name}: plugin process is gone`))
          }
          yield* Effect.addFinalizer(() => Effect.sync(() => { if (waiters.delete(id)) sendTo(child, { type: "cancel", id }) }))
        }),
      )

    return { call, stream, stop: kill("stop"), get identity() { return identity } } satisfies PluginProcess
  })
