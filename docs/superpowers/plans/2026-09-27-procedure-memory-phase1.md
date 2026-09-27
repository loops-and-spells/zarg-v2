# Procedure Memory Phase 1: Record and Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent run records its service calls and its reads of time and randomness, and any cell code can be replayed against such a recording without models, network or real time.

**Architecture:** The kernel gains a `record` hook and a `clock` mode. Cells get their own `Date`, `Math`, `performance`, `crypto` and an Effect `Clock` as bound names, so only cell code (never Effect's internals) is recorded: in record mode those read the real values and report them; in replay mode they serve recorded values and sleeps take no time. The host reports every served service call. `replay()` builds a kernel whose services answer from a recording and reports divergences. The RLM forwards records as events; the core writes them to the transcript, redacted.

**Tech Stack:** Bun 1.4.2 (mise), Effect 4.0.0-rc.117 (`Clock.Clock` provided per fiber), the existing kernel Worker.

**Spec:** `docs/superpowers/specs/2026-09-27-procedure-memory-design.md` (Phase 1)

## Global Constraints

- Run tools through mise (`mise x -- bun …`); `mise run verify` must pass before every commit.
- Records are redacted like every transcript line (the core's `log.transcript`), and never reach the wire.
- Recording covers cell code only: the bound `Date`, `Math`, `performance`, `crypto` and Effect `Clock` of a cell; a cell reaching `globalThis.Date` bypasses it (documented, not blocked: the kernel is for folding, not sandboxing).
- Tick sources, exactly: `date` (`Date.now()` and `new Date()` with no arguments), `perf` (`performance.now()`), `random` (`Math.random()`), `bytes` (`crypto.getRandomValues`), `uuid` (`crypto.randomUUID()`), `clock` (Effect `Clock` reads).
- Replay beyond the recording: time continues from the last recorded value of that source by the mean recorded step (1 ms when there is only one value); `random`, `bytes`, `uuid` come from a mulberry32 generator seeded with 1. Such reads are reported as `extraTicks`, never as divergences.
- Replay matches a service call to the first unused recorded call with the same service, method and canonical-JSON params (concurrent calls may arrive in another order); no match is a divergence.

## Review Focus

1. A cell that calls services concurrently (`Effect.all([...], { concurrency: 4 })`): replay must match them regardless of arrival order. → Task 3, test "concurrent calls replay in any order".
2. A recorded call whose result was a failure: replay must fail the call the same way (same `_tag`), and the cell's output must match. → Task 3, test "a recorded failure replays as the same failure".
3. A cell that loops reading `Date.now()` thousands of times: records must not flood the transcript. → Task 1, test "reads are counted per cell and capped at 10 000 ticks, then summarised".
4. A secret in a service call's params or result: the transcript line must be redacted. → Task 4, test "a secret in a recorded call is redacted in the transcript".
5. A cell that sleeps longer than the kernel's timeout in replay: replay must not wait nor time out. → Task 1, test "a sleep replays instantly".

---

### Task 1: Cell clocks: record and replay time and randomness

**Files:**
- Create: `packages/kernel/src/ticks.ts`
- Modify: `packages/kernel/src/protocol.ts`, `packages/kernel/src/worker.ts`, `packages/kernel/src/kernel.ts`, `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/ticks.test.ts`

**Interfaces:**
- Produces:
  - `type TickSource = "date" | "perf" | "random" | "bytes" | "uuid" | "clock"`
  - `interface Tick { readonly cell: number; readonly source: TickSource; readonly value: number | string | ReadonlyArray<number> }`
  - `type ClockMode = { readonly mode: "record" } | { readonly mode: "replay"; readonly ticks: ReadonlyArray<Omit<Tick, "cell">> }`
  - `KernelOptions.clock?: ClockMode` (default `{ mode: "record" }`)
  - `KernelOptions.record?: (r: Recorded) => void` with `type Recorded = ({ readonly kind: "tick" } & Tick) | ({ readonly kind: "call" } & RecordedCall) | { readonly kind: "extra"; readonly cell: number; readonly source: TickSource }` (`RecordedCall` defined in Task 2; declare the union now with the tick and extra members, add `call` in Task 2).
  - `makeCellEnv(clock, report)` in `ticks.ts` (worker side): returns `{ Date, Math, performance, crypto, clock: Clock.Clock }`.
- Consumed by: Task 3 (replay passes `clock: { mode: "replay", ticks }`), Task 4 (RLM passes `record`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/kernel/test/ticks.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded } from "../src"

const run = (cell: string, clock?: Parameters<typeof Kernel.make>[0]["clock"]) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const records: Array<Recorded> = []
    const k = yield* Kernel.make({ services: [], ...(clock ? { clock } : {}), record: (r) => records.push(r) })
    const out = yield* k.run(cell)
    return { out, records }
  })))

