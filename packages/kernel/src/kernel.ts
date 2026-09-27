import { Deferred, Effect, Exit, FiberSet, Schema, Semaphore } from "effect"
import { makeChecker } from "./check"
import { manifest } from "./manifest"
import type { FromWorker, ToWorker } from "./protocol"
import type { Bound, ServiceFailure } from "./service"
import type { ClockMode, TickSource, TickValue } from "./ticks"
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
  /**
   * A cell that runs longer than this in the worker is stopped and the worker replaced.
   * Time spent yielded on service calls does not count.
   */
  readonly timeoutMs?: number
  /** Output larger than this is cut, keeping head and tail. */
  readonly outputCap?: number
  /** The worker's whole environment. Defaults to empty; pass only what cells may see (never secrets). */
  readonly env?: Readonly<Record<string, string>>
  /** Cells' time and randomness: read and reported live (default), or served from a recording. */
  readonly clock?: ClockMode
  /** Told of every tick (and, in replay, every read past the recording) as it happens. */
  readonly record?: (r: Recorded) => void
}

/** One read of time or randomness by a cell. */
export interface Tick {
  readonly cell: number
  readonly source: TickSource
  readonly value: TickValue
}

/** One service call a cell made: params as the cell sent them, and the result or failure as it came back. */
export interface RecordedCall {
  readonly cell: number
  readonly service: string
  readonly method: string
  readonly params: unknown
  readonly ok: boolean
  readonly result?: unknown
  readonly failure?: ServiceFailure
  readonly ms: number
}

/** What a kernel records while cells run. */
export type Recorded =
  | ({ readonly kind: "tick" } & Tick)
  | ({ readonly kind: "call" } & RecordedCall)
  | { readonly kind: "extra"; readonly cell: number; readonly source: TickSource }

/** Collects output with a hard cap as it arrives: keeps the head and the tail, counts the rest. */
const collector = (cap: number) => {
  const half = Math.floor(cap / 2)
  let head = ""
  let tail = ""
  let cut = 0
  const addTail = (t: string) => {
    tail += t
    if (tail.length > half) {
      cut += tail.length - half
      tail = tail.slice(-half)
    }
  }
  return {
    push: (line: string) => {
      const l = `${line}\n`
      if (head.length < half) {
        const room = half - head.length
        head += l.slice(0, room)
        if (l.length > room) addTail(l.slice(room))
      } else addTail(l)
    },
    text: () => (cut > 0 ? `${head}… [${cut} characters cut] …\n${tail}` : head + tail).replace(/\n$/, ""),
  }
}

const toFailure = (e: unknown): ServiceFailure =>
  typeof e === "object" && e !== null && "_tag" in e
    ? { _tag: String((e as { _tag: unknown })._tag), message: String((e as { message?: unknown }).message ?? "") }
    : { _tag: "Error", message: e instanceof Error ? e.message : String(e) }

type Outcome = { readonly ok: boolean; readonly text: string | undefined; readonly crashed: boolean }

/**
 * One kernel: a Bun Worker that runs cells as Effect generator bodies.
 * Service calls cross back to the host, are decoded from JSON with the method's params Schema,
 * run with the bound handler, and the result is encoded to JSON with its success Schema.
 * The kernel folds context; it is not a security sandbox (see the spec's Kernel section).
 */
