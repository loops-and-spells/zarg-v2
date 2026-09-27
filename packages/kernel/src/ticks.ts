import { Clock, Effect, Random } from "effect"

export type TickSource = "clock" | "monotonic" | "random"
export type TickValue = number
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

export interface CellEnvReport {
  readonly tick: (source: TickSource, value: TickValue) => void
  /** Replay read past the recording. */
  readonly extra: (source: TickSource) => void
  /** Reads went past TICK_CAP; sent once per cell. */
  readonly truncated: (source: TickSource) => void
}

/**
 * The Clock and Random one cell's fiber runs with: cells read time and randomness only through these.
 * Record mode reads the real values and reports each; replay mode serves recorded values in order per
 * source, then continues deterministically (reported as extra).
 */
export const makeCellEnv = (clock: ClockMode, report: CellEnvReport) => {
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
  const next = (source: TickSource, live: () => number): number => {
    if (clock.mode === "record") {
      const v = live()
      if (count < TICK_CAP) report.tick(source, v)
      else if (count === TICK_CAP) report.truncated(source)
      count++
      return v
    }
    const q = queues.get(source)
    if (q !== undefined && q.length > 0) {
      const v = q.shift()!
      const prev = last.get(source)
      last.set(source, { value: v, step: prev === undefined ? 1 : Math.max(1, v - prev.value) })
      return v
    }
    report.extra(source)
    if (source === "random") return rng()
    const prev = last.get(source) ?? { value: 0, step: 1 }
    const v = prev.value + prev.step
    last.set(source, { value: v, step: prev.step })
    return v
  }
  const millis = () => next("clock", () => realClock.currentTimeMillisUnsafe())
  const nanos = () => BigInt(Math.round(next("monotonic", () => Number(realClock.monotonicTimeNanosUnsafe()))))
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
  const double = () => next("random", () => Math.random())
  const cellRandom: Random.Random = {
    nextDoubleUnsafe: double,
    nextIntUnsafe: () => Math.floor(double() * Number.MAX_SAFE_INTEGER),
  }
  return { clock: cellClock, random: cellRandom }
}

const refuse = (what: string, use: string) => () => {
  throw new Error(`${what} reads the real ${use.startsWith("Clock") ? "clock" : "random source"}; use \`yield* ${use}\``)
}

/**
 * Date and Math as cells see them: pure use works (`new Date(ms)`, `Date.parse`, `instanceof Date`), reads of
 * real time and randomness throw. The typecheck refuses them first; this catches casts around it.
 */
export const cellDate: DateConstructor = new Proxy(Date, {
  construct: (target, args, newTarget) => (args.length === 0 ? refuse("new Date()", "Clock.currentTimeMillis")() : Reflect.construct(target, args, newTarget)),
  apply: refuse("Date()", "Clock.currentTimeMillis"),
  get: (target, key, receiver) => (key === "now" ? refuse("Date.now()", "Clock.currentTimeMillis") : Reflect.get(target, key, receiver)),
})
export const cellMath: Math = Object.create(Math, { random: { value: refuse("Math.random()", "Random.next") } })