const cell = `const a = Date.now()
const b = Math.random()
const c = crypto.randomUUID()
const d = performance.now()
const e = new Date().getTime()
return [a, b, c, d, e].join(",")`

describe("cell clocks", () => {
  test("a cell's reads of time and randomness are recorded in order", async () => {
    const r = await run(cell)
    expect(r.out.ok).toBe(true)
    const ticks = r.records.filter((x) => x.kind === "tick")
    expect(ticks.map((t) => (t as { source: string }).source)).toEqual(["date", "random", "uuid", "perf", "date"])
    expect(r.out.output).toBe(ticks.map((t) => (t as { value: unknown }).value).join(","))
  })

  test("replay serves the recorded values and returns the recorded output", async () => {
    const live = await run(cell)
    const ticks = live.records.filter((x) => x.kind === "tick").map(({ source, value }: any) => ({ source, value }))
    const again = await run(cell, { mode: "replay", ticks })
    expect(again.out.output).toBe(live.out.output)
  })

  test("reads past the recording continue deterministically and are reported", async () => {
    const two = `return [Date.now(), Date.now(), Math.random()].join(",")`
    const ticks = [{ source: "date" as const, value: 1000 }]
    const a = await run(two, { mode: "replay", ticks })
    const b = await run(two, { mode: "replay", ticks })
    expect(a.out.output).toBe(b.out.output)
    expect(a.out.output.startsWith("1000,1001,")).toBe(true)
    expect(a.records.filter((x) => x.kind === "extra").map((x: any) => x.source)).toEqual(["date", "random"])
  })

  test("a sleep replays instantly", async () => {
    const sleepy = `yield* Effect.sleep("30 seconds")\nreturn "woke"`
    const t = Date.now()
    const r = await run(sleepy, { mode: "replay", ticks: [] })
    expect(r.out.output).toBe("woke")
    expect(Date.now() - t).toBeLessThan(2000)
  })

  test("reads are counted per cell and capped at 10 000 ticks, then summarised", async () => {
    const r = await run(`let x = 0\nfor (let i = 0; i < 20000; i++) x += Date.now() > 0 ? 1 : 0\nreturn x`)
    expect(r.out.output).toBe("20000")
    const ticks = r.records.filter((x) => x.kind === "tick")
    expect(ticks.length).toBe(10_000)
    expect(r.records.some((x) => x.kind === "extra")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/kernel && mise x -- bun test test/ticks.test.ts`
Expected: FAIL (`Recorded` not exported / no `record` option).

- [ ] **Step 3: Implement**

`protocol.ts`: `init` gains `clock: ClockMode`; worker → host gains `{ type: "tick"; runId: number; source: TickSource; value: … }` and `{ type: "extra"; runId: number; source: TickSource }`.

`ticks.ts` (imported by the worker only):

```ts
import { Clock, Effect } from "effect"
export type TickSource = "date" | "perf" | "random" | "bytes" | "uuid" | "clock"
export type TickValue = number | string | ReadonlyArray<number>
export type ClockMode = { readonly mode: "record" } | { readonly mode: "replay"; readonly ticks: ReadonlyArray<{ readonly source: TickSource; readonly value: TickValue }> }
export const TICK_CAP = 10_000

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * What one cell sees as Date, Math, performance, crypto and the Effect Clock. Record mode reads the real
 * values and reports each; replay mode serves recorded values in order per source, then continues
 * deterministically (reported as extra). Only cell code sees these: Effect's own internals keep the real ones.
 */
export const makeCellEnv = (clock: ClockMode, report: (source: TickSource, value: TickValue) => void, extra: (source: TickSource) => void) => {
  const RealDate = globalThis.Date
  let count = 0
  const recorded = (source: TickSource, value: TickValue) => {
    if (count++ < TICK_CAP) report(source, value)
    return value
  }
  const queues = new Map<TickSource, Array<TickValue>>()
  const last = new Map<TickSource, { value: number; step: number }>()
  if (clock.mode === "replay") for (const t of clock.ticks) (queues.get(t.source) ?? queues.set(t.source, []).get(t.source)!).push(t.value)
  const rng = mulberry32(1)
  const next = (source: TickSource, live: () => TickValue): TickValue => {
    if (clock.mode === "record") return recorded(source, live())
    const q = queues.get(source)
    if (q !== undefined && q.length > 0) {
      const v = q.shift()!
      if (typeof v === "number") {
        const prev = last.get(source)
        last.set(source, { value: v, step: prev === undefined ? 1 : Math.max(1, v - prev.value) })
      }
      return v
    }
    extra(source)
    if (source === "date" || source === "perf" || source === "clock") {
      const prev = last.get(source) ?? { value: source === "date" || source === "clock" ? 0 : 0, step: 1 }
      const v = prev.value + prev.step
      last.set(source, { value: v, step: prev.step })
      return v
    }
    if (source === "random") return rng()
    if (source === "uuid") return "00000000-0000-4000-8000-" + Math.floor(rng() * 2 ** 48).toString(16).padStart(12, "0")
    return [] // bytes: filled below from rng
  }
  const now = () => next("date", () => RealDate.now()) as number
  class CellDate extends RealDate {
    constructor(...args: Array<unknown>) {
      if (args.length === 0) super(now())
      else super(...(args as [number]))
    }
    static override now() { return now() }
  }
  const CellMath = Object.create(Math, { random: { value: () => next("random", () => Math.random()) as number } })
  const performance = { now: () => next("perf", () => globalThis.performance.now()) as number }
  const crypto = {
    randomUUID: () => next("uuid", () => globalThis.crypto.randomUUID()) as string,
    getRandomValues: <T extends Uint8Array>(a: T): T => {
      const v = next("bytes", () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(a.length))))
      const bytes = Array.isArray(v) && v.length === a.length ? v : Array.from({ length: a.length }, () => Math.floor(rng() * 256))
      a.set(bytes as Array<number>)
      return a
    },
  }
  const millis = () => next("clock", () => RealDate.now()) as number
  const cellClock: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(Math.round((next("perf", () => globalThis.performance.now()) as number) * 1_000_000)),
    monotonicTimeNanos: Effect.sync(() => BigInt(Math.round((next("perf", () => globalThis.performance.now()) as number) * 1_000_000))),
    // Replay: a sleep takes no time. Record: the real clock sleeps.
    sleep: clock.mode === "replay" ? () => Effect.void : (d) => Effect.flatMap(Effect.clockWith((c) => Effect.succeed(c)), (real) => real.sleep(d)),
  }
  return { Date: CellDate, Math: CellMath as Math, performance, crypto, clock: cellClock }
}
```

> Implementer note: `Clock.Clock`'s exact member list comes from `node_modules/effect/dist/Clock.d.ts` (rc.117); match it exactly and ledger a Ruling if a member differs. In record mode, `sleep` must use the default clock's `sleep`: read it with `Effect.clockWith` *before* providing the cell clock, or keep a reference to the default `Clock` service captured at worker start.

`worker.ts`: on `init` store `m.clock`. On `run`, build `env = makeCellEnv(clock, (source, value) => post({ type: "tick", runId: m.id, source, value }), (source) => post({ type: "extra", runId: m.id, source }))` for this cell, add `"Date", "Math", "performance", "crypto"` to the `new Function` parameter list (after `"Effect"`) with `env.Date, env.Math, env.performance, env.crypto`, and run the fiber with `Effect.provideService(Clock.Clock, env.clock)`.

`kernel.ts`: `KernelOptions` gains `clock?: ClockMode` and `record?: (r: Recorded) => void`; send `clock: opts.clock ?? { mode: "record" }` in `init`; in `runOnce`'s `onMessage`, `tick` → `opts.record?.({ kind: "tick", cell: id, source: m.source, value: m.value })`, `extra` → `opts.record?.({ kind: "extra", cell: id, source: m.source })`. Export `Recorded`, `Tick`, `ClockMode`, `TickSource` from `index.ts`.

`manifest.ts` PRELUDE: declare the cell-visible `Date`, `Math`, `performance` and `crypto` are the standard ones (they already type-check as globals; no change needed unless tsc complains about the shadowed parameters — then add nothing, the names resolve to the lib types).

- [ ] **Step 4: Run tests**

Run: `cd packages/kernel && mise x -- bun test && mise x -- bunx tsc`
Expected: PASS (existing kernel tests unchanged).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/kernel && git commit -m "feat(kernel): cells read time and randomness through a recorded (or replayed) clock"
```

---

### Task 2: The kernel records every service call

**Files:**
- Modify: `packages/kernel/src/kernel.ts`, `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/record.test.ts`

**Interfaces:**
- Produces: `interface RecordedCall { readonly cell: number; readonly service: string; readonly method: string; readonly params: unknown; readonly ok: boolean; readonly result?: unknown; readonly failure?: ServiceFailure; readonly ms: number }` — `params` is the JSON the cell sent, `result` the JSON sent back (both the encoded wire form).
- `Recorded` gains `({ kind: "call" } & RecordedCall)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/kernel/test/record.test.ts
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded } from "../src"
import { notes } from "./fixtures"

test("every service call a cell makes is recorded with its params, result and time, failures too", async () => {
  const records: Array<Recorded> = []
  const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const n = notes()
    const k = yield* Kernel.make({ services: [n.bound], record: (r) => records.push(r) })
    return yield* k.run(`const a = yield* Notes.add({ text: "hi" })\nconst b = yield* Effect.catch(Notes.get({ id: "nope" }), () => Effect.succeed("missing"))\nreturn [a.id, b]`)
  })))
  expect(out.ok).toBe(true)
  const calls = records.filter((r) => r.kind === "call")
  expect(calls.map((c: any) => [c.service, c.method, c.params, c.ok, c.result ?? c.failure])).toEqual([
    ["Notes", "add", { text: "hi" }, true, { id: "n1" }],
    ["Notes", "get", { id: "nope" }, false, { _tag: "NotFound", message: "no note nope" }],
  ])
  expect(calls.every((c: any) => typeof c.ms === "number" && c.cell === 1)).toBe(true)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/kernel && mise x -- bun test test/record.test.ts`
Expected: FAIL (no `call` records).

- [ ] **Step 3: Implement**

In `serve(m)`, note `const started = Date.now()` and, in the reply path, call `opts.record?.({ kind: "call", cell: m.runId, service: m.service, method: m.method, params: m.params, ok, ...(ok ? { result: value } : { failure: error }), ms: Date.now() - started })` with the same encoded value or `ServiceFailure` that is sent to the worker. Unknown services are recorded as failures too.

- [ ] **Step 4: Run tests**

Run: `cd packages/kernel && mise x -- bun test && mise x -- bunx tsc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/kernel && git commit -m "feat(kernel): every service call a cell makes is recorded"
```

---

### Task 3: Replay a cell against a recording

**Files:**
- Create: `packages/kernel/src/replay.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/replay.test.ts`

**Interfaces:**
- Consumes: Task 1 (`clock` replay mode, `extra` records), Task 2 (`RecordedCall`).
- Produces:
  ```ts
  interface Divergence { readonly at: number; readonly service: string; readonly method: string; readonly params: unknown; readonly reason: "no matching recorded call" }
  interface ReplayResult { readonly ok: boolean; readonly output: string; readonly divergences: ReadonlyArray<Divergence>; readonly unused: ReadonlyArray<RecordedCall>; readonly extraTicks: ReadonlyArray<TickSource> }
  replay(opts: { readonly code: string; readonly defs: ReadonlyArray<ServiceDef>; readonly calls: ReadonlyArray<RecordedCall>; readonly ticks: ReadonlyArray<{ source: TickSource; value: TickValue }>; readonly timeoutMs?: number }): Effect.Effect<ReplayResult>
  ```
  `code` may be several cells joined as one body (phase 3 cuts cases to that shape).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/kernel/test/replay.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Kernel, type Recorded, replay } from "../src"
import { Notes, notes } from "./fixtures"

const recordRun = (code: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const records: Array<Recorded> = []
    const k = yield* Kernel.make({ services: [notes().bound], record: (r) => records.push(r) })
    const out = yield* k.run(code)
    const calls = records.filter((r) => r.kind === "call").map(({ kind, ...c }: any) => c)
    const ticks = records.filter((r) => r.kind === "tick").map(({ source, value }: any) => ({ source, value }))
    return { out, calls, ticks }
  })))
