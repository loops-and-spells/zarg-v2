import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import type { Asker, Rlm } from "@zarg/rlm"
import { makeLog } from "../src/log"
import { makeThread, WHAT_NEXT } from "../src/thread"
import type { WireEvent } from "../src/events"

type Driver = (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>

const outcome = (value: unknown): Rlm.RlmOutcome => ({ id: "rlm-x", value, turns: 1, tokens: 1 })

/** A thread over a fresh log with a scripted driver; `agenda` answers with the given items each time. */
const setup = (driver: Driver, agenda: () => ReadonlyArray<AgendaItem> = () => []) =>
  Effect.gen(function* () {
    const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
    const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed(agenda()), driver })
    return { log, thread }
  })

const collect = (s: Stream.Stream<WireEvent>) => Effect.map(Stream.runCollect(s), (c) => [...c])
const last = (events: ReadonlyArray<WireEvent>) => events.at(-1)!
const texts = (events: ReadonlyArray<WireEvent>) => events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
const question = { question: "Which?", options: [{ id: "a", label: "Option A", recommended: true, why: "simpler" }, { id: "b", label: "Option B" }] }

describe("thread runs", () => {
  test("a run ends with an interrupt when the driver asks; resume continues the same driver", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ > 0) return yield* Effect.never
        const a = yield* asker.ask(question)
        return outcome(`picked ${a.choice}`)
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const interrupt = last(first) as any
        const second = yield* collect(
          thread.run({ runId: "r2", resume: [{ interruptId: interrupt.outcome.interrupts[0].id, payload: { choice: "a" } }] }).pipe(Stream.take(8)),
        )
        return { first, interrupt, second }
      }),
    )
    expect(String(out.first[0]?.type)).toBe("RUN_STARTED")
    expect(out.interrupt).toMatchObject({ type: "RUN_FINISHED", runId: "r1", outcome: { type: "interrupt", interrupts: [{ reason: "inquiry", message: "Which?" }] } })
    expect(out.interrupt.outcome.interrupts[0].metadata.options[0]).toMatchObject({ id: "a", recommended: true })
    expect(texts(out.second)).toEqual(["Option A", "picked a"])
    expect(tasks[0]).toBe(WHAT_NEXT)
  })

  test("a message while a question is pending answers it as an interjection", async () => {
    const answers: Array<unknown> = []
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ > 0) return yield* Effect.never
        answers.push(yield* asker.ask(question))
        return outcome("adapted")
      }) as never
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        yield* collect(thread.run({ runId: "r1" }))
        return yield* collect(thread.run({ runId: "r2", message: "actually, do payments first" }).pipe(Stream.take(11)))
      }),
    )
    expect(answers).toEqual([{ other: "actually, do payments first", interjected: true }])
    expect(texts(second)).toEqual(["actually, do payments first", "(dropped question: Which?)", "adapted"])
  })

  test("a new run while the driver works ends the open run; the message reaches the next driver", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ === 0) {
          yield* Effect.sleep(100)
          return outcome("first item done")
        }
        return yield* Effect.map(asker.ask(question), () => outcome("unused"))
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(20)
        const second = yield* collect(thread.run({ runId: "r2", message: "also add a logout card" }))
        return { first: yield* Fiber.join(first), second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_FINISHED", runId: "r1" })
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
    expect(tasks[1]).toContain("developer: also add a logout card")
  })

  test("the agenda's first item is the driver's task, with recent conversation", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const item: AgendaItem = { id: "gherkin:dead-end:S-0004", title: "What happens after payment?", detail: "No card continues from S-0004.", about: ["S-0004"], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1", message: "hello" }))
      }),
    )
    expect(tasks[0]).toContain("What happens after payment?\nNo card continues from S-0004.")
    expect(tasks[0]).toContain("Recent conversation:\ndeveloper: hello")
  })

  test("an item still open after two passes turns into a what-next question", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (++calls < 3) return outcome(`pass ${calls}`)
        return (yield* asker.ask(question)) as never
      }) as never
    const item: AgendaItem = { id: "x", title: "Stuck item", detail: "d", about: [], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1" }))
      }),
    )
    expect(tasks[0]).toContain("Stuck item")
    expect(tasks[1]).toContain("Stuck item")
    expect(tasks[2]).toContain(WHAT_NEXT)
    expect(tasks[2]).toContain('"Stuck item" is still open after two passes')
  })

  test("a failing driver ends the run with RUN_ERROR; the next run tries again", async () => {
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ === 0) return yield* Effect.fail({ _tag: "RlmError", kind: "model", message: "router down" } as never)
        return (yield* asker.ask(question)) as never
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const second = yield* collect(thread.run({ runId: "r2" }))
        return { first, second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_ERROR", message: "router down", code: "model" })
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
  })

  test("stop interrupts the running driver and records it", async () => {
    let interrupted = false
    const driver: Driver = () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))) as never
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, log } = yield* setup(driver)
        yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(50)
        yield* thread.stop
        return log.all()
      }),
    )
    expect(interrupted).toBe(true)
    expect(texts(events as WireEvent[])).toContain("(stopped)")
    expect(last(events as WireEvent[])).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "cancelled" } })
  })

  test("RLM activity becomes activity deltas for the agents pane", async () => {
    const driver: Driver = (_spec, asker, observe) =>
      Effect.gen(function* () {
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", task: "t", scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
        observe({ type: "turn", id: "rlm-1", turn: 1, tokens: 10 })
        return (yield* asker.ask(question)) as never
      }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    const deltas = events.filter((e) => e.type === "ACTIVITY_DELTA") as any[]
    expect(deltas.at(-1).patch[0]).toMatchObject({ op: "add", path: "/rlms/rlm-1", value: { preset: "driver", turns: 1, budget: 25, status: "running" } })
    expect(events.some((e) => e.type === "ACTIVITY_SNAPSHOT")).toBe(true)
  })

  test("secrets are redacted before events are stored or sent", async () => {
    const driver: Driver = (_spec, asker) => Effect.gen(function* () { return (yield* asker.ask({ ...question, question: "use zt-secret?" })) as never }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(JSON.stringify(events)).not.toContain("zt-secret")
    expect(JSON.stringify(events)).toContain("<redacted:ZT>")
  })
})
