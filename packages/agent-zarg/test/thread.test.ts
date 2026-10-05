import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Stream } from "effect"
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
  test("the driver's task starts with the graph as it is now (an overview), so its first turns need not rediscover it", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec) => Effect.suspend(() => (calls++ > 0 ? Effect.never : (tasks.push(spec.task), Effect.succeed(outcome("ok"))))) as never
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zt-overview-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([{ id: "gherkin:empty", title: "No requirements yet", detail: "d", about: [], priority: 1 }]), driver, overview: () => Effect.succeed("1 intent, 0 personas, 0 journeys, 0 scenarios") })
        return yield* collect(thread.run({ runId: "r1" }).pipe(Stream.take(3)))
      }),
    )
    expect(tasks[0]).toContain("The graph now (no need to read it again):\n1 intent, 0 personas, 0 journeys, 0 scenarios")
  })

  test("the driver's task already holds the agenda and the item's scenarios, so its first turn need not fetch them", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [
      { id: "dead-end:ST-0059", title: "What follows ST-0059?", detail: "No scenario continues from ST-0059.", about: ["ST-0059"], priority: 1 },
      { id: "lint:S-0002", title: "S-0002 has an if", detail: "Split it.", about: ["S-0002"], priority: 2 },
    ]
    const rendered: Array<ReadonlyArray<string>> = []
    const render = (focus: ReadonlyArray<string>) => Effect.sync(() => (rendered.push(focus), `RENDER OF ${focus.join(",")}`))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, render); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(rendered).toEqual([["ST-0059"]])
    expect(tasks[0]).toContain("Open agenda (2):\n- What follows ST-0059? [ST-0059]\n- S-0002 has an if [S-0002]")
    expect(tasks[0]).toContain("The scenarios around it (Graph.render of ST-0059):\nRENDER OF ST-0059")
  })

  test("the seeded render is asked within the thread's scope, and a huge render is cut", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["S-0001", "S-0099"], priority: 1 }]
    const scopes: Array<unknown> = []
    const render: ThreadDeps["render"] = (_ids, scope) => Effect.sync(() => (scopes.push(scope), "y".repeat(10_000)))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, render, ["S-0001"]); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(scopes).toEqual([{ graph: { focus: ["S-0001"], k: 2 } }])
    expect(tasks[0]).toContain("y".repeat(4_000) + "\n… (cut; Graph.render({ focus }) shows the rest)")
    expect(tasks[0]).not.toContain("y".repeat(4_001))
  })

  // @scenario S-0014
  test("an empty agenda with gaps found in code: the driver asks from them at once, without reading the whole graph", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const gaps: ReadonlyArray<AgendaItem> = [
      { id: "g1", title: "Only one thing happens from ST-3", detail: "Add a failure case?", about: ["ST-3", "S-6"], priority: 1 },
      { id: "g2", title: "Only one thing happens from ST-1", detail: "Add a failure case?", about: ["ST-1", "S-1"], priority: 2 },
    ]
    const focuses: Array<unknown> = []
    const suggest: ThreadDeps["suggest"] = (focus) => Effect.sync(() => (focuses.push(focus), gaps))
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => [], undefined, ["ST-1"], suggest); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(focuses).toEqual([new Set(["ST-1"])])
    expect(tasks[0]).toStartWith(WHAT_NEXT_GAPS)
    expect(WHAT_NEXT_GAPS).toContain("Do not render the whole graph")
    expect(tasks[0]).toContain("Gaps zarg found:\n- Only one thing happens from ST-3 [ST-3, S-6]: Add a failure case?\n- Only one thing happens from ST-1 [ST-1, S-1]: Add a failure case?")
  })

  test("after a what-next item, the driver waits for the operator instead of asking what next again", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("I added the scenario you chose.")))
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
    expect(tasks[1]).toStartWith('The operator said: "now the login journey"')
  })

  test("the what-next task offers the operator's own idea, never a journey the driver makes up", () => {
    expect(WHAT_NEXT_GAPS).toContain("allowOther")
    expect(WHAT_NEXT_GAPS).not.toContain("new journey")
    expect(WHAT_NEXT).not.toContain("the next journey")
  })

  // @scenario S-0014 S-0015
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
    expect(tasks[0]).toStartWith('The operator said: "Work on the intent\'s next goal: Rehearse: roleplay testers over the graph."')
  })

  test("a what-next option that starts work elsewhere (a rehearsal) waits for it: no what-next asked again until new work wakes zarg", async () => {
    const tasks: Array<string> = []
    // A real item takes a while (model turns): the answer's run is over before it ends.
    const driver: Driver = (spec) => Effect.andThen(Effect.sleep(20), Effect.sync(() => (tasks.push(spec.task), outcome("started"))))
    let items: ReadonlyArray<AgendaItem> = []
    let asked = 0
    const whatNext: ThreadDeps["whatNext"] = () => Effect.sync(() => (asked++, [{ id: "rehearse", label: "Rehearse", task: "Start a rehearsal.", waits: true }]))
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed(items), driver, suggest: () => Effect.succeed([]), whatNext })
        const first = yield* collect(thread.run({ runId: "r1" }))
        const q = (last(first) as any).outcome.interrupts[0]
        yield* Effect.forkChild(collect(thread.run({ runId: "r2", resume: [{ interruptId: q.id, payload: { choice: "rehearse" } }] })))
        yield* Effect.sleep(80)
        expect(asked).toBe(1)
        items = [{ id: "rehearse:r-1", title: "Rehearse run r-1: 1 finding", detail: "d", about: [], priority: 0 }]
        yield* thread.wake
        yield* Effect.sleep(80)
      }),
    )
    // What the run filed, taken up (the test's agenda never empties: it comes back until it counts as stuck).
    expect(tasks[1]).toStartWith("Rehearse run r-1: 1 finding")
  })

  test("a what-next option that zarg does itself (turning reconcile on) runs when picked: its words said, no driver item, then zarg waits", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("ok")))
    let ran = 0
    let asked = 0
    const whatNext: ThreadDeps["whatNext"] = () => Effect.sync(() => (asked++, [{ id: "build", label: "Build the scenarios", task: "", run: Effect.sync(() => (ran++, "Reconcile is on; a pass is starting (2 scenarios).")) }]))
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver, suggest: () => Effect.succeed([]), whatNext })
        const first = yield* collect(thread.run({ runId: "r1" }))
        const q = (last(first) as any).outcome.interrupts[0]
        yield* Effect.forkChild(collect(thread.run({ runId: "r2", resume: [{ interruptId: q.id, payload: { choice: "build" } }] })))
        yield* Effect.sleep(80)
        return { log }
      }),
    )
    expect(ran).toBe(1)
    expect(tasks).toEqual([])
    expect(asked).toBe(1)
    expect(out.log.all().some((e) => e.type === "TEXT_MESSAGE_CONTENT" && String(e.delta).includes("Reconcile is on"))).toBe(true)
  })

  test("a change the operator added but the item did not write is the next item's to write: as shown, not asked again", async () => {
    const tasks: Array<string> = []
    const approved: Array<string | undefined> = []
    let n = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        approved.push(asker.approved?.())
        if (n++ === 0) yield* asker.owed!("Journey: Agent chat memory lifecycle")
        return outcome("ok")
      }) as never
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([{ id: "x", title: "T", detail: "D", about: [], priority: 1 }]), driver, suggest: () => Effect.succeed([]) })
        yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(80)
      }),
    )
    expect(tasks[1]).toContain("Journey: Agent chat memory lifecycle")
    expect(approved[1]).toBe("Journey: Agent chat memory lifecycle")
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

  test("a render that dies leaves the scenarios out; the driver still runs", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["ST-1"], priority: 1 }]
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, () => Effect.die("plugin bug")); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(tasks[0]).toContain("T\nD")
  })

  test("a render that fails leaves the scenarios out of the task; the driver still runs", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const items: ReadonlyArray<AgendaItem> = [{ id: "x", title: "T", detail: "D", about: ["ST-1"], priority: 1 }]
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver, () => items, () => Effect.fail("boom")); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(tasks[0]).toContain("T\nD")
    expect(tasks[0]).not.toContain("The scenarios around it")
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

  // @scenario S-0012
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

  // @scenario S-0012 S-0102
  test("a message sent while the driver works reaches its next question as discussion: the operator spoke first", async () => {
    const answers: Array<unknown> = []
    let calls = 0
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const driver: Driver = (_spec, asker) =>
          Effect.gen(function* () {
            if (calls++ > 0) return yield* Effect.never
            yield* Deferred.await(gate)
            answers.push(yield* asker.ask(question))
            return outcome("adapted")
          }) as never
        const { thread } = yield* setup(driver)
        const first = yield* Effect.forkChild(collect(thread.run({ runId: "r1" }).pipe(Stream.take(4))))
        yield* Effect.sleep("50 millis")
        const second = yield* Effect.forkChild(collect(thread.run({ runId: "r2", message: "parents reward chores with points" }).pipe(Stream.take(3))))
        yield* Effect.sleep("50 millis")
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(second)
        yield* Effect.sleep("100 millis")
        return yield* Fiber.join(first).pipe(Effect.timeout("1 second"), Effect.option)
      }),
    )
    expect(answers).toEqual([{ other: "parents reward chores with points", interjected: true, question: expect.stringMatching(/^inq-/) }])
    void out
  })

  // @scenario S-0102
  test("an interjection the decision model judges to state a goal for the product is marked so (goal)", async () => {
    const answers: Array<unknown> = []
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ > 0) return yield* Effect.never
        answers.push(yield* asker.ask(question))
        return outcome("adapted")
      }) as never
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zt-goal-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver, isGoal: (text) => Effect.succeed(text.includes("points")) })
        yield* collect(thread.run({ runId: "r1" }))
        return yield* collect(thread.run({ runId: "r2", message: "parents reward chores with points" }).pipe(Stream.take(11)))
      }),
    )
    expect(answers).toEqual([{ other: "parents reward chores with points", interjected: true, question: expect.stringMatching(/^inq-/), goal: true }])
  })

  // @scenario S-0043
  test("a driver item that runs out of turns says so and goes on to the next, never leaving the operator at a dead end", async () => {
    let calls = 0
    const asked: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        calls++
        if (calls === 1) return yield* Effect.fail({ kind: "budget", message: "driver did not finish within its budget (25 turns)" })
        asked.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [{ id: "gherkin:empty", title: "No requirements yet", detail: "d", about: [], priority: 1 }])
        return yield* collect(thread.run({ runId: "r1" }))
      }),
    )
    expect(calls).toBe(2)
    expect(texts(events).join("\n")).toContain("ran out of turns")
    expect(last(events)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })
  })

  // @scenario S-0071
  test("the driver can choose an option of the question under discussion for the operator, once", async () => {
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
        const second = yield* collect(thread.run({ runId: "r2", message: "also add a logout scenario" }))
        return { first: yield* Fiber.join(first), second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_FINISHED", runId: "r1" })
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
    expect(tasks[1]).toContain("operator: also add a logout scenario")
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
    expect(tasks[1]).toStartWith('The operator said: "hi, what can we do?"')
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
    const item: AgendaItem = { id: "gherkin:dead-end:ST-0004", title: "What happens after payment?", detail: "No scenario continues from ST-0004.", about: ["ST-0004"], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1", message: "hello" }))
      }),
    )
    expect(tasks[0]).toStartWith('The operator said: "hello"')
    expect(tasks[1]).toContain("What happens after payment?\nNo scenario continues from ST-0004.")
    expect(tasks[1]).toContain("show the exact change with Inquire.confirm before writing it")
    expect(tasks[1]).toContain("Recent conversation:\noperator: hello\ndriver: Hello! Let's look at the agenda.")
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

  // @scenario S-0044
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

  // @scenario S-0045
  test("secrets are redacted before events are stored or sent", async () => {
    const driver: Driver = (_spec, asker) => Effect.gen(function* () { return (yield* asker.ask({ ...question, question: "use zt-secret?" })) as never }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(JSON.stringify(events)).not.toContain("zt-secret")
    expect(JSON.stringify(events)).toContain("<redacted:ZT>")
  })
})