const again = (code: string, rec: Awaited<ReturnType<typeof recordRun>>) =>
  Effect.runPromise(replay({ code, defs: [Notes], calls: rec.calls, ticks: rec.ticks }))

describe("replay", () => {
  const code = `const a = yield* Notes.add({ text: "hi" })\nconst b = yield* Notes.get({ id: a.id })\nreturn [a.id, b, Date.now() > 0]`

  test("a recorded cell replays to the recorded output with no services behind it", async () => {
    const rec = await recordRun(code)
    const r = await again(code, rec)
    expect(r).toMatchObject({ ok: true, output: rec.out.output, divergences: [], unused: [], extraTicks: [] })
  })

  test("a changed param is a divergence at that call", async () => {
    const rec = await recordRun(code)
    const r = await again(code.replace(`{ text: "hi" }`, `{ text: "bye" }`), rec)
    expect(r.divergences).toEqual([{ at: 0, service: "Notes", method: "add", params: { text: "bye" }, reason: "no matching recorded call" }])
  })

  test("recorded calls the code never made are reported unused", async () => {
    const rec = await recordRun(code)
    const r = await again(`return yield* Notes.add({ text: "hi" })`, rec)
    expect(r.unused.map((c) => c.method)).toEqual(["get"])
  })

  test("concurrent calls replay in any order", async () => {
    const par = `return yield* Effect.all([Notes.add({ text: "a" }), Notes.add({ text: "b" }), Notes.add({ text: "c" })], { concurrency: 3 })`
    const rec = await recordRun(par)
    const shuffled = { ...rec, calls: [...rec.calls].reverse() }
    const r = await again(par, shuffled)
    expect(r.divergences).toEqual([])
    expect(r.output).toBe(rec.out.output)
  })

  test("a recorded failure replays as the same failure", async () => {
    const failing = `return yield* Effect.catch(Notes.get({ id: "nope" }), (e) => Effect.succeed(e._tag))`
    const rec = await recordRun(failing)
    const r = await again(failing, rec)
    expect(r.output).toBe(rec.out.output)
    expect(r.output).toBe("NotFound")
  })
})
```

(`Notes` is the `ServiceDef` exported by `test/fixtures.ts`; export it there if it is not yet exported.)

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/kernel && mise x -- bun test test/replay.test.ts`
Expected: FAIL (`replay` not exported).

