import { describe, expect, test } from "bun:test"
import { current, decide, fresh, slug, startRefine, stepperAt } from "../src/stages"

const on = (id: string, card: string) => ({ id, ref: `gherkin/card:${card}@abc`, triage: { on: true } })
const off = (id: string, card: string) => ({ id, ref: `gherkin/card:${card}@abc`, triage: { on: false } })
const proposed = (card: string, extra: Record<string, unknown> = {}) => ({ card, changes: [{ tool: "edit-card", params: { id: card } }], answers: [], summary: `fix ${card}`, status: "proposed" as const, ...extra })

describe("a journey's stages", () => {
  test("refine starts with a waiting proposal per card whose feedback is on; nothing on is refused", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "UX-0001"), on("F-2", "UX-0001"), off("F-3", "UX-0002"), on("F-4", "UX-0003")])
    expect(typeof s === "string" ? s : s.proposals.map((p) => [p.card, p.status])).toEqual([["UX-0001", "waiting"], ["UX-0003", "waiting"]])
    expect(startRefine(fresh("Set up"), [off("F-3", "UX-0002")])).toBe("nothing on in Set up: turn feedback on first")
  })
  test("accept adds the proposal's changes to the draft; skip does not; the last decision moves to re-rehearse", () => {
    const s = { ...fresh("Set up"), stage: "refine" as const, proposals: [proposed("UX-0001"), proposed("UX-0003")] }
    const a = decide(s, "accept")
    if (typeof a === "string") throw new Error(a)
    expect([a.stage, a.draft.length, current(a)?.card]).toEqual(["refine", 1, "UX-0003"])
    const b = decide(a, "skip")
    if (typeof b === "string") throw new Error(b)
    expect([b.stage, b.draft.length, b.proposals.map((p) => p.status)]).toEqual(["rehearse", 1, ["accepted", "skipped"]])
  })
  test("accept is refused for a proposal with problems, and out of refine", () => {
    expect(decide({ ...fresh("Set up"), stage: "refine", proposals: [proposed("UX-0001", { problems: ["a clause has if"] })] }, "accept")).toBe("UX-0001's proposal has problems: skip it, or wait for a new one")
    expect(decide(fresh("Set up"), "accept")).toBe("Set up is in Triage: nothing to accept")
    expect(decide({ ...fresh("Set up"), stage: "refine", proposals: [{ ...proposed("UX-0001"), status: "waiting" }] }, "accept")).toBe("the Triage Agent is still drafting UX-0001's proposal")
  })
  test("the stepper follows the stage; journey names make safe file names", () => {
    expect(["triage", "refine", "rehearse", "plan", "planned"].map((x) => stepperAt({ ...fresh("x"), stage: x as never }))).toEqual([0, 1, 2, 3, 4])
    expect(slug("Set up / Reconcile!")).toBe("set-up-reconcile")
  })
})
