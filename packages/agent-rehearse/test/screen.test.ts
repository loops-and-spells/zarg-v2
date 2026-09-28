// packages/core/test/rehearse-screen.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Answer, DecisionRequest } from "../src/types"
import { rehearseSettings } from "../src/settings"
import { screenStep } from "../src/screen"
import type { StepView } from "../src/types"

const s = rehearseSettings({}, "rehearse")
const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })
const score = (score: number): Answer => ({ type: "score", score, level: "fine", probabilities: [], confidence: 0 })
const choice = (ps: Record<string, number>): Answer => ({ type: "choice", choice: Object.keys(ps)[0]!, probabilities: ps, confidence: 0 })
const step = (extra: Partial<StepView> = {}): StepView => ({ card: "UX-1", title: "Pay", given: "the payment form is shown", when: "the visitor pays", thens: ["the order is placed"], fork: [], hasFailure: false, ...extra })
const persona = { name: "developer", text: "The developer, through the zarg TUI" }
const decideWith = (answers: Record<string, Answer>, seen: Array<DecisionRequest> = []) => (req: DecisionRequest) => Effect.sync(() => (seen.push(req), answers))

describe("rehearse screen", () => {
  test("settings default to the calibrated thresholds and auto_apply off", () => {
    expect(s).toEqual({ feelBelow: 1.45, failAt: 0.8, forkBelow: 0.8, seamBelow: 0.3, realKeep: 0.75, realDrop: 0.25, inFlight: 8, autoApply: false, role: "rehearse" })
    expect(rehearseSettings({ feel_below: 1.2, auto_apply: true }, "rehearse")).toMatchObject({ feelBelow: 1.2, autoApply: true })
  })

  test("one request per step: persona, story so far and card; a fine step raises no flag", async () => {
    const seen: Array<DecisionRequest> = []
    const out = await Effect.runPromise(screenStep(decideWith({ feel: score(1.8), fail: noul(0.4), arrive: noul(0.6) }, seen), persona, [step({ card: "UX-0", when: "the visitor checks out", thens: ["the payment form is shown"] })], step(), s))
    expect(out).toEqual({ feel: 1.8, fail: 0.4, arrive: 0.6, flags: [] })
    expect(seen.length).toBe(1)
    expect(seen[0]!.state).toContain("The developer, through the zarg TUI")
    expect(seen[0]!.state).toContain("the visitor checks out")
    expect(seen[0]!.state).toContain("When the visitor pays")
    expect(Object.keys(seen[0]!.questions).sort()).toEqual(["arrive", "fail", "feel"])
  })

  test("flags: a low feel, a likely failure with no failure case, a torn fork, a broken seam", async () => {
    const flags = (answers: Record<string, Answer>, st = step()) => Effect.runPromise(screenStep(decideWith(answers), persona, [], st, s)).then((r) => r?.flags)
    expect(await flags({ feel: score(1.0), fail: noul(0.4), arrive: noul(0.6) })).toEqual(["feel"])
    expect(await flags({ feel: score(1.8), fail: noul(0.85), arrive: noul(0.6) })).toEqual(["fail"])
    expect(await flags({ feel: score(1.8), fail: noul(0.85), arrive: noul(0.6) }, step({ hasFailure: true }))).toEqual([])
    const fork = step({ fork: [{ card: "UX-2", when: "clicks Continue" }, { card: "UX-3", when: "clicks Proceed" }] })
    expect(await flags({ feel: score(1.8), fail: noul(0.4), arrive: noul(0.6), choose: choice({ f0: 0.69, f1: 0.31 }) }, fork)).toEqual(["fork"])
    // A seam needs a step before it.
    expect(await Effect.runPromise(screenStep(decideWith({ feel: score(1.8), fail: noul(0.4), arrive: noul(0.2) }), persona, [step({ card: "UX-0" })], step(), s)).then((r) => r?.flags)).toEqual(["seam"])
    expect(await flags({ feel: score(1.8), fail: noul(0.4), arrive: noul(0.2) })).toEqual([])
  })

  test("a decision-model failure leaves the step unscreened", async () => {
    expect(await Effect.runPromise(screenStep(() => Effect.fail("down"), persona, [], step(), s))).toBeUndefined()
  })

})