- [ ] **Step 3: Implement**

```ts
// packages/kernel/src/replay.ts
import { Effect, Schema } from "effect"
import { make } from "./kernel"
import type { RecordedCall, TickSource, TickValue } from "./kernel"
import { bind, type ServiceDef } from "./service"

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

export interface Divergence { readonly at: number; readonly service: string; readonly method: string; readonly params: unknown; readonly reason: "no matching recorded call" }
export interface ReplayResult { readonly ok: boolean; readonly output: string; readonly divergences: ReadonlyArray<Divergence>; readonly unused: ReadonlyArray<RecordedCall>; readonly extraTicks: ReadonlyArray<TickSource> }

/**
 * Run code against a recording: every service answers from `calls` (the first unused call with the same
 * service, method and params, so concurrent calls may come in any order), and time and randomness come
 * from `ticks`. No model, network or real time is involved.
 */
export const replay = (opts: { readonly code: string; readonly defs: ReadonlyArray<ServiceDef>; readonly calls: ReadonlyArray<RecordedCall>; readonly ticks: ReadonlyArray<{ readonly source: TickSource; readonly value: TickValue }>; readonly timeoutMs?: number }) =>
  Effect.scoped(Effect.gen(function* () {
    const used = new Set<number>()
    const divergences: Array<Divergence> = []
    const extraTicks: Array<TickSource> = []
    let seen = 0
    const bounds = opts.defs.map((def) =>
      bind(def, Object.fromEntries(Object.entries(def.methods).map(([method, spec]) => [method, (decoded: unknown) =>
        Effect.gen(function* () {
          const at = seen++
          const params = spec.json ? decoded : Schema.encodeUnknownSync(Schema.toCodecJson(spec.params))(decoded)
          const key = canonical(params)
          const i = opts.calls.findIndex((c, n) => !used.has(n) && c.service === def.name && c.method === method && canonical(c.params) === key)
          if (i < 0) {
            divergences.push({ at, service: def.name, method, params, reason: "no matching recorded call" })
            return yield* Effect.fail({ _tag: "ReplayDivergence", message: `${def.name}.${method}: no recorded call with these params` })
          }
          used.add(i)
          const c = opts.calls[i]!
          if (!c.ok) return yield* Effect.fail(c.failure!)
          return spec.json ? c.result : Schema.decodeUnknownSync(Schema.toCodecJson(spec.success))(c.result)
        })]) as never),
    )
    const kernel = yield* make({ services: bounds, clock: { mode: "replay", ticks: opts.ticks }, record: (r) => { if (r.kind === "extra") extraTicks.push(r.source) }, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })
    const out = yield* kernel.run(opts.code)
    return { ok: out.ok, output: out.output, divergences, unused: opts.calls.filter((_, n) => !used.has(n)), extraTicks } satisfies ReplayResult
  }))
```

