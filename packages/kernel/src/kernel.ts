import { Deferred, Effect, Exit, FiberSet, Schema } from "effect"
import { makeChecker } from "./check"
import { manifest } from "./manifest"
import type { FromWorker, ToWorker } from "./protocol"
import type { Bound, ServiceFailure } from "./service"
import { toBody } from "./transform"

export interface CellResult {
  /** False when the cell failed to typecheck, threw, failed, or timed out. */
  readonly ok: boolean
  /** Console lines, then the returned value (or the error), capped. */
  readonly output: string
  /** True when the worker was replaced during this cell; earlier globals are gone. */
  readonly restarted: boolean
}

export interface KernelOptions {
  readonly services: ReadonlyArray<Bound>
  /** A cell that runs longer is stopped and the worker replaced. */
  readonly timeoutMs?: number
  /** Output larger than this is cut, keeping head and tail. */
  readonly outputCap?: number
}

const cap = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n… [${text.length - max} characters cut] …\n${text.slice(-max / 2)}`

const toFailure = (e: unknown): ServiceFailure =>
  typeof e === "object" && e !== null && "_tag" in e
    ? { _tag: String((e as { _tag: unknown })._tag), message: String((e as { message?: unknown }).message ?? "") }
    : { _tag: "Error", message: e instanceof Error ? e.message : String(e) }

/**
 * One kernel: a Bun Worker that runs cells as Effect generator bodies.
 * Service calls cross back to the host, are decoded with the method's params Schema,
 * run with the bound handler, and the result is encoded with its success Schema.
 */
export const make = (opts: KernelOptions) =>
  Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const outputCap = opts.outputCap ?? 32_768
    const text = manifest(opts.services.map((s) => s.def))
    const checker = makeChecker(text)
    const byName = new Map(opts.services.map((s) => [s.def.name, s]))
    const calls = yield* FiberSet.make()
    const runCall = yield* FiberSet.runtime(calls)<never>()

    let worker: Worker | undefined
    let onMessage: (m: FromWorker) => void = () => {}

    const spawn = Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const w = new Worker(new URL("./worker.ts", import.meta.url))
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === "ready") Deferred.doneUnsafe(ready, Exit.void)
        else onMessage(e.data)
      }
      const services = Object.fromEntries(opts.services.map((s) => [s.def.name, Object.keys(s.def.methods)]))
      w.postMessage({ type: "init", services } satisfies ToWorker)
      yield* Deferred.await(ready)
      worker = w
    })
    yield* spawn
    yield* Effect.addFinalizer(() => Effect.sync(() => worker?.terminate()))

    const send = (m: ToWorker) => worker?.postMessage(m)

    // Serve one service call from the worker; typed failures travel back as { _tag, message }.
    const serve = (m: Extract<FromWorker, { type: "call" }>) => {
      const svc = byName.get(m.service)
      const def = svc?.def.methods[m.method]
      const handler = svc?.handlers[m.method]
      const reply = (r: Exit.Exit<unknown, ServiceFailure>) =>
        send(
          Exit.isSuccess(r)
            ? { type: "reply", callId: m.callId, ok: true, value: r.value }
            : { type: "reply", callId: m.callId, ok: false, error: toFailure(r.cause.reasons.find((x) => x._tag === "Fail")?.error ?? r.cause) },
        )
      if (def === undefined || handler === undefined) {
        reply(Exit.fail({ _tag: "UnknownService", message: `${m.service}.${m.method} is not in this kernel's layer` }))
        return Effect.void
      }
      return Schema.decodeUnknownEffect(def.params)(m.params).pipe(
        Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidParams", message: `${m.service}.${m.method}: ${e.message}` })),
        Effect.flatMap(handler),
        Effect.flatMap((value) =>
          Schema.encodeEffect(def.success)(value).pipe(
            Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `${m.service}.${m.method}: ${e.message}` })),
          ),
        ),
        Effect.exit,
        Effect.flatMap((r) => Effect.sync(() => reply(r))),
      )
    }

    let nextRun = 0
    const run = (cell: string): Effect.Effect<CellResult> =>
      Effect.gen(function* () {
        const checked = checker.check(cell)
        if (!checked.ok) {
          return { ok: false, output: cap(`typecheck failed, the cell did not run:\n${checked.errors.join("\n")}`, outputCap), restarted: false }
        }
        const { body, names } = toBody(cell)
        const id = ++nextRun
        const lines: Array<string> = []
        const done = yield* Deferred.make<{ ok: boolean; text: string | undefined }>()
        onMessage = (m) => {
          if (m.type === "log" && m.runId === id) lines.push(m.line)
          else if (m.type === "call" && m.runId === id) runCall(serve(m))
          else if (m.type === "done" && m.id === id) {
            Deferred.doneUnsafe(done, Exit.succeed(m.ok ? { ok: true, text: m.value } : { ok: false, text: m.error }))
          }
        }
        send({ type: "run", id, body })
        const outcome = yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(undefined) }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              send({ type: "interrupt", id })
              yield* FiberSet.clear(calls)
            }),
          ),
        )
        if (outcome === undefined) {
          // Timed out: stop host work, replace the worker. Globals are lost.
          yield* FiberSet.clear(calls)
          worker?.terminate()
          yield* spawn
          checker.reset()
          const out = [...lines, `cell timed out after ${timeoutMs}ms; the kernel was restarted and earlier globals are gone`]
          return { ok: false, output: cap(out.join("\n"), outputCap), restarted: true }
        }
        checker.declare(names)
        const out = [...lines, ...(outcome.text === undefined ? [] : [outcome.ok ? outcome.text : `error: ${outcome.text}`])]
        return { ok: outcome.ok, output: cap(out.join("\n"), outputCap), restarted: false }
      })

    return { run, manifest: text }
  })

export type Kernel = Effect.Success<ReturnType<typeof make>>
