import { describe, expect, test } from "bun:test"
import { fresh, redraft, refineAgain, settle, slug, type Stage, stageActions, startRefine, stepperAt } from "../src/stages"

const on = (id: string, card: string) => ({ id, ref: `gherkin/card:${card}@abc`, triage: { on: true } })
const off = (id: string, card: string) => ({ id, ref: `gherkin/card:${card}@abc`, triage: { on: false } })
const proposed = (card: string, extra: Record<string, unknown> = {}) => ({ card, changes: [{ tool: "edit-card", params: { id: card } }], answers: [], summary: `fix ${card}`, status: "proposed" as const, ...extra })

describe("a journey's stages", () => {
  test("refine starts with a waiting proposal per card whose feedback is on; nothing on is refused", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "UX-0001"), on("F-2", "UX-0001"), off("F-3", "UX-0002"), on("F-4", "UX-0003")])
    expect(typeof s === "string" ? s : s.proposals.map((p) => [p.card, p.status])).toEqual([["UX-0001", "waiting"], ["UX-0003", "waiting"]])
    expect(startRefine(fresh("Set up"), [off("F-3", "UX-0002")])).toBe("nothing on in Set up: turn feedback on first")
  })
  test("each proposal goes into the draft as it comes, or is left out with its problems; the last one moves on", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "UX-0001"), on("F-4", "UX-0003")]) as Stage
    const a = settle(s, { card: "UX-0001", changes: [{ tool: "edit-card", params: { id: "UX-0001" } }], answers: ["F-1"], summary: "fix UX-0001" })
    expect([a.stage, a.draft.length, a.proposals.map((p) => p.status)]).toEqual(["refine", 1, ["accepted", "waiting"]])
    const b = settle(a, { card: "UX-0003", changes: [{ tool: "edit-card", params: {} }], answers: [], summary: "", problems: ["a clause has if"] })
    expect([b.stage, b.draft.length, b.proposals.map((p) => p.status), b.proposals[1]!.problems]).toEqual(["rehearse", 1, ["accepted", "skipped"], ["a clause has if"]])
  })
  test("every proposal left out: straight to Plan, nothing to re-rehearse", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "UX-0001")]) as Stage
    expect(settle(s, { card: "UX-0001", changes: [], answers: [], summary: "", problems: ["no proposal"] }).stage).toBe("plan")
  })
  test("the buttons each stage offers", () => {
    const at = (stage: Stage["stage"], extra: Partial<Stage> = {}) => stageActions({ ...fresh("x"), stage, ...extra })
    expect([at("triage"), at("refine"), at("rehearse"), at("plan"), at("plan", { plan: { title: "t", steps: [] } }), at("planned")]).toEqual([["refine"], [], ["refine"], ["refine"], ["accept", "refine"], ["refine"]])
  })
  test("the stepper follows the stage; journey names make safe file names", () => {
    expect(["triage", "refine", "rehearse", "plan", "planned"].map((x) => stepperAt({ ...fresh("x"), stage: x as never }))).toEqual([0, 1, 2, 3, 4])
    expect(slug("Set up / Reconcile!")).toMatch(/^set-up-reconcile-[0-9a-f]{6}$/)
    expect(slug("Log in")).not.toBe(slug("Log-in"))
  })
  test("refine remembers the entries it started from", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "UX-0001")])
    expect(typeof s === "string" ? s : s.inputs).toEqual(["F-1"])
  })
  test("Refine again from Plan: the cards whose feedback is on and not resolved, over the draft so far", () => {
    const s: Stage = { ...fresh("Set up"), stage: "plan", plan: { title: "t", steps: [] }, results: { resolved: ["F-1"], fresh: [] }, proposals: [{ ...proposed("UX-0001"), status: "accepted" }], draft: [{ tool: "edit-card", params: {} }], inputs: ["F-1"] }
    const again = refineAgain(s, [on("F-1", "UX-0001"), on("F-2", "UX-0003")])
    expect(typeof again === "string" ? again : [again.stage, again.proposals.map((p) => [p.card, p.status]), again.draft.length, again.plan, again.results, again.inputs]).toEqual(["refine", [["UX-0001", "accepted"], ["UX-0003", "waiting"]], 1, undefined, undefined, ["F-1", "F-2"]])
    expect(refineAgain(s, [on("F-1", "UX-0001")])).toBe("nothing left to refine in Set up: a accepts the plan")
  })
  test("Refine again while a re-rehearse hangs: the run is dropped, every card on is refined again", () => {
    const s: Stage = { ...fresh("Set up"), stage: "rehearse", run: "r-1", note: "waits", proposals: [{ ...proposed("UX-0001"), status: "accepted" }], draft: [{ tool: "edit-card", params: {} }] }
    const again = refineAgain(s, [on("F-1", "UX-0001")])
    expect(typeof again === "string" ? again : [again.stage, again.run, again.note, again.proposals.map((p) => p.status)]).toEqual(["refine", undefined, undefined, ["accepted", "waiting"]])
    expect(refineAgain({ ...fresh("Set up"), stage: "refine" }, [on("F-1", "UX-0001")])).toBe("Set up is being refined already")
  })
  test("a draft that fails as a whole is drafted again once; a second failure leaves its changes out and goes to Plan", () => {
    const s: Stage = { ...fresh("Set up"), stage: "rehearse", proposals: [{ ...proposed("UX-0001"), status: "accepted" }, { ...proposed("UX-0003"), status: "skipped" }], draft: [{ tool: "x", params: {} }] }
    const r = redraft(s, ["two states say the same"])
    expect([r.stage, r.draft, r.proposals.map((p) => p.status), r.redrafts]).toEqual(["refine", [], ["waiting", "skipped"], 1])
    const r2 = redraft({ ...r, stage: "rehearse", proposals: r.proposals.map((p) => ({ ...p, status: p.status === "waiting" ? ("accepted" as const) : p.status })), draft: [{ tool: "x", params: {} }] }, ["still"])
    expect([r2.stage, r2.draft, r2.proposals.map((p) => [p.status, p.problems])]).toEqual(["plan", [], [["skipped", ["still"]], ["skipped", undefined]]])
  })
})
