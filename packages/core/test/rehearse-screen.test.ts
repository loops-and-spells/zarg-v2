// packages/core/test/rehearse-screen.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import { rehearseSettings } from "../src/rehearse/settings"
import { personasOf, screenStep } from "../src/rehearse/screen"
import type { StepView } from "../src/rehearse/types"

const s = rehearseSettings({}, { driver: "stub:d" })
const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })
const score = (score: number): Answer => ({ type: "score", score, level: "fine", probabilities: [], confidence: 0 })
const choice = (ps: Record<string, number>): Answer => ({ type: "choice", choice: Object.keys(ps)[0]!, probabilities: ps, confidence: 0 })
const step = (extra: Partial<StepView> = {}): StepView => ({ card: "UX-1", title: "Pay", given: "the payment form is shown", when: "the visitor pays", thens: ["the order is placed"], fork: [], hasFailure: false, ...extra })
const persona = { name: "developer", text: "The developer, through the zarg TUI" }
const decideWith = (answers: Record<string, Answer>, seen: Array<DecisionRequest> = []) => (req: DecisionRequest) => Effect.sync(() => (seen.push(req), answers))

describe("rehearse screen", () => {
  test("settings default to the calibrated thresholds; the role falls back to the driver's", () => {
    expect(s).toEqual({ feelBelow: 1.45, failAt: 0.8, forkBelow: 0.8, seamBelow: 0.3, realKeep: 0.75, realDrop: 0.25, inFlight: 8, role: "stub:d" })
    expect(rehearseSettings({ rehearse: { feel_below: 1.2 } }, { driver: "d", rehearse: "r" })).toMatchObject({ feelBelow: 1.2, role: "r" })
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

  test("personas: the intent's affected users, without the systems", async () => {
    const md = "# Intent\n\n## Affected users and systems\n\n- The developer, through the zarg TUI (and any AG-UI client).\n- The project's git repository: intents and code.\n\n## Constraints\n\n- x\n"
    const decide = (req: DecisionRequest) => Effect.succeed({ person: noul(req.state.includes("developer") ? 0.9 : 0.1) })
    expect(await Effect.runPromise(personasOf(md, decide))).toEqual([{ name: "The developer", text: "The developer, through the zarg TUI (and any AG-UI client)." }])
  })

  test("two testers never share a name: their answers are kept apart", async () => {
    const md = "## Affected users\n\n- Shoppers, on mobile.\n- Shoppers, on desktop.\n"
    const people = await Effect.runPromise(personasOf(md, () => Effect.succeed({ person: noul(0.9) })))
    expect(people.map((p) => p.name)).toEqual(["Shoppers", "Shoppers (2)"])
  })
})
