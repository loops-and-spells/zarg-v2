import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import { bind, type Bound, defineService } from "@zarg/kernel"
import { DEFAULT_PRESETS, Rlm, settings } from "../src"
import { type Reply, stubModel } from "./stub-model"

const EchoDef = defineService("Echo", "echo", { say: { doc: "echo", params: Schema.Struct({ text: Schema.String }), success: Schema.String } })
const factory = (name: string): Bound | undefined => (name === "Echo" ? bind(EchoDef, { say: (p) => Effect.succeed(p.text) }) : undefined)

/** Decisions stub: "progressing" is answered by `progressing`; every request is kept. */
const decisions = (progressing: boolean, confidence = 0.9) => {
  const calls: Array<DecisionRequest> = []
  return {
    calls,
    service: {
      decide: (req: DecisionRequest) =>
        Effect.sync(() => {
          calls.push(req)
          const a: Answer = { type: "noul", answer: progressing, probability: progressing ? confidence : 1 - confidence, confidence }
          return Object.fromEntries(Object.keys(req.questions).map((k) => [k, a]))
        }),
    },
  }
}

/** The driver preset with a 3-turn budget and Echo; extensions of 2 turns, at most 2. */
const run = (script: ReadonlyArray<Reply>, d: ReturnType<typeof decisions>) => {
  const events: Array<Rlm.RlmEvent> = []
  const stub = stubModel({ driver: script })
  return Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings({ extend: { turns: 2, max: 2 }, presets: { driver: { ...DEFAULT_PRESETS.driver!, layer: ["Echo", "Rlm"], budget: { turns: 3 } } } })
      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
      return yield* Effect.exit(rlm.exec({ task: "t", preset: "driver", scope: {} }))
    }).pipe(Effect.provide(stub.layer)),
  ).then((exit) => ({ exit, events, extends: events.flatMap((e) => (e.type === "extend" ? [e] : [])) }))
}

const work = (n: number): Reply => ({ cell: `return yield* Echo.say({ text: "step ${n}" })` })
const done: Reply = { cell: 'yield* Rlm.done({ value: "ok" })' }

describe("budget extensions", () => {
  test("an agent the decision model judges to be progressing gets more turns and finishes", async () => {
    const r = await run([work(1), work(2), work(3), work(4), done], decisions(true))
    expect(r.exit).toMatchObject({ _tag: "Success", value: { value: "ok", turns: 5 } })
    expect(r.extends).toEqual([expect.objectContaining({ type: "extend", id: "rlm-1", extended: true, turns: 5, confidence: 0.9 })])
  })

  test("an agent judged not to be progressing is told to wrap up at its budget", async () => {
    const r = await run([work(1), work(1), work(1), done], decisions(false))
    expect(r.exit).toMatchObject({ _tag: "Success", value: { turns: 4 } })
    expect(r.extends).toEqual([expect.objectContaining({ extended: false, turns: 3 })])
  })

  test("extensions stop at the maximum, whatever the decision model says", async () => {
    const d = decisions(true)
    const r = await run([work(1)], d)
    expect(r.exit._tag).toBe("Failure")
    expect(r.extends.map((e) => e.turns)).toEqual([5, 7])
    expect(r.events.filter((e) => e.type === "turn").length).toBe(8)
    expect(d.calls.length).toBe(2)
  })

  test("the judgment sees the task, recent cells, failed typechecks and repeated calls", async () => {
    const d = decisions(false)
    await run([work(1), { cell: "return nope(" }, work(1), done], d)
    const state = d.calls[0]!.state
    expect(state).toContain("Task: t")
    expect(state).toContain("step 1")
    expect(state).toContain("cells that failed typecheck: 1 of 3")
    expect(state).toContain("repeated calls: 1 of 2")
  })

  test("without a decision model, the budget is the budget", async () => {
    const stub = stubModel({ driver: [work(1), work(2), work(3), done] })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({ presets: { driver: { ...DEFAULT_PRESETS.driver!, layer: ["Echo", "Rlm"], budget: { turns: 3 } } } })
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000 })
        return yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
      }).pipe(Effect.provide(stub.layer)),
    )
    expect(out.turns).toBe(4)
  })
})
