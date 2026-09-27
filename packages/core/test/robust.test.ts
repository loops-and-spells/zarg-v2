import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { initial, reduce } from "@zarg/client"
import type { Asker, Rlm } from "@zarg/rlm"
import type { WireEvent } from "../src/events"
import { makeLog } from "../src/log"
import { makeThread } from "../src/thread"

type Driver = (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>
const outcome = (value: unknown): Rlm.RlmOutcome => ({ id: "rlm-x", value, turns: 1, tokens: 1 })
const question = { question: "Which?", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }
const setup = (driver: Driver, dir = mkdtempSync(join(tmpdir(), "zarg-robust-")), redact: (t: string) => string = (t) => t) =>
  Effect.gen(function* () {
    const log = yield* makeLog(dir, redact)
    const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver })
    return { log, thread, dir }
  })
/** A run's events; fails instead of hanging when the run never ends. */
const collect = (s: Stream.Stream<WireEvent>) =>
  Stream.runCollect(s).pipe(
    Effect.map((c) => [...c]),
    Effect.timeoutOrElse({ duration: 2000, orElse: () => Effect.die(new Error("the run never ended")) }),
  )
const last = (events: ReadonlyArray<WireEvent>) => events.at(-1)!

/** Every RUN_FINISHED closes the run that is open; nothing ends a run twice. */
const bracketProblems = (events: ReadonlyArray<WireEvent>) => {
  const problems: Array<string> = []
  let open: string | undefined
  for (const e of events) {
    if (e.type === "RUN_STARTED") open = String(e.runId)
    else if (e.type === "RUN_FINISHED") {
      if (open !== e.runId) problems.push(`RUN_FINISHED ${String(e.runId)} while ${open ?? "no run"} is open`)
      open = undefined
    } else if (e.type === "RUN_ERROR") open = undefined
  }
  return problems
}

describe("thread robustness", () => {
  test("a plain run while a question is pending gets the question again", async () => {
    const driver: Driver = (_s, asker) => Effect.map(asker.ask(question), () => outcome("x")) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const second = yield* collect(thread.run({ runId: "r2" }))
        return { first, second }
      }),
    )
    const id = (last(out.first) as any).outcome.interrupts[0].id
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt", interrupts: [{ id, message: "Which?" }] } })
  })

  test("a run arriving while stop is still interrupting the driver is not cancelled; runs stay bracketed", async () => {
    let calls = 0
    const driver: Driver = (_s, asker) =>
      (calls++ === 0
        ? Effect.never.pipe(Effect.onInterrupt(() => Effect.sleep(100)))
        : Effect.map(asker.ask(question), () => outcome("x"))) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, log } = yield* setup(driver)
        yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(30)
        const stopping = yield* Effect.forkChild(thread.stop)
        yield* Effect.sleep(20)
        const second = yield* collect(thread.run({ runId: "r2", message: "go on" }))
        yield* Fiber.join(stopping)
        return { second, all: log.all() }
      }),
    )
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
    expect(bracketProblems(out.all)).toEqual([])
  })

  test("stop with no run open brackets its note in a run of its own", async () => {
    const driver: Driver = (_s, asker) => Effect.map(asker.ask(question), () => outcome("x")) as never
    const all = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, log } = yield* setup(driver)
        yield* thread.stop
        yield* collect(thread.run({ runId: "r1" }))
        yield* thread.stop
        return log.all()
      }),
    )
    expect(bracketProblems(all)).toEqual([])
    expect(all.some((e) => e.runId === "")).toBe(false)
  })

  test("a defect in the loop ends the run with RUN_ERROR; the next run starts a fresh loop", async () => {
    let calls = 0
    const driver: Driver = (_s, asker) => (calls++ === 0 ? Effect.succeed(outcome("💥")) : Effect.map(asker.ask(question), () => outcome("x"))) as never
    const redact = (t: string) => {
      if (t.includes("💥")) throw new Error("disk full")
      return t
    }
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, undefined, redact)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const status = thread.status()
        const second = yield* collect(thread.run({ runId: "r2" }))
        return { first, status, second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_ERROR", code: "internal" })
    expect(String(last(out.first).message)).toContain("disk full")
    expect(out.status).toBe("idle")
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
  })

  test("each driver item starts a fresh RLM tree", async () => {
    let calls = 0
    const driver: Driver = (_s, asker, observe) =>
      Effect.gen(function* () {
        const budget = { turns: 25, tokens: 1, wallMs: 1 }
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget })
        if (calls++ === 0) {
          observe({ type: "start", id: "rlm-2", parent: "rlm-1", preset: "research", task: "t", scope: {}, depth: 1, budget })
          observe({ type: "end", id: "rlm-2", ok: true, turns: 1, tokens: 1 })
          return outcome("first")
        }
        return (yield* asker.ask(question)) as never
      }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    const state = events.reduce(reduce, initial("main"))
    expect(Object.keys(state.rlms)).toEqual(["rlm-1"])
  })

  test("message and interrupt ids stay unique across core restarts", async () => {
    const driver: Driver = (_s, asker) => Effect.map(asker.ask(question), () => outcome("x")) as never
    const dir = mkdtempSync(join(tmpdir(), "zarg-restart-"))
    const session = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { thread } = yield* setup(driver, dir)
          return yield* collect(thread.run({ runId: crypto.randomUUID(), message: "hi" }))
        }),
      )
    const a = await session()
    const b = await session()
    const ids = (es: ReadonlyArray<WireEvent>) => es.filter((e) => e.type === "TEXT_MESSAGE_START").map((e) => e.messageId)
    const inq = (es: ReadonlyArray<WireEvent>) => (last(es) as any).outcome.interrupts[0].id
    expect(ids(b).filter((id) => ids(a).includes(id))).toEqual([])
    expect(inq(a)).not.toBe(inq(b))
  })
})