Export `replay`, `ReplayResult`, `Divergence` from `index.ts`.

- [ ] **Step 4: Run tests**

Run: `cd packages/kernel && mise x -- bun test && mise x -- bunx tsc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/kernel && git commit -m "feat(kernel): replay code against recorded calls, time and randomness"
```

---

### Task 4: Records reach the transcript

**Files:**
- Modify: `packages/rlm/src/rlm.ts` (`RlmEvent` gains `record`; pass `record` to `Kernel.make`), `packages/core/src/activity.ts` (write `call` and `tick` transcript lines)
- Test: `packages/rlm/test/rlm.test.ts`, `packages/core/test/robust.test.ts`

**Interfaces:**
- Consumes: `Recorded` (Tasks 1–2).
- Produces: `RlmEvent` member `{ type: "record"; id: string; turn: number; record: Recorded }`; transcript lines `{ type: "call", rlm, turn, cell, service, method, params, ok, result | failure, ms, at }`, `{ type: "tick", rlm, turn, cell, source, value, at }`, `{ type: "extra", … }` (never on the wire).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/rlm/test/rlm.test.ts, describe("observe")
test("service calls and clock reads of every cell are reported as records", async () => {
  const events: Array<Rlm.RlmEvent> = []
  const stub = stubModel({ driver: [{ cell: 'const now = Date.now()\nyield* Rlm.done({ value: String(now > 0) })' }] })
  await Effect.runPromise(Effect.gen(function* () {
    const s = yield* settings({})
    const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
    yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
  }).pipe(Effect.provide(stub.layer)))
  const records = events.filter((e) => e.type === "record").map((e: any) => e.record)
  expect(records.some((r) => r.kind === "tick" && r.source === "date")).toBe(true)
  expect(records.some((r) => r.kind === "call" && r.service === "Rlm" && r.method === "done")).toBe(true)
})
```

```ts
// packages/core/test/robust.test.ts, describe("transcripts")
test("a secret in a recorded call is redacted in the transcript, and records never reach the wire", async () => {
  const driver: Driver = (_s, asker, observe) =>
    Effect.gen(function* () {
      observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
      observe({ type: "record", id: "rlm-1", turn: 1, record: { kind: "call", cell: 1, service: "Fs", method: "read", params: { path: "zt-secret" }, ok: true, result: "zt-secret inside", ms: 3 } })
      observe({ type: "record", id: "rlm-1", turn: 1, record: { kind: "tick", cell: 1, source: "date", value: 1234 } })
      return (yield* asker.ask(question)) as never
    }) as never
  const out = await Effect.runPromise(Effect.gen(function* () {
    const { thread, dir } = yield* setup(driver, undefined, (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
    const events = yield* collect(thread.run({ runId: "r1" }))
    return { events, dir }
  }))
  const lines = readFileSync(join(out.dir, "main.rlm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(lines.find((l) => l.type === "call")).toMatchObject({ rlm: "rlm-1", turn: 1, service: "Fs", method: "read", params: { path: "<redacted:ZT>" }, result: "<redacted:ZT> inside" })
  expect(lines.find((l) => l.type === "tick")).toMatchObject({ rlm: "rlm-1", source: "date", value: 1234 })
  expect(JSON.stringify(out.events)).not.toContain("1234")
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/rlm && mise x -- bun test test/rlm.test.ts -t "records"` and `cd packages/core && mise x -- bun test test/robust.test.ts -t "recorded call"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`rlm.ts`: where the RLM creates its kernel, pass `record: (r) => emit({ type: "record", id, turn: turnCount, record: r })`. Add the `record` member to `RlmEvent`. Tests that list event kinds (`reports start, turns and end…`) filter `record` out as they filter `step` and `model`.

`activity.ts` `observe`: `if (e.type === "record") { const { kind, ...rest } = e.record; Effect.runSync(log.transcript(threadId, { type: kind, rlm: id, turn: e.turn, ...rest })); return }` — before the activity tree handling, so records never become activity deltas.

- [ ] **Step 4: Run tests**

Run: `mise run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rlm packages/core && git commit -m "feat(rlm,core): agents' service calls and clock reads are recorded in the transcript"
```