export const make = (opts: KernelOptions) =>
  Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const outputCap = opts.outputCap ?? 32_768
    const env = { ...opts.env }
    const text = manifest(opts.services.map((s) => s.def))
    const checker = makeChecker(text)
    const byName = new Map(opts.services.map((s) => [s.def.name, s]))
    const calls = yield* FiberSet.make()
    const runCall = yield* FiberSet.runtime(calls)<never>()
    const lock = yield* Semaphore.make(1)

    let worker: Worker | undefined
    let onMessage: (m: FromWorker) => void = () => {}
    let onCrash: (reason: string) => void = () => {}
    let dead = false

    const send = (m: ToWorker) => worker?.postMessage(m)

    const spawn = Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const w = new Worker(new URL("./worker.ts", import.meta.url), { env } as WorkerOptions)
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === "ready") Deferred.doneUnsafe(ready, Exit.void)
        else onMessage(e.data)
      }
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault()
        if (w === worker) onCrash(e.message || "uncaught error in the worker")
      }
      w.addEventListener("close", () => {
        if (w === worker) onCrash("the worker exited")
      })
      const services = Object.fromEntries(opts.services.map((s) => [s.def.name, Object.keys(s.def.methods)]))
      worker = w
      w.postMessage({ type: "init", services, clock: opts.clock ?? { mode: "record" } } satisfies ToWorker)
      yield* Deferred.await(ready).pipe(
        Effect.timeoutOrElse({ duration: 10_000, orElse: () => Effect.die(new Error("kernel worker did not start within 10s")) }),
      )
      dead = false
    })

    /** Replace the worker: host calls stop, globals are gone. */
    const restart = Effect.gen(function* () {
      const old = worker
      worker = undefined
      old?.terminate()
      yield* FiberSet.clear(calls)
      checker.reset()
      yield* spawn
    })

    yield* spawn
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const w = worker
        worker = undefined
        w?.terminate()
      }),
    )

    // Serve one service call from the worker; typed failures travel back as { _tag, message }.
    const serve = (m: Extract<FromWorker, { type: "call" }>) => {
      const svc = byName.get(m.service)
      const def = svc?.def.methods[m.method]
      const handler = svc?.handlers[m.method]
      const started = Date.now()
      // The reply as it goes back to the cell is also what is recorded (the wire form, both ways).
      const reply = (r: Exit.Exit<unknown, ServiceFailure>) => {
        const answer: ToWorker = Exit.isSuccess(r)
          ? { type: "reply", callId: m.callId, ok: true, value: r.value }
          : { type: "reply", callId: m.callId, ok: false, error: toFailure(r.cause.reasons.find((x) => x._tag === "Fail")?.error ?? r.cause) }
        opts.record?.({
          kind: "call",
          cell: m.runId,
          service: m.service,
          method: m.method,
          params: m.params,
          ok: answer.ok,
          ...(answer.ok ? { result: answer.value } : { failure: answer.error }),
          ms: Date.now() - started,
        })
        send(answer)
      }
      if (def === undefined || handler === undefined) {
        reply(Exit.fail({ _tag: "UnknownService", message: `${m.service}.${m.method} is not in this kernel's layer` }))
        return Effect.void
      }
      // Only JSON crosses the boundary: decode from and encode to each schema's JSON form.
      return Schema.decodeUnknownEffect(Schema.toCodecJson(def.params))(m.params).pipe(
        Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidParams", message: `${m.service}.${m.method}: ${e.message}` })),
        Effect.flatMap(handler),
        Effect.flatMap((value) =>
          Schema.encodeEffect(Schema.toCodecJson(def.success))(value).pipe(
            Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `${m.service}.${m.method}: ${e.message}` })),
          ),
        ),
        Effect.exit,
        Effect.flatMap((r) => Effect.sync(() => reply(r))),
      )
    }

    /** Between cells: calls from leftover timers are refused, logs dropped, a crash noted for the next run. */
    const idle = () => {
      onMessage = (m) => {
        if (m.type === "call") {
          send({
            type: "reply",
            callId: m.callId,
            ok: false,
            error: { _tag: "CellFinished", message: "this cell already finished; calls from timers or background work are refused" },
          })
        }
      }
      onCrash = () => {
        dead = true
      }
    }
    idle()

    let nextRun = 0
    const runOnce = (cell: string): Effect.Effect<CellResult> =>
      Effect.gen(function* () {
        let restarted = false
        if (dead) {
          yield* restart
          restarted = true
        }
        const checked = checker.check(cell)
        if (!checked.ok) {
          const out = collector(outputCap)
          out.push(`typecheck failed, the cell did not run:\n${checked.errors.join("\n")}`)
          return { ok: false, output: out.text(), restarted }
        }
        const { body, names } = toBody(cell)
        const id = ++nextRun
        const out = collector(outputCap)
        const done = yield* Deferred.make<Outcome>()

        // The deadline counts only time the cell runs in the worker. While a service call is in
        // flight the cell is yielded to the host (a model turn, a child RLM, a question to the
        // developer), and the clock pauses.
        let inFlight = 0
        let used = 0
        let last = Date.now()
        const tick = () => {
          const now = Date.now()
          if (inFlight === 0) used += now - last
          last = now
        }
        onMessage = (m) => {
          if (m.type === "log" && m.runId === id) out.push(m.line)
          else if (m.type === "tick" && m.runId === id) opts.record?.({ kind: "tick", cell: id, source: m.source, value: m.value })
          else if (m.type === "extra" && m.runId === id) opts.record?.({ kind: "extra", cell: id, source: m.source })
          else if (m.type === "call" && m.runId === id) {
            tick()
            inFlight++
            runCall(
              serve(m).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    tick()
                    inFlight--
                  }),
                ),
              ),
            )
          } else if (m.type === "done" && m.id === id) {
            Deferred.doneUnsafe(done, Exit.succeed(m.ok ? { ok: true, text: m.value, crashed: false } : { ok: false, text: m.error, crashed: false }))
          }
        }
        onCrash = (reason) => Deferred.doneUnsafe(done, Exit.succeed({ ok: false, text: `kernel crashed: ${reason}`, crashed: true }))
        send({ type: "run", id, body })

        const watchdog = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Math.min(50, timeoutMs))
            tick()
            if (used >= timeoutMs) return undefined
          }
        })
        const outcome = yield* Effect.race(Deferred.await(done), watchdog).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              send({ type: "interrupt", id })
              yield* FiberSet.clear(calls)
              // A CPU-bound cell cannot see the interrupt: give it a moment, then replace the worker.
              const settled = yield* Deferred.await(done).pipe(
                Effect.timeoutOrElse({ duration: 500, orElse: () => Effect.succeed(undefined) }),
              )
              idle()
              if (settled === undefined) yield* restart
            }),
          ),
        )
        idle()
        if (outcome === undefined || outcome.crashed) {
          yield* restart
          out.push(
            outcome === undefined
              ? `cell timed out after ${timeoutMs}ms; the kernel was restarted and earlier globals are gone`
              : `${outcome.text}; the kernel was restarted and earlier globals are gone`,
          )
          return { ok: false, output: out.text(), restarted: true }
        }
        checker.declare(names)
        if (outcome.text !== undefined) out.push(outcome.ok ? outcome.text : `error: ${outcome.text}`)
        return { ok: outcome.ok, output: out.text(), restarted }
      })

    /** Cells run one at a time: a kernel has one set of globals and one worker. */
    const run = (cell: string) => Semaphore.withPermits(lock, 1)(runOnce(cell))

    return { run, manifest: text }
  })

export type Kernel = Effect.Success<ReturnType<typeof make>>
