import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import type { Asker, Rlm } from "@zarg/rlm"
import { makeLog } from "@zarg/core"
import { makeThread, OPEN_QUESTION, type ThreadDeps, WHAT_NEXT, WHAT_NEXT_GAPS, REPLY_RULE } from "../src/thread"
import type { WireEvent } from "@zarg/core"

type Driver = (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>

const outcome = (value: unknown): Rlm.RlmOutcome => ({ id: "rlm-x", value, turns: 1, tokens: 1 })

/** A thread over a fresh log with a scripted driver; `agenda` answers with the given items each time. */
const setup = (driver: Driver, agenda: () => ReadonlyArray<AgendaItem> = () => [], render?: ThreadDeps["render"], focus: ReadonlyArray<string> = [], suggest?: ThreadDeps["suggest"]) =>
  Effect.gen(function* () {
    const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
    const thread = yield* makeThread({ id: "main", focus, log, agenda: () => Effect.succeed(agenda()), driver, ...(render !== undefined ? { render } : {}), ...(suggest !== undefined ? { suggest } : {}) })
    return { log, thread }
  })

const collect = (s: Stream.Stream<WireEvent>) => Effect.map(Stream.runCollect(s), (c) => [...c])
const last = (events: ReadonlyArray<WireEvent>) => events.at(-1)!
const texts = (events: ReadonlyArray<WireEvent>) => events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
const question = { question: "Which?", options: [{ id: "a", label: "Option A", recommended: true, why: "simpler" }, { id: "b", label: "Option B" }] }

describe("thread runs", () => {
  test("the driver's task already holds the agenda and the item's cards, so its first turn need not fetch them", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [
      { id: "dead-end:S-0059", title: "What follows S-0059?", detail: "No card continues from S-0059.", about: ["S-0059"], priority: 1 },
      { id: "lint:UX-0002", title: "UX-0002 has an if", detail: "Split it.", about: ["UX-0002"], priority: 2 },
    ]
    const rendered: Array<ReadonlyArray<string>> = []
    const render = (focus: ReadonlyArray<string>) => Effect.sync(() => (rendered.push(focus), `RENDER OF ${focus.join(",")}`))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, render); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(rendered).toEqual([["S-0059"]])
    expect(tasks[0]).toContain("Open agenda (2):\n- What follows S-0059? [S-0059]\n- UX-0002 has an if [UX-0002]")
    expect(tasks[0]).toContain("The cards around it (Graph.render of S-0059):\nRENDER OF S-0059")
  })

  test("the seeded render is asked within the thread's scope, and a huge render is cut", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["UX-0001", "UX-0099"], priority: 1 }]
    const scopes: Array<unknown> = []
    const render: ThreadDeps["render"] = (_ids, scope) => Effect.sync(() => (scopes.push(scope), "y".repeat(10_000)))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, render, ["UX-0001"]); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(scopes).toEqual([{ graph: { focus: ["UX-0001"], k: 2 } }])
    expect(tasks[0]).toContain("y".repeat(4_000) + "\n… (cut; Graph.render({ focus }) shows the rest)")
    expect(tasks[0]).not.toContain("y".repeat(4_001))
  })

  test("an empty agenda with gaps found in code: the driver asks from them at once, without reading the whole graph", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const gaps: ReadonlyArray<AgendaItem> = [
      { id: "g1", title: "Only one thing happens from S-3", detail: "Add a failure case?", about: ["S-3", "UX-6"], priority: 1 },
      { id: "g2", title: "Only one thing happens from S-1", detail: "Add a failure case?", about: ["S-1", "UX-1"], priority: 2 },
    ]
    const focuses: Array<unknown> = []
    const suggest: ThreadDeps["suggest"] = (focus) => Effect.sync(() => (focuses.push(focus), gaps))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => [], undefined, ["S-1"], suggest); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(focuses).toEqual([new Set(["S-1"])])
    expect(tasks[0]).toStartWith(WHAT_NEXT_GAPS)
    expect(WHAT_NEXT_GAPS).toContain("Do not render the whole graph")
    expect(tasks[0]).toContain("Gaps zarg found:\n- Only one thing happens from S-3 [S-3, UX-6]: Add a failure case?\n- Only one thing happens from S-1 [S-1, UX-1]: Add a failure case?")
  })

  test("after a what-next item, the driver waits for the developer instead of asking what next again", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("I added the card you chose.")))
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" })).pipe(Effect.timeoutOrElse({ duration: 2000, orElse: () => Effect.succeed([] as Array<WireEvent>) }))
        yield* Effect.sleep(50)
        expect(tasks.length).toBe(1)
        yield* Effect.forkChild(collect(thread.run({ runId: "r2", message: "now the login journey" })))
        yield* Effect.sleep(50)
        return first
      }),
    )
    expect(last(events)).toMatchObject({ type: "RUN_FINISHED", runId: "r1" })
    expect(tasks[1]).toStartWith('The developer said: "now the login journey"')
  })

  test("the what-next task offers the developer's own idea, never a journey the driver makes up", () => {
    expect(WHAT_NEXT_GAPS).toContain("allowOther")
    expect(WHAT_NEXT_GAPS).not.toContain("new journey")
    expect(WHAT_NEXT).not.toContain("the next journey")
  })

  test("nothing open and no gaps: zarg asks what to work on itself, from the intent's next goals, and the answer goes to the driver", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("ok")))
    const whatNext: ThreadDeps["whatNext"] = () =>
      Effect.succeed([
        { id: "rehearse", label: "Rehearse", why: "roleplay testers over the graph", task: "Work on the intent's next goal: Rehearse: roleplay testers over the graph." },
        { id: "capture", label: "Capture", why: "the driver keeps intent/*.md", task: "Work on the intent's next goal: Capture." },
      ])
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver, suggest: () => Effect.succeed([]), whatNext })
        const first = yield* collect(thread.run({ runId: "r1" }))
        const asked = (last(first) as any).outcome.interrupts[0]
        yield* Effect.forkChild(collect(thread.run({ runId: "r2", resume: [{ interruptId: asked.id, payload: { choice: "rehearse" } }] })))
        yield* Effect.sleep(50)
        return { asked }
      }),
    )
    expect(out.asked.message).toBe(OPEN_QUESTION)
    expect(out.asked.metadata.options).toEqual([
      { id: "rehearse", label: "Rehearse", why: "roleplay testers over the graph", recommended: true },
      { id: "capture", label: "Capture", why: "the driver keeps intent/*.md" },
    ])
    expect(out.asked.metadata.allowOther).toBe(true)
    expect(tasks[0]).toStartWith('The developer said: "Work on the intent\'s next goal: Rehearse: roleplay testers over the graph."')
  })

  test("wake: a thread parked on zarg's what-next question takes up new agenda items; a real question keeps its turn", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("ok")))
    let items: ReadonlyArray<AgendaItem> = []
    const whatNext: ThreadDeps["whatNext"] = () => Effect.succeed([{ id: "g", label: "A goal", task: "Work on the goal." }])
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed(items), driver, suggest: () => Effect.succeed([]), whatNext })
        yield* collect(thread.run({ runId: "r1" }))
        items = [{ id: "rehearse:r-1", title: "Rehearse run r-1: 1 finding", detail: "d", about: [], priority: 0 }]
        yield* thread.wake
        yield* Effect.sleep(50)
        return { log }
      }),
    )
    expect(tasks[0]).toStartWith("Rehearse run r-1: 1 finding")
    // Nothing was said for the operator: the question just went away.
    expect(out.log.all().filter((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "")).toEqual([])
  })

  test("an empty agenda and no gaps (or a failing suggest): the driver works out the options itself", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => [], undefined, [], () => Effect.die("bug")); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(tasks[0]).toStartWith(WHAT_NEXT)
  })

  test("a render that dies leaves the cards out; the driver still runs", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["S-1"], priority: 1 }]
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, () => Effect.die("plugin bug")); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(tasks[0]).toContain("T\nD")
  })

  test("a render that fails leaves the cards out of the task; the driver still runs", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["S-1"], priority: 1 }]
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, () => Effect.fail("boom")); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(tasks[0]).toContain("T\nD")
    expect(tasks[0]).not.toContain("The cards around it")
  })

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
    expect(tasks[0]).toStartWith(WHAT_NEXT)
  })

  test("a message while a question is pending opens a discussion of it; the question stays open for the driver", async () => {
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
    expect(answers).toEqual([{ other: "actually, do payments first", interjected: true, question: expect.stringMatching(/^inq-/) }])
    expect(texts(second)).toEqual(["actually, do payments first", "(discussing: Which?)", "adapted"])
  })

  test("the driver can choose an option of the question under discussion for the developer, once", async () => {
    const out: Record<string, unknown> = {}
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ > 0) return yield* Effect.never
        const a = yield* asker.ask(question)
        out.wrong = yield* Effect.flip(asker.choose!({ question: a.question!, choice: "z", why: "x" }))
        out.chosen = yield* asker.choose!({ question: a.question!, choice: "b", why: "they want the smaller one" })
        out.again = yield* Effect.flip(asker.choose!({ question: a.question!, choice: "b", why: "x" }))
        return outcome("done")
      }) as never
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        yield* collect(thread.run({ runId: "r1" }))
        return yield* collect(thread.run({ runId: "r2", message: "which is smaller?" }).pipe(Stream.take(14)))
      }),
    )
    expect(out.wrong).toMatchObject({ _tag: "InvalidChoice" })
    expect(out.chosen).toEqual({ choice: "b" })
    expect(out.again).toMatchObject({ _tag: "NoOpenQuestion" })
    expect(texts(second)).toContain("zarg chose Option B for you: they want the smaller one")
  })

  test("a question left under discussion is named in the next driver's task", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ === 0) {
          yield* asker.ask(question)
          return outcome("let me think about that")
        }
        return yield* Effect.never
      }) as never
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        yield* collect(thread.run({ runId: "r1" }))
        yield* collect(thread.run({ runId: "r2", message: "what does B cost?" }).pipe(Stream.take(10)))
        yield* Effect.sleep(50)
      }),
    )
    expect(tasks[1]).toContain('Still under discussion: "Which?" (question inq-')
    expect(tasks[1]).toContain("options: a = Option A, b = Option B")
    expect(tasks[1]).toContain("Inquire.choose")
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

  test("your message comes before the agenda: the next driver item answers you", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ === 0) {
          yield* Effect.sleep(100)
          return outcome("worked on the agenda")
        }
        return yield* Effect.map(asker.ask(question), () => outcome("unused"))
      }) as never
    const item: AgendaItem = { id: "x", title: "An agenda item", detail: "d", about: [], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        const first = yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(20)
        yield* collect(thread.run({ runId: "r2", message: "hi, what can we do?" }))
        yield* Fiber.join(first)
      }),
    )
    expect(tasks[0]).toContain("An agenda item")
    expect(tasks[1]).toStartWith('The developer said: "hi, what can we do?"')
  })

  test("the driver's reply is kept short, and every task says so", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ === 0) return outcome("x".repeat(2000))
        return yield* Effect.map(asker.ask(question), () => outcome("unused"))
      }) as never
    const out = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    const reply = texts(out)[0] as string
    expect(reply.length).toBeLessThanOrEqual(601)
    expect(reply.endsWith("…")).toBe(true)
    expect(tasks[0]).toContain("one or two sentences")
  })

  test("the agenda's first item is the driver's task, with recent conversation", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        // The first item answers the operator's message; the next one is the agenda's.
        if (calls++ === 0) return outcome("Hello! Let's look at the agenda.")
        return (yield* asker.ask(question)) as never
      }) as never
    const item: AgendaItem = { id: "gherkin:dead-end:S-0004", title: "What happens after payment?", detail: "No card continues from S-0004.", about: ["S-0004"], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1", message: "hello" }))
      }),
    )
    expect(tasks[0]).toStartWith('The developer said: "hello"')
    expect(tasks[1]).toContain("What happens after payment?\nNo card continues from S-0004.")
    expect(tasks[1]).toContain("show the exact change with Inquire.confirm before writing it")
    expect(tasks[1]).toContain("Recent conversation:\ndeveloper: hello\ndriver: Hello! Let's look at the agenda.")
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
    // The driver's own rows (zarg's row, the conversation's root, is its parent).
    const rlm = deltas.filter((d) => d.patch[0].path === "/rlms/rlm-1").at(-1)
    expect(rlm.patch[0]).toMatchObject({ op: "add", path: "/rlms/rlm-1", value: { parent: "zarg", preset: "driver", task: "t", turns: 1, budget: 25, status: "running" } })
    expect(events.some((e) => e.type === "ACTIVITY_SNAPSHOT")).toBe(true)
  })

  test("secrets are redacted before events are stored or sent", async () => {
    const driver: Driver = (_spec, asker) => Effect.gen(function* () { return (yield* asker.ask({ ...question, question: "use zt-secret?" })) as never }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(JSON.stringify(events)).not.toContain("zt-secret")
    expect(JSON.stringify(events)).toContain("<redacted:ZT>")
  })
})

test("the driver shows every card with who acts in it (By), and names by when it writes one", () => {
  expect(REPLY_RULE).toContain("By / Given / When / Then")
  expect(REPLY_RULE).toContain("every card names who acts in it with by")
})