describe("transcripts", () => {
  test("each RLM's task, text, cells and outputs go to <thread>.rlm.jsonl, redacted; the wire gets only the task's first line", async () => {
    const driver: Driver = (_s, asker, observe) =>
      Effect.gen(function* () {
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "the task\nthe agenda and graph context", scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
        observe({ type: "step", id: "rlm-1", turn: 1, text: "hmm", cells: [{ code: 'Fs.read("zt-secret")', ok: false, output: "no such file", ms: 3 }], firstTokenMs: 1, modelMs: 2, promptTokens: 10, completionTokens: 5 })
        return (yield* asker.ask(question)) as never
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, dir } = yield* setup(driver, undefined, (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
        const events = yield* collect(thread.run({ runId: "r1" }))
        return { events, dir }
      }),
    )
    const lines = readFileSync(join(out.dir, "main.rlm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(["start", "step"])
    expect(lines[0]).toMatchObject({ rlm: "rlm-1", preset: "driver", task: "the task\nthe agenda and graph context" })
    expect(lines[1]).toMatchObject({ rlm: "rlm-1", turn: 1, text: "hmm", cells: [{ code: 'Fs.read("<redacted:ZT>")', ok: false, output: "no such file" }] })
    expect(JSON.stringify(out.events)).toContain('"task":"the task"')
    expect(JSON.stringify(out.events)).not.toContain("the agenda and graph context")
    expect(JSON.stringify(out.events)).not.toContain("hmm")
  })

  test("the task headline is redacted before it is cut, so no part of a secret reaches the wire", async () => {
    const task = `${"x".repeat(195)} zt-secret and more`
    const driver: Driver = (_s, asker, observe) =>
      Effect.gen(function* () {
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task, scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
        return (yield* asker.ask(question)) as never
      }) as never
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, undefined, (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
        return yield* collect(thread.run({ runId: "r1" }))
      }),
    )
    const wire = JSON.stringify(events)
    expect(wire).not.toContain(" zt-")
    expect(wire).toContain(" <red")
  })

  test("the atomize decision goes to the transcript with its time", async () => {
    const driver: Driver = (_s, asker, observe) =>
      Effect.gen(function* () {
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
        observe({ type: "atomize", id: "rlm-1", atomic: true, reason: "r", criteria: [{ name: "single", answer: true, confidence: 0.9 }], ms: 4200 })
        return (yield* asker.ask(question)) as never
      }) as never
    const dir = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, dir } = yield* setup(driver)
        yield* collect(thread.run({ runId: "r1" }))
        return dir
      }),
    )
    const lines = readFileSync(join(dir, "main.rlm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(["start", "atomize"])
    expect(lines[1]).toMatchObject({ rlm: "rlm-1", atomic: true, ms: 4200, criteria: [{ name: "single", answer: true, confidence: 0.9 }] })
  })

  test("a restarted core does not read transcripts as events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-log-"))
    writeFileSync(join(dir, "main.jsonl"), `${JSON.stringify({ type: "RUN_STARTED", threadId: "main", runId: "r", seq: 1 })}\n`)
    writeFileSync(join(dir, "main.rlm.jsonl"), `${JSON.stringify({ type: "step", rlm: "rlm-1", turn: 1 })}\n`)
    const all = await Effect.runPromise(Effect.map(makeLog(dir, (t) => t), (l) => l.all()))
    expect(all.map((e) => String(e.type))).toEqual(["RUN_STARTED"])
  })
})

describe("log", () => {
  test("redaction applies to string values only: escaped secrets are caught and keys stay intact", async () => {
    const e = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-log-")), (t) => t.replaceAll("line1\nline2", "<R>").replaceAll("seq", "<S>"))
        return yield* log.append("main", { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: 'key: line1\nline2 "seq"' } as never)
      }),
    )
    expect(e.delta).toBe('key: <R> "<S>"')
    expect(typeof e.seq).toBe("number")
  })

  test("a truncated line in a thread log is skipped at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-log-"))
    writeFileSync(join(dir, "main.jsonl"), `${JSON.stringify({ type: "RUN_STARTED", threadId: "main", runId: "r", seq: 1 })}\n{"type":"RUN_FIN`)
    const all = await Effect.runPromise(Effect.map(makeLog(dir, (t) => t), (l) => l.all()))
    expect(all.map((e) => e.seq)).toEqual([1])
  })
})
