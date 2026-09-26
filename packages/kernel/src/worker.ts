/// <reference lib="webworker" />
// Runs inside a Bun Worker. Cells are generator bodies run with Effect.gen; services are RPC stubs to the host.
import { Cause, Effect, Exit, Fiber } from "effect"
import type { FromWorker, ToWorker } from "./protocol"

declare const self: Worker
const post = (m: FromWorker) => self.postMessage(m)

let serviceNames: ReadonlyArray<string> = []
let services: ReadonlyArray<Record<string, (params: unknown) => Effect.Effect<unknown, unknown>>> = []
const pending = new Map<number, (exit: Exit.Exit<unknown, unknown>) => void>()
const running = new Map<number, Fiber.Fiber<unknown, unknown>>()
let nextCall = 0
let currentRun = 0

// Captured at load: a cell that shadows JSON (and persists it to globalThis) must not break formatting.
const stringify = JSON.stringify.bind(JSON)
const format = (v: unknown): string | undefined =>
  v === undefined ? undefined : typeof v === "string" ? v : stringify(v, null, 2)

/** A failure the cell can catch by tag: `Effect.catchTag("StaleNode", ...)`. */
const failure = (e: { _tag: string; message: string }) => Object.assign(new Error(e.message), e)

const stub = (service: string, method: string) => (params: unknown) =>
  Effect.callback<unknown, unknown>((resume) => {
    const callId = ++nextCall
    pending.set(callId, (exit) => resume(exit))
    post({ type: "call", runId: currentRun, callId, service, method, params })
  })

const log = (runId: number) => (...values: Array<unknown>) =>
  post({
    type: "log",
    runId,
    line: values
      .map((v) => {
        if (typeof v === "string") return v
        try {
          return stringify(v)
        } catch {
          return String(v)
        }
      })
      .join(" "),
  })

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data
  if (m.type === "init") {
    serviceNames = Object.keys(m.services)
    services = serviceNames.map((name) =>
      Object.fromEntries(m.services[name]!.map((method) => [method, stub(name, method)])),
    )
    post({ type: "ready" })
    return
  }
  if (m.type === "reply") {
    const resume = pending.get(m.callId)
    pending.delete(m.callId)
    resume?.(m.ok ? Exit.succeed(m.value) : Exit.fail(failure(m.error)))
    return
  }
  if (m.type === "interrupt") {
    const fiber = running.get(m.id)
    if (fiber) Effect.runFork(Fiber.interrupt(fiber))
    return
  }
  // run
  currentRun = m.id
  let gen: () => Generator<Effect.Effect<any, any, never>, unknown, any>
  try {
    gen = new Function("console", "Effect", ...serviceNames, `return function* () {\n${m.body}\n}`)(
      { log: log(m.id), error: log(m.id) },
      Effect,
      ...services,
    )
  } catch (e) {
    post({ type: "done", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    return
  }
  // Hold the iterator: when a yielded call fails, Effect.gen abandons the generator without
  // running its finally, so return() is called here to persist the names declared so far.
  const it = gen()
  const fiber = Effect.runFork(Effect.gen(() => it))
  running.set(m.id, fiber)
  fiber.addObserver((exit) => {
    running.delete(m.id)
    try {
      it.return(undefined)
    } catch {
      // A throw from the cell's own finally is not the cell's result.
    }
    try {
      if (Exit.isSuccess(exit)) {
        let text: string | undefined
        try {
          text = format(exit.value)
        } catch (e) {
          post({ type: "done", id: m.id, ok: false, error: `could not format the return value: ${e instanceof Error ? e.message : String(e)}` })
          return
        }
        post({ type: "done", id: m.id, ok: true, value: text })
      } else {
        const err = Cause.squash(exit.cause)
        const text = Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : err instanceof Error
            ? `${(err as { _tag?: string })._tag ?? err.name}: ${err.message}`
            : String(err)
        post({ type: "done", id: m.id, ok: false, error: text })
      }
    } catch (e) {
      post({ type: "done", id: m.id, ok: false, error: `could not report the result: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}
