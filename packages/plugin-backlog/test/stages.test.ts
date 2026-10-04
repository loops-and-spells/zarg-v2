import { describe, expect, test } from "bun:test"
import { fresh, inTriage, nextQueued, redo, redraft, refineAgain, settle, slug, type Stage, stageActions, stageLabel, startRefine, stepperAt } from "../src/stages"

const on = (id: string, scenario: string) => ({ id, ref: `gherkin/scenario:${scenario}@abc`, triage: { on: true } })
const off = (id: string, scenario: string) => ({ id, ref: `gherkin/scenario:${scenario}@abc`, triage: { on: false } })
const proposed = (scenario: string, extra: Record<string, unknown> = {}) => ({ scenario, changes: [{ tool: "edit-scenario", params: { id: scenario } }], answers: [], summary: `fix ${scenario}`, status: "proposed" as const, ...extra })

describe("a journey's stages", () => {
  // @scenario S-0108 S-0109
  test("refine starts with a waiting proposal per scenario whose feedback is on; nothing on is refused", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "S-0001"), on("F-2", "S-0001"), off("F-3", "S-0002"), on("F-4", "S-0003")])
    expect(typeof s === "string" ? s : s.proposals.map((p) => [p.scenario, p.status])).toEqual([["S-0001", "waiting"], ["S-0003", "waiting"]])
    expect(startRefine(fresh("Set up"), [off("F-3", "S-0002")])).toBe("nothing on in Set up: turn feedback on first")
  })
  test("each proposal goes into the draft as it comes, or is left out with its problems; the last one moves on", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "S-0001"), on("F-4", "S-0003")]) as Stage
    const a = settle(s, { scenario: "S-0001", changes: [{ tool: "edit-scenario", params: { id: "S-0001" } }], answers: ["F-1"], summary: "fix S-0001" })
    expect([a.stage, a.draft.length, a.proposals.map((p) => p.status)]).toEqual(["refine", 1, ["accepted", "waiting"]])
    // Its last round (it failed twice before): left out.
    const last = { ...a, proposals: a.proposals.map((p) => (p.scenario === "S-0003" ? { ...p, rounds: 2 } : p)) }
    const b = settle(last, { scenario: "S-0003", changes: [{ tool: "edit-scenario", params: {} }], answers: [], summary: "", problems: ["a clause has if"] })
    // Every scenario decided: on to Plan (the plan is drafted and goes to the Backlog).
    expect([b.stage, b.draft.length, b.proposals.map((p) => p.status), b.proposals[1]!.problems]).toEqual(["plan", 1, ["accepted", "skipped"], ["a clause has if"]])
  })
  test("every proposal left out: back to Triage, nothing goes to the Backlog", () => {
    const s0 = startRefine(fresh("Set up"), [on("F-1", "S-0001")]) as Stage
    const s = { ...s0, proposals: s0.proposals.map((p) => ({ ...p, rounds: 2 })) }
    const back = settle(s, { scenario: "S-0001", changes: [], answers: [], summary: "", problems: ["no proposal"] })
    expect([back.stage, back.note]).toEqual(["triage", "Nothing drafted: every scenario was left out. Refine to try again."])
  })
  test("the buttons each stage offers", () => {
    const at = (stage: Stage["stage"], extra: Partial<Stage> = {}) => stageActions({ ...fresh("x"), stage, ...extra })
    expect([at("triage"), at("refine"), at("rehearse"), at("plan"), at("planned")]).toEqual([["refine"], [], [], [], ["refine"]])
  })
  test("the stepper follows the stage; journey names make safe file names", () => {
    // Triage ─ Refine ─ Backlog.
    expect(["triage", "refine", "rehearse", "plan", "planned"].map((x) => stepperAt({ ...fresh("x"), stage: x as never }))).toEqual([0, 1, 1, 1, 2])
    expect(slug("Set up / Reconcile!")).toMatch(/^set-up-reconcile-[0-9a-f]{6}$/)
    expect(slug("Log in")).not.toBe(slug("Log-in"))
  })
  test("refine remembers the entries it started from", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "S-0001")])
    expect(typeof s === "string" ? s : s.inputs).toEqual(["F-1"])
  })
  test("Refine again from Plan: the scenarios whose feedback is on and not resolved, over the draft so far", () => {
    const s: Stage = { ...fresh("Set up"), stage: "plan", plan: { title: "t", steps: [] }, results: { resolved: ["F-1"], fresh: [] }, proposals: [{ ...proposed("S-0001"), status: "accepted" }], draft: [{ tool: "edit-scenario", params: {} }], inputs: ["F-1"] }
    const again = refineAgain(s, [on("F-1", "S-0001"), on("F-2", "S-0003")])
    expect(typeof again === "string" ? again : [again.stage, again.proposals.map((p) => [p.scenario, p.status]), again.draft.length, again.plan, again.results, again.inputs]).toEqual(["refine", [["S-0001", "accepted"], ["S-0003", "waiting"]], 1, undefined, undefined, ["F-1", "F-2"]])
    expect(refineAgain(s, [on("F-1", "S-0001")])).toBe("nothing left to refine in Set up: a accepts the plan")
  })
  test("Refine again while a re-rehearse hangs: the run is dropped, every scenario on is refined again", () => {
    const s: Stage = { ...fresh("Set up"), stage: "rehearse", run: "r-1", note: "waits", proposals: [{ ...proposed("S-0001"), status: "accepted" }], draft: [{ tool: "edit-scenario", params: {} }] }
    const again = refineAgain(s, [on("F-1", "S-0001")])
    expect(typeof again === "string" ? again : [again.stage, again.run, again.note, again.proposals.map((p) => p.status)]).toEqual(["refine", undefined, undefined, ["accepted", "waiting"]])
    expect(refineAgain({ ...fresh("Set up"), stage: "refine" }, [on("F-1", "S-0001")])).toBe("Set up is being refined already")
  })
  test("a draft that fails as a whole is drafted again once; a second failure leaves its changes out and goes to Plan", () => {
    const s: Stage = { ...fresh("Set up"), stage: "rehearse", proposals: [{ ...proposed("S-0001"), status: "accepted" }, { ...proposed("S-0003"), status: "skipped" }], draft: [{ tool: "x", params: {} }] }
    const r = redraft(s, ["two states say the same"])
    expect([r.stage, r.draft, r.proposals.map((p) => p.status), r.redrafts]).toEqual(["refine", [], ["waiting", "skipped"], 1])
    const r2 = redraft({ ...r, stage: "rehearse", proposals: r.proposals.map((p) => ({ ...p, status: p.status === "waiting" ? ("accepted" as const) : p.status })), draft: [{ tool: "x", params: {} }] }, ["still"])
    expect([r2.stage, r2.draft, r2.proposals.map((p) => [p.status, p.problems])]).toEqual(["plan", [], [["skipped", ["still"]], ["skipped", undefined]]])
  })
  test("a proposal keeps its tries and the scenario's title", () => {
    const s = startRefine(fresh("Set up"), [on("F-1", "S-0001")]) as Stage
    const tries = [{ ms: 1200, tokensIn: 900, tokensOut: 400, reasoning: 300, finish: "stop", problems: [] }]
    const a = settle(s, { scenario: "S-0001", title: "Plugin asks", changes: [{ tool: "edit-scenario", params: {} }], answers: [], summary: "s", tries })
    expect([a.proposals[0]!.tries, a.proposals[0]!.title]).toEqual([tries, "Plugin asks"])
  })
  test("drafting one scenario again: it waits again with what failed, its changes leave the draft, the round goes back to Refine", () => {
    const one = { tool: "edit-scenario", params: { id: "S-0001" } }
    const two = { tool: "edit-scenario", params: { id: "S-0003" } }
    const s: Stage = { ...fresh("Set up"), stage: "plan", plan: { title: "t", steps: [] }, results: { resolved: [], fresh: [] }, draft: [one, two], proposals: [{ ...proposed("S-0001"), changes: [one], status: "accepted" }, { ...proposed("S-0003"), changes: [two], status: "accepted" }, { ...proposed("S-0004"), status: "skipped", problems: ["6 thens"] }] }
    const a = redo(s, "S-0001")
    expect(typeof a === "string" ? a : [a.stage, a.draft, a.plan, a.results, a.proposals.map((p) => p.status)]).toEqual(["refine", [two], undefined, undefined, ["waiting", "accepted", "skipped"]])
    const b = redo(s, "S-0004")
    expect(typeof b === "string" ? b : [b.proposals[2]!.status, b.proposals[2]!.problems, b.draft.length]).toEqual(["waiting", ["6 thens"], 2])
    expect(redo(s, "S-0099")).toBe("S-0099 is not in Set up's round")
    expect(redo(fresh("Set up"), "S-0001")).toBe("Set up has no round to draft again")
  })
  test("a journey queued for triage: its place in line, then the worker on it; its feedback is read-only until Plan", () => {
    const a = { ...(startRefine(fresh("Set up"), [on("F-1", "S-0001")]) as Stage), queued: 1 }
    const b = { ...(startRefine(fresh("Reconcile"), [on("F-2", "S-0003")]) as Stage), queued: 2 }
    expect(nextQueued([a, b])).toBe(3)
    expect([stageLabel(a, [a, b]), stageLabel(b, [a, b])]).toEqual(["queued #1", "queued #2"])
    const working = { ...a, worker: "triage-1", proposals: [{ ...a.proposals[0]!, status: "accepted" as const }, ...a.proposals] }
    expect(stageLabel(working, [working, b])).toBe("triage-1 · Refine 1/2 scenarios")
    expect(stageLabel(b, [working, b])).toBe("queued #1")
    expect(stageLabel({ ...working, stage: "rehearse" }, [])).toBe("triage-1 · Re-rehearse")
    expect(["triage", "refine", "rehearse", "plan", "planned"].map((x) => inTriage({ ...a, stage: x as Stage["stage"] }))).toEqual([false, true, true, true, false])
  })
  test("leaving Re-rehearse (d, or Refine again) keeps its run to stop: the testers must not walk an old draft", () => {
    const s: Stage = { ...fresh("Set up"), stage: "rehearse", run: "r-9", draft: [{ tool: "x", params: {} }], proposals: [{ ...proposed("S-0001"), status: "accepted" }] }
    const a = redo(s, "S-0001")
    const b = refineAgain(s, [on("F-1", "S-0001")])
    expect([typeof a === "string" ? a : [a.run, a.dropRun], typeof b === "string" ? b : [b.run, b.dropRun]]).toEqual([[undefined, "r-9"], [undefined, "r-9"]])
  })
  test("a scenario that fails is drafted again on its own, up to 3 rounds, keeping every try; then it is left out", () => {
    const s0 = startRefine(fresh("Set up"), [on("F-1", "S-0001")]) as Stage
    const fail = (s: Stage) => settle(s, { scenario: "S-0001", changes: [], answers: [], summary: "", problems: ["6 thens"], tries: [{ ms: 1, tokensIn: 1, tokensOut: 1, reasoning: 0, problems: ["6 thens"] }] })
    const r1 = fail(s0)
    const r2 = fail(r1)
    const r3 = fail(r2)
    expect([r1, r2, r3].map((s) => [s.stage, s.proposals[0]!.status, s.proposals[0]!.rounds, s.proposals[0]!.tries?.length])).toEqual([
      ["refine", "waiting", 1, 1],
      ["refine", "waiting", 2, 2],
      ["triage", "skipped", 3, 3],
    ])
    expect(r1.proposals[0]!.problems).toEqual(["6 thens"])
  })
})
