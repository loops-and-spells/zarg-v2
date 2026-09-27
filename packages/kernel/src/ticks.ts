import { Clock, Effect } from "effect"

export type TickSource = "date" | "perf" | "random" | "bytes" | "uuid" | "clock"
export type TickValue = number | string | ReadonlyArray<number>
export type ClockMode =
  | { readonly mode: "record" }
  | { readonly mode: "replay"; readonly ticks: ReadonlyArray<{ readonly source: TickSource; readonly value: TickValue }> }

/** Reads reported per cell at most; more are served but not recorded (a loop must not flood the transcript). */
export const TICK_CAP = 10_000

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// The worker's own clock, captured before any cell runs: record mode sleeps on it.
const realClock = Effect.runSync(Clock.clockWith((c) => Effect.succeed(c)))

/**
 * What one cell sees as Date, Math, performance, crypto and the Effect Clock. Record mode reads the real
 * values and reports each; replay mode serves recorded values in order per source, then continues
 * deterministically (reported as extra). Only cell code sees these: Effect's own internals keep the real ones.
 */
export const makeCellEnv = (clock: ClockMode, report: (source: TickSource, value: TickValue) => void, extra: (source: TickSource) => void) => {
  const RealDate = globalThis.Date
  let count = 0
  const queues = new Map<TickSource, Array<TickValue>>()
  const last = new Map<TickSource, { value: number; step: number }>()
  if (clock.mode === "replay") {
    for (const t of clock.ticks) {
      const q = queues.get(t.source) ?? []
      q.push(t.value)
      queues.set(t.source, q)
    }
  }
  const rng = mulberry32(1)
  const remember = (source: TickSource, v: TickValue) => {
    if (typeof v !== "number") return
    const prev = last.get(source)
    last.set(source, { value: v, step: prev === undefined ? 1 : Math.max(1, v - prev.value) })
  }
  const next = (source: TickSource, live: () => TickValue): TickValue => {
    if (clock.mode === "record") {
      const v = live()
      if (count++ < TICK_CAP) report(source, v)
      return v
    }
    const q = queues.get(source)
    if (q !== undefined && q.length > 0) {
      const v = q.shift()!
      remember(source, v)
      return v
    }
    extra(source)
    if (source === "date" || source === "perf" || source === "clock") {
      const prev = last.get(source) ?? { value: 0, step: 1 }
      const v = prev.value + prev.step
      last.set(source, { value: v, step: prev.step })
      return v
    }
    if (source === "random") return rng()
    if (source === "uuid") return `00000000-0000-4000-8000-${Math.floor(rng() * 2 ** 48).toString(16).padStart(12, "0")}`
    return []
  }
  const now = () => next("date", () => RealDate.now()) as number
  class CellDate extends RealDate {
    constructor(...args: Array<unknown>) {
      if (args.length === 0) super(now())
      else super(...(args as [number]))
    }
    static override now() {
      return now()
    }
  }
  const CellMath = Object.create(Math, { random: { value: () => next("random", () => Math.random()) as number } }) as Math
  const performance = { now: () => next("perf", () => globalThis.performance.now()) as number }
  const crypto = {
    randomUUID: () => next("uuid", () => globalThis.crypto.randomUUID()) as string,
    getRandomValues: <T extends Uint8Array>(a: T): T => {
      const v = next("bytes", () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(a.length))))
      const bytes = Array.isArray(v) && v.length === a.length ? (v as Array<number>) : Array.from({ length: a.length }, () => Math.floor(rng() * 256))
      a.set(bytes)
      return a
    },
  }
  const millis = () => next("clock", () => RealDate.now()) as number
  const nanos = () => BigInt(Math.round((next("perf", () => globalThis.performance.now()) as number) * 1_000_000))
  const cellClock: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    // Replay: a sleep takes no time. Record: the worker's real clock sleeps.
    sleep: clock.mode === "replay" ? () => Effect.void : (d) => realClock.sleep(d),
  }
  return { Date: CellDate as unknown as DateConstructor, Math: CellMath, performance, crypto, clock: cellClock }
}
