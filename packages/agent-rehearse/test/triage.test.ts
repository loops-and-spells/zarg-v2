// packages/core/test/rehearse-triage.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Answer } from "../src/types"
import { rehearseSettings } from "../src/settings"
import { triage } from "../src/triage"
import type { Finding } from "../src/types"

const s = rehearseSettings({}, "rehearse")
const f: Finding = { id: "R-00000001", kind: "gap", scenario: "S-1", severity: "high", notes: ["payment can fail silently"], count: 1, personas: ["developer"] }
const step = { scenario: "S-1", title: "Pay", given: "the payment form is shown", when: "the visitor pays", thens: ["the order is placed"], fork: [], hasFailure: false }
const answers = (real: number, route: string) => () =>
  Effect.succeed({ real: { type: "noul", answer: real >= 0.5, probability: real, confidence: 0 }, route: { type: "choice", choice: route, probabilities: { [route]: 1 }, confidence: 1 } } as Record<string, Answer>)

describe("rehearse triage", () => {
  test("a real local fix is fixed; a product decision is asked; a doubtful one is asked; an unreal one is dropped", async () => {
    const t = (real: number, route: string, built = false, st: typeof step | undefined = step) => Effect.runPromise(triage(answers(real, route), f, st, built, s)).then((x) => x.route)
    expect(await t(0.9, "fix")).toBe("fix")
    expect(await t(0.9, "decide")).toBe("ask")
    expect(await t(0.5, "fix")).toBe("ask")
    expect(await t(0.1, "fix")).toBe("drop")
    expect(await t(0.9, "noise")).toBe("drop")
  })

  test("removing or changing a scenario that has code is always asked; a scenario gone since the run is dropped", async () => {
    expect((await Effect.runPromise(triage(answers(0.9, "removes"), f, step, true, s))).route).toBe("ask")
    expect((await Effect.runPromise(triage(answers(0.9, "fix"), f, undefined, false, s))).route).toBe("drop")
  })

  test("a drift is the operator's call: scenario or code (asked, never fixed by the agent)", async () => {
    expect((await Effect.runPromise(triage(answers(0.9, "fix"), { ...f, kind: "drift" }, step, false, s))).route).toBe("ask")
  })
  test("delights and features are never fixed", async () => {
    for (const kind of ["delight", "feature"] as const) {
      expect((await Effect.runPromise(triage(answers(0.9, "fix"), { ...f, kind }, step, false, s))).route).toBe(kind === "feature" ? "ask" : "drop")
    }
  })
})