test("the driver shows every scenario with who acts in it (By), and names by when it writes one", () => {
  expect(REPLY_RULE).toContain("By / Given / When / Then")
  expect(REPLY_RULE).toContain("every scenario names who acts in it with by")
})

// @scenario S-0008
test("the driver shows statements already split: one idea each, never two joined by and", () => {
  expect(REPLY_RULE).toContain("one idea each: split two joined by \"and\" before you show them")
})

// @scenario S-0008
test("the driver never asks again what the operator settled, and names what it asks about by its words", () => {
  expect(REPLY_RULE).toContain("never ask again what the operator settled")
  expect(REPLY_RULE).toContain("by their words, not by ids alone")
})

// @scenario S-0008
test("the driver reads the project before asking what it says, and proposes nothing from neither the operator nor the project", () => {
  expect(REPLY_RULE).toContain("read the project first")
  expect(REPLY_RULE).toContain("never anything from neither")
})

// @scenario S-0102
test("what the operator says the product is for goes into the intent, even mid-question: shown first, then added", () => {
  expect(REPLY_RULE).toContain("add-outcome")
  expect(REPLY_RULE).toContain("add-constraint")
  expect(REPLY_RULE).toMatch(/even while a question of yours is open/)
})

describe("zarg's questions as inbox topics", () => {
  /** A recording inbox: topics raised by the thread, and what it answered, settled and noted. */
  const fakeInbox = () => {
    const calls: Array<unknown> = []
    let n = 0
    const inbox = {
      post: (t: { title: string; answers?: ReadonlyArray<unknown>; key?: string; text?: unknown }) => Effect.sync(() => (calls.push(["post", t]), `T-0000000${++n}`)),
      answer: (id: string, r: unknown, by: string) => Effect.sync(() => void calls.push(["answer", id, r, by])),
      settle: (id: string, why: string) => Effect.sync(() => void calls.push(["settle", id, why])),
      message: (id: string, by: string, text: string) => Effect.sync(() => void calls.push(["message", id, by, text])),
      find: (key: string) => Effect.sync(() => (key.endsWith("inq-old") ? { id: "T-00000099", title: "Old question?", state: "open", answers: [{ id: "a", label: "Old A" }] } : undefined)),
    }
    return { inbox, calls }
  }
  const setupWith = (driver: Driver, inbox: NonNullable<ThreadDeps["inbox"]>) =>
    Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
      const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver, inbox })
      return { log, thread }
    })
  // @scenario S-0098
  test("after a restart, zarg's question still open from before is the one waiting: no new question until it is answered", async () => {
    const { inbox } = fakeInbox()
    let drove = 0
    const driver: Driver = (_spec, asker) => Effect.suspend(() => (drove++, asker.ask(question))) as never
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title: "Old question?" }]) })
        return yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
      }),
    )
    expect(drove).toBe(0)
    expect(events.map((e) => String(e.type))).toContain("RUN_FINISHED")
  })

  // @scenario S-0098
  test("after a restart, an old what-next question is settled and asked afresh: its options are this core's", async () => {
    const { inbox, calls } = fakeInbox()
    let asked = 0
    const whatNext: ThreadDeps["whatNext"] = () => Effect.sync(() => (asked++, [{ id: "build", label: "Build the scenarios", task: "t" }]))
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t)
        const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed([]), driver: () => Effect.succeed(outcome("ok")) as never, suggest: () => Effect.succeed([]), whatNext, inbox: { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title: OPEN_QUESTION }]) } })
        return yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
      }),
    )
    expect(calls).toContainEqual(["settle", "T-00000099", expect.any(String)])
    expect(asked).toBe(1)
    expect(JSON.stringify(events)).toContain("Build the scenarios")
  })

  // @scenario S-0098
  test("after a restart, new work wakes zarg past its old what-next question (settled), never past a real one", async () => {
    const wakeWith = (title: string) => {
      const { inbox, calls } = fakeInbox()
      let drove = 0
      const driver: Driver = () => Effect.sync(() => (drove++, outcome("ok")))
      return Effect.runPromise(
        Effect.gen(function* () {
          const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title }]) })
          yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
          yield* thread.wake
          yield* Effect.sleep(50)
          return { drove, calls }
        }),
      )
    }
    const real = await wakeWith("Old question?")
    expect(real.drove).toBe(0)
    // Once answered, the next wake is free to go on.
    const answered = await (() => {
      const { inbox } = fakeInbox()
      let drove = 0
      const driver: Driver = () => Effect.sync(() => (drove++, outcome("ok")))
      return Effect.runPromise(
        Effect.gen(function* () {
          const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title: "Old question?" }]) })
          yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
          yield* thread.inbox!.answered({ id: "T-00000099", title: "Old question?" }, { answer: "a" })
          yield* Effect.sleep(50)
          const after = drove
          yield* thread.wake
          yield* Effect.sleep(50)
          return { after, drove }
        }),
      )
    })()
    expect(answered.drove).toBeGreaterThan(answered.after)
    const open = await wakeWith(OPEN_QUESTION)
    expect(open.drove).toBeGreaterThan(0)
    expect(open.calls).toContainEqual(["settle", "T-00000099", expect.any(String)])
  })

  // @scenario S-0098
  test("after a restart, answering one of zarg's old questions settles the others: zarg moved on", async () => {
    const { inbox, calls } = fakeInbox()
    const driver: Driver = () => Effect.succeed(outcome("ok"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000098", key: "main|inq-a", title: "First?" }, { id: "T-00000099", key: "main|inq-old", title: "Old question?" }]) })
        yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
        yield* thread.inbox!.answered({ id: "T-00000099", title: "Old question?" }, { answer: "a" })
        yield* Effect.sleep(50)
      }),
    )
    expect(calls).toContainEqual(["settle", "T-00000098", expect.any(String)])
    expect(calls).not.toContainEqual(["settle", "T-00000099", expect.any(String)])
  })

  test("a reply to a question zarg no longer holds (from before a restart) reaches it as a message, and that topic closes", async () => {
    const { inbox, calls } = fakeInbox()
    const said: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (said.push(spec.task), outcome("ok")))
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setupWith(driver, inbox)
        yield* thread.inbox!.replied({ id: "T-00000097", title: "Old question?" }, "make them terminal")
        yield* Effect.sleep(50)
      }),
    )
    expect(said.some((t) => t.includes("make them terminal"))).toBe(true)
    expect(calls).toContainEqual(["settle", "T-00000097", expect.any(String)])
  })

  // @scenario S-0098
  test("after a restart, an answer to zarg's old question counts when it asks that same question again: the operator answers once", async () => {
    const { inbox, calls } = fakeInbox()
    const got: Array<unknown> = []
    let asked = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (asked++ > 0) return yield* Effect.never
        got.push(yield* asker.ask({ question: "Old question?", options: [{ id: "a", label: "Old A" }, { id: "b", label: "B" }] }))
        return outcome("done")
      }) as never
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title: "Old question?" }]) })
        yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
        yield* thread.inbox!.answered({ id: "T-00000099", title: "Old question?", answers: [{ id: "a", label: "Old A" }, { id: "b", label: "B" }] }, { answer: "a" })
        yield* Effect.sleep(80)
      }),
    )
    expect(got).toEqual([{ choice: "a" }])
    expect(calls.filter((c) => (c as Array<unknown>)[0] === "post")).toEqual([])
  })

  // @scenario S-0098
  test("after a restart, Add it on zarg's old proposal hands the change to the next item as added: it writes it without showing it again", async () => {
    const { inbox } = fakeInbox()
    const approvals: Array<string | undefined> = []
    let calls = 0
    const driver: Driver = (_spec, asker) => Effect.sync(() => (calls++ > 0 ? void approvals.push(asker.approved?.()) : undefined, outcome("ok")))
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setupWith(driver, { ...inbox, open: () => Effect.succeed([{ id: "T-00000099", key: "main|inq-old", title: "Add this to the requirements?\n\nAdd outcome: A reader sees what is left" }]) })
        yield* collect(thread.run({ runId: "r1" }).pipe(Stream.takeUntil((e) => e.type === "RUN_FINISHED")))
        yield* thread.inbox!.answered({ id: "T-00000099", title: "Add this to the requirements?\n\nAdd outcome: A reader sees what is left", answers: [{ id: "add", label: "Add it" }, { id: "skip", label: "Skip" }] }, { answer: "add" })
        yield* Effect.sleep(80)
      }),
    )
    expect(approvals[0]).toBe("Add outcome: A reader sees what is left")
  })

  const askOnce = (answers: Array<unknown>): Driver => {
    let calls = 0
    return (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ > 0) return yield* Effect.never
        answers.push(yield* asker.ask({ ...question, about: ["S-0001"] }))
        return outcome("done")
      }) as never
  }

  test("a question is raised as a topic: its options are the answers, its own answer the text, its scenarios the about", async () => {
    const { inbox, calls } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setupWith(askOnce([]), inbox); yield* collect(thread.run({ runId: "r1" })) }))
    expect(calls[0]).toEqual(["post", { kind: "question", title: "Which?", why: "zarg asks", about: ["S-0001"], answers: [{ id: "a", label: "Option A", recommended: true, why: "simpler" }, { id: "b", label: "Option B" }], text: { placeholder: "your own answer" }, key: expect.stringMatching(/^main\|inq-/) }])
  })
  test("answered in the inbox: the driver goes on as if answered in the bar; answered in the bar: the topic is answered too", async () => {
    const viaInbox: Array<unknown> = []
    const a = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce(viaInbox), a.inbox)
      yield* collect(thread.run({ runId: "r1" }))
      yield* thread.inbox!.answered({ id: "T-00000001", title: "Which?", answers: question.options }, { answer: "b" })
      yield* Effect.sleep(50)
    }))
    expect(viaInbox).toEqual([{ choice: "b" }])
    // Answered with a reason: the reason comes along.
    const withReason: Array<unknown> = []
    const c = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce(withReason), c.inbox)
      yield* collect(thread.run({ runId: "r1" }))
      yield* thread.inbox!.answered({ id: "T-00000001", title: "Which?", answers: question.options }, { answer: "b", text: "only on weekdays" })
      yield* Effect.sleep(50)
    }))
    expect(withReason).toEqual([{ choice: "b", other: "only on weekdays" }])
    const viaBar: Array<unknown> = []
    const b = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce(viaBar), b.inbox)
      const first = yield* collect(thread.run({ runId: "r1" }))
      yield* collect(thread.run({ runId: "r2", resume: [{ interruptId: (last(first) as any).outcome.interrupts[0].id, payload: { choice: "a" } }] }).pipe(Stream.take(6)))
    }))
    expect(viaBar).toEqual([{ choice: "a" }])
    expect(b.calls).toContainEqual(["answer", "T-00000001", { answer: "a" }, "operator"])
  })
  test("an answer no question waits for (after a restart) reaches zarg as a message, before the agenda", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("ok"))) as never
    const { inbox } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(driver, inbox)
      yield* thread.inbox!.answered({ id: "T-00000009", title: "Which scenario first?", answers: [{ id: "a", label: "Checkout" }] }, { answer: "a" })
      yield* Effect.sleep(100)
    }))
    expect(tasks.some((t) => t.includes('(you answered "Which scenario first?": Checkout)'))).toBe(true)
  })
  test("a reply in the topic is chat about it: the driver discusses the question; zarg's choice answers the topic as zarg; a stop moots the open ones", async () => {
    const answers: Array<unknown> = []
    const { inbox, calls } = fakeInbox()
    let calls2 = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls2++ > 0) return yield* Effect.never
        const a = yield* asker.ask(question)
        answers.push(a)
        yield* asker.choose!({ question: a.question!, choice: "b", why: "smaller" })
        return outcome("done")
      }) as never
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(driver, inbox)
      yield* collect(thread.run({ runId: "r1" }))
      yield* thread.inbox!.replied({ id: "T-00000001", title: "Which?", answers: question.options }, "which is smaller?")
      yield* Effect.sleep(100)
    }))
    expect(answers).toEqual([{ other: "which is smaller?", interjected: true, question: expect.stringMatching(/^inq-/) }])
    expect(calls).toContainEqual(["answer", "T-00000001", { answer: "b", text: "smaller" }, "zarg"])
    const s = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce([]), s.inbox)
      yield* collect(thread.run({ runId: "r1" }))
      yield* thread.stop
    }))
    expect(s.calls).toContainEqual(["settle", "T-00000001", "zarg was stopped"])
  })
  test("the same question answered in the bar and in the inbox counts once", async () => {
    const answers: Array<unknown> = []
    const tasks: Array<string> = []
    let n = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (n++ > 0) return yield* Effect.never
        answers.push(yield* asker.ask(question))
        return outcome("done")
      }) as never
    const { inbox } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(driver, inbox)
      const first = yield* collect(thread.run({ runId: "r1" }))
      const id = (last(first) as any).outcome.interrupts[0].id
      yield* thread.inbox!.answered({ id: "T-00000001", title: "Which?", answers: question.options }, { answer: "b" })
      yield* Effect.forkChild(collect(thread.run({ runId: "r2", resume: [{ interruptId: id, payload: { choice: "a" } }] })))
      yield* Effect.sleep(100)
    }))
    expect(answers).toEqual([{ choice: "b" }])
    expect(tasks.some((t) => t.includes("The operator said"))).toBe(false)
  })
  test("after a restart the bar's answer to an old question answers its topic and reaches zarg by its label", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec) => Effect.sync(() => (tasks.push(spec.task), outcome("ok"))) as never
    const { inbox, calls } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(driver, inbox)
      yield* collect(thread.run({ runId: "r1", resume: [{ interruptId: "inq-old", payload: { choice: "a" } }] }).pipe(Stream.take(4)))
      yield* Effect.sleep(50)
    }))
    expect(calls).toContainEqual(["answer", "T-00000099", { answer: "a" }, "operator"])
    expect(tasks.some((t) => t.includes('(you answered "Old question?": Old A)'))).toBe(true)
  })
  test("an answer delivered while another question waits is not taken as discussion of it", async () => {
    const answers: Array<unknown> = []
    const { inbox, calls } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce(answers), inbox)
      yield* collect(thread.run({ runId: "r1" }))
      yield* thread.inbox!.answered({ id: "T-00000077", title: "Earlier?", answers: [{ id: "x", label: "X" }] }, { answer: "x" })
      yield* Effect.sleep(100)
    }))
    expect(answers).toEqual([])
    expect(calls.filter((c) => (c as Array<unknown>)[0] === "message")).toEqual([])
  })
  test("a queued question behind the head answered in the inbox resumes its own ask", async () => {
    const { inbox } = fakeInbox()
    const got: Array<unknown> = []
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        const a = yield* Effect.forkChild(asker.ask(question))
        const b = yield* Effect.forkChild(asker.ask({ ...question, question: "Second?" }))
        got.push(yield* Fiber.join(b))
        yield* Fiber.interrupt(a)
        return yield* Effect.never
      }) as never
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(driver, inbox)
      yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
      yield* Effect.sleep(50)
      yield* thread.inbox!.answered({ id: "T-00000002", title: "Second?", answers: question.options }, { answer: "a" })
      yield* Effect.sleep(50)
    }))
    expect(got).toEqual([{ choice: "a" }])
  })
  test("an empty answer of your own in the bar settles the topic (the inbox takes no empty answer)", async () => {
    const { inbox, calls } = fakeInbox()
    await Effect.runPromise(Effect.gen(function* () {
      const { thread } = yield* setupWith(askOnce([]), inbox)
      const first = yield* collect(thread.run({ runId: "r1" }))
      yield* collect(thread.run({ runId: "r2", resume: [{ interruptId: (last(first) as any).outcome.interrupts[0].id, payload: { other: "" } }] }).pipe(Stream.take(4)))
    }))
    expect(calls).toContainEqual(["settle", "T-00000001", "answered in the bar without words"])
  })
})
