import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeTriage, SYSTEM, type TriageDeps } from "../src/triage"
const SYSTEM_TEXT = () => SYSTEM

type Stage = Parameters<TriageDeps["propose"]>[0] extends never ? never : any
const stage = (over: Record<string, unknown>) => ({ journey: "Set up", stage: "refine", proposals: [], draft: [], ...over })
const entry = { id: "F-00000001", ref: "gherkin/scenario:S-0001@abc", kind: "gap", severity: "high", note: "No deny path.", persona: "Operator", on: true, operatorNote: "Deny should say why." }
const offEntry = { id: "F-00000002", ref: "gherkin/scenario:S-0002@abc", kind: "friction", severity: "low", note: "Wordy.", persona: "Operator", on: false }
const setup = (o: { stages: ReadonlyArray<Stage>; answers?: ReadonlyArray<string>; spent?: boolean; workers?: number; reasoning?: boolean; dry?: (n: number, draft: ReadonlyArray<{ tool: string; params: unknown }>) => { ok: boolean; problems: string[]; touched: string[]; scenarios?: string[] }; run?: unknown; result?: unknown; fresh?: boolean; down?: boolean; journeys?: ReadonlyArray<unknown>; atomic?: boolean; decisionsDown?: boolean; code?: boolean }) => {
  const calls: Array<[string, unknown]> = []
  const answers = [...(o.answers ?? [])]
  let dries = 0
  let clock = 0
  const deps: TriageDeps = {
    stages: () => Effect.succeed(o.stages as never),
    feedbackOf: () => Effect.succeed([entry, offEntry]),
    journeys: () => Effect.succeed((o.journeys ?? [{ id: "J-0001", name: "Set up", scenarios: ["S-0001", "S-0002", "S-0003"] }]) as never),
    scene: (scenario) => Effect.succeed({ scenario, title: `scenario ${scenario}`, given: "the plugin runs", when: "it needs a scope", thens: ["the operator is asked"], fork: [], hasFailure: false, ids: { given: "ST-0001", context: [], thens: ["ST-0002"] } }),
    dryRun: (draft) => Effect.succeed({ scenarios: draft.length > 0 ? ["S-0001", "S-0003"] : [], ...(o.dry?.(dries++, draft) ?? { ok: true, problems: [], touched: draft.length > 0 ? ["ST-0002", "S-0001"] : [] }) }),
    complete: (req) => (o.down === true ? Effect.fail("model down") : Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), calls.push(["maxTokens", req.maxTokens]), calls.push(["reasoning", req.reasoning]), o.spent === true ? { text: "", completionTokens: 16384, reasoningTokens: 16384, finishReason: "length" } : { text: answers.shift() ?? "{}" }))),
    propose: (p) => Effect.sync(() => void calls.push(["propose", p])),
    rehearsing: (p) => Effect.sync(() => void calls.push(["rehearsing", p])),
    rehearsed: (p) => Effect.sync(() => void calls.push(["rehearsed", p])),
    drafted: (p) => Effect.sync(() => void calls.push(["drafted", p])),
    plans: (journey, plans) => Effect.sync(() => void calls.push(["plans", { journey, plans }])),
    ...(o.code === true ? { code: (scenario: string) => Effect.succeed([{ file: `src/${scenario}.ts`, line: 3, text: "export const grant = () => ask()" }]) } : {}),
    decide: (req) => (o.decisionsDown === true ? Effect.fail("down") : Effect.sync(() => (calls.push(["decide", req.state]), Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", answer: o.atomic ?? true, confidence: 0.9 }]))))),
    redraft: (p) => Effect.sync(() => void calls.push(["redraft", p])),
    stop: (run) => Effect.sync(() => void calls.push(["stop", run])),
    status: () => Effect.void,
    assign: (journey, worker) => Effect.sync(() => void calls.push(["assign", worker === undefined ? journey : `${journey} → ${worker}`])),
    worker: (id, journey) => Effect.sync(() => void calls.push(["worker", `${id}: ${journey ?? "free"}`])),
    log: (_agent, text) => Effect.sync(() => void calls.push(["log", text])),
    now: Effect.sync(() => (clock += 1500)),
    render: Effect.sync(() => void calls.push(["render", null])),
  }
  const made = makeTriage(deps, o.workers ?? 2, o.reasoning ?? false)
  // A tick hands journeys to workers, which work in the background: wait for them.
  return { t: { ...made, tick: Effect.andThen(made.tick, made.idle) }, calls, deps }
}
const proposalJson = JSON.stringify({ changes: [{ tool: "edit-state", params: { id: "ST-0002", text: "the operator sees: once, always, deny" } }], answers: ["F-00000001"], summary: "Name the choices." })

describe("the Triage Agent", () => {
  test("Refine: a proposal per waiting scenario, from the model, dry-run over the draft so far", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [`Here it is:\n\`\`\`json\n${proposalJson}\n\`\`\``] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("No deny path.")
    // The operator's note says how they want it fixed.
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("Operator's note: Deny should say why.")
    expect(SYSTEM_TEXT()).toContain("operator's notes")
    expect(calls.find(([k]) => k === "propose")?.[1]).toMatchObject({ journey: "Set up", scenario: "S-0001", changes: [{ tool: "edit-state", params: { id: "ST-0002", text: "the operator sees: once, always, deny" } }], answers: ["F-00000001"], summary: "Name the choices." })
  })
  test("a proposal that fails its dry-run is retried once with the problems; still failing, it is shown with them", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson, proposalJson], dry: () => ({ ok: false, problems: ["a clause has if"], touched: [] }) })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "complete").length).toBe(2)
    expect(calls.filter(([k]) => k === "complete")[1]![1]).toContain("a clause has if")
    expect((calls.find(([k]) => k === "propose")![1] as { problems: string[] }).problems).toEqual(["a clause has if"])
  })
  test("a model that answers no JSON twice: the scenario shows no proposal, to be skipped", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: ["sorry", "still no"] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "propose")?.[1]).toMatchObject({ scenario: "S-0001", changes: [], problems: ["the Triage Agent could not draft a proposal"] })
  })
  test("Plan: a round ends in folded plans: the model's concepts, ordered, each with the feedback its scenarios answer", async () => {
    const accepted = (scenario: string, changes: unknown[], answers: string[] = []) => ({ scenario, title: `scenario ${scenario}`, changes, answers, summary: `fix ${scenario}`, status: "accepted" })
    const a = [{ tool: "edit-state", params: { id: "ST-0002", text: "x" } }]
    const b = [{ tool: "edit-scenario", params: { id: "S-0002", when: "y" } }]
    const { t, calls } = setup({ stages: [stage({ stage: "plan", draft: [...a, ...b], inputs: ["F-00000001"], proposals: [accepted("S-0001", a, ["F-00000001"]), accepted("S-0002", b)] })], dry: () => ({ ok: true, problems: [], touched: [], scenarios: [] }), answers: [JSON.stringify({ groups: [{ title: "Name the choices", steps: ["one"], scenarios: ["S-0001"] }, { title: "Say when", steps: ["two"], scenarios: ["S-0002"] }] })] })
    await Effect.runPromise(t.tick)
    const filed = calls.find(([k]) => k === "plans")?.[1] as { journey: string; plans: Array<{ title: string; steps: string[]; scenarios: string[]; changes: unknown[]; feedback: string[]; after: number[] }> }
    expect(filed.journey).toBe("Set up")
    expect(filed.plans).toEqual([
      { title: "Name the choices", steps: ["one"], scenarios: ["S-0001"], changes: a, feedback: ["F-00000001"], after: [] },
      { title: "Say when", steps: ["two"], scenarios: ["S-0002"], changes: b, feedback: [], after: [] },
    ])
    expect(calls.find(([k]) => k === "drafted")).toBeUndefined()
    // Groups of one scenario are atomic without asking.
    expect(calls.find(([k]) => k === "decide")).toBeUndefined()
    expect(calls.filter(([k]) => k === "log").map(([, x]) => x)).toContain("Set up: folded into 2 plans: Name the choices; Say when")
  })
  test("Plan: nothing drafted, no plan; a round of one scenario, one plan", async () => {
    const none = setup({ stages: [stage({ stage: "plan", proposals: [] })] })
    await Effect.runPromise(none.t.tick)
    expect(none.calls.filter(([k]) => k !== "render")).toEqual([])
    const one = setup({ stages: [stage({ stage: "plan", draft: [{ tool: "edit-state", params: {} }], proposals: [{ scenario: "S-0001", changes: [{ tool: "edit-state", params: {} }], answers: [], summary: "s", status: "accepted" }] })], answers: [JSON.stringify({ groups: [{ title: "T", steps: [], scenarios: ["S-0001"] }] })] })
    await Effect.runPromise(one.t.tick)
    expect((one.calls.find(([k]) => k === "plans")?.[1] as { plans: Array<{ after: number[] }> }).plans.map((p) => p.after)).toEqual([[]])
  })
  test("Plan: no usable answer, the structure alone; a group the decision model finds not atomic splits; Decisions down, taken as atomic", async () => {
    const accepted = (scenario: string) => ({ scenario, changes: [{ tool: "edit-scenario", params: { id: scenario } }], answers: [], summary: `fix ${scenario}`, status: "accepted" })
    const round = stage({ stage: "plan", draft: [{ tool: "edit-scenario", params: {} }], proposals: [accepted("S-0001"), accepted("S-0002")] })
    const both = JSON.stringify({ groups: [{ title: "Both", steps: [], scenarios: ["S-0001", "S-0002"] }] })
    const count = async (o: Parameters<typeof setup>[0]) => {
      const s = setup(o)
      await Effect.runPromise(s.t.tick)
      return { n: (s.calls.find(([k]) => k === "plans")?.[1] as { plans: unknown[] }).plans.length, asked: s.calls.some(([k]) => k === "decide") }
    }
    expect(await count({ stages: [round], answers: ["no json"] })).toEqual({ n: 2, asked: false })
    expect(await count({ stages: [round], answers: [both], atomic: false })).toEqual({ n: 2, asked: true })
    expect(await count({ stages: [round], answers: [both] })).toEqual({ n: 1, asked: true })
    expect(await count({ stages: [round], answers: [both], atomic: false, decisionsDown: true })).toEqual({ n: 1, asked: false })
  })
  test("Plan: a plan names every scenario its changes reach (a shared state's scenarios), not only the scenarios drafted", async () => {
    const a = [{ tool: "edit-state", params: { id: "ST-0002", text: "x" } }]
    const b = [{ tool: "edit-scenario", params: { id: "S-0002", when: "y" } }]
    const accepted = (scenario: string, changes: unknown[]) => ({ scenario, changes, answers: [], summary: `fix ${scenario}`, status: "accepted" })
    const reach = (draft: ReadonlyArray<{ tool: string }>) => [...(draft.some((c) => c.tool === "edit-state") ? ["S-0001", "S-0005"] : []), ...(draft.some((c) => c.tool === "edit-scenario") ? ["S-0002"] : [])]
    const { t, calls } = setup({ stages: [stage({ stage: "plan", draft: [...a, ...b], proposals: [accepted("S-0001", a), accepted("S-0002", b)] })], answers: ["no json"], dry: (_n, draft) => ({ ok: true, problems: [], touched: [], scenarios: reach(draft) }) })
    await Effect.runPromise(t.tick)
    const filed = calls.find(([k]) => k === "plans")?.[1] as { plans: Array<{ scenarios: string[] }> }
    expect(filed.plans.map((p) => p.scenarios)).toEqual([["S-0001", "S-0005"], ["S-0002"]])
  })
  test("Plan: a plan that does not dry-run with what it waits on merges into it", async () => {
    const a = [{ tool: "edit-state", params: { id: "ST-0002", text: "x" } }]
    const b = [{ tool: "edit-state", params: { id: "ST-0002", text: "y" } }]
    const accepted = (scenario: string, changes: unknown[]) => ({ scenario, changes, answers: [], summary: `fix ${scenario}`, status: "accepted" })
    // The whole draft dry-runs; the second plan (over the first) does not.
    const { t, calls } = setup({ stages: [stage({ stage: "plan", draft: [...a, ...b], proposals: [accepted("S-0001", a), accepted("S-0002", b)] })], answers: [JSON.stringify({ groups: [{ title: "A", steps: [], scenarios: ["S-0001"] }, { title: "B", steps: [], scenarios: ["S-0002"] }] })], dry: (n) => (n === 2 ? { ok: false, problems: ["clash"], touched: [], scenarios: [] } : { ok: true, problems: [], touched: [], scenarios: [] }) })
    await Effect.runPromise(t.tick)
    const filed = calls.find(([k]) => k === "plans")?.[1] as { plans: Array<{ scenarios: string[] }> }
    expect(filed.plans.map((p) => p.scenarios)).toEqual([["S-0001", "S-0002"]])
  })
  test("each scenario is drafted over the draft as it stands after the last one went in", async () => {
    const waiting = (scenario: string) => ({ scenario, changes: [], answers: [], summary: "", status: "waiting" })
    const first = { tool: "edit-state", params: { id: "ST-0002", text: "the operator sees: once, always, deny" } }
    // The first proposal goes in: the stage has it in the draft from then on.
    let proposed = 0
    const drafts: Array<unknown> = []
    const base = {
      stages: () => Effect.sync(() => (proposed === 0 ? [stage({ proposals: [waiting("S-0001"), waiting("S-0002")] })] : proposed === 1 ? [stage({ proposals: [{ ...waiting("S-0001"), status: "accepted" }, waiting("S-0002")], draft: [first] })] : [stage({ stage: "planned" })]) as never),
      propose: () => Effect.sync(() => void proposed++),
    }
    const s = setup({ stages: [], answers: [proposalJson, proposalJson] })
    const made = makeTriage({ ...s.deps, ...base, dryRun: (d) => Effect.sync(() => (drafts.push(d), { ok: true, problems: [], touched: [], scenarios: [] })) })
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    // The first proposal over the empty draft (1); the second over the draft with the first in it (2); then the draft alone, for the reach guard (1).
    expect(drafts.map((d) => (d as unknown[]).length)).toEqual([1, 2, 1])
  })
  test("its history says what it does: each scenario drafted (into the draft, or left out and why, with what the model said), each run", async () => {
    const waiting = (scenario: string) => ({ scenario, changes: [], answers: [], summary: "", status: "waiting" })
    const a = setup({ stages: [stage({ proposals: [waiting("S-0001")] })], answers: [proposalJson] })
    await Effect.runPromise(a.t.tick)
    const b = setup({ stages: [stage({ proposals: [waiting("S-0001")] })], answers: ["Let me think about the deny path first", "still thinking"] })
    await Effect.runPromise(b.t.tick)
    const c = setup({ stages: [stage({ stage: "plan", proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "s", status: "accepted" }], draft: [{ tool: "edit-state", params: {} }] })], answers: [JSON.stringify({ groups: [{ title: "T", steps: [], scenarios: ["S-0001"] }] })] })
    await Effect.runPromise(c.t.tick)
    const steps = (x: { calls: Array<[string, unknown]> }) => x.calls.filter(([k]) => k === "log").map(([, t]) => t)
    expect(steps(a)).toEqual(["Set up: drafting S-0001 (1 feedback)", "Set up: S-0001 into the draft: Name the choices."])
    expect(steps(b)).toEqual([
      "Set up: drafting S-0001 (1 feedback)",
      "Set up: S-0001: the model did not answer with the JSON asked for: “Let me think about the deny path first”",
      "Set up: S-0001: the model did not answer with the JSON asked for: “still thinking”",
      "Set up: S-0001 left out: the Triage Agent could not draft a proposal",
    ])
    expect(steps(c)).toEqual(["Set up: folded into 1 plan: T"])
  })
  test("an empty answer says how it ended: the budget went on reasoning; answers get room to reason", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], spent: true })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "maxTokens").map(([, n]) => n)).toEqual([16384, 16384])
    expect(calls.filter(([k]) => k === "log").map(([, x]) => x)).toContain("Set up: S-0001: the model gave no answer: it stopped at its token limit (16384 tokens, 16384 of them reasoning)")
  })
  test("stages that wait on the operator, or are done, are left alone", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "triage" }), stage({ stage: "refine", proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "s", status: "proposed" }] }), stage({ stage: "planned" })] })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k !== "render")).toEqual([])
  })
  test("a draft that fails as a whole goes back to Refine before its plan is drafted", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "plan", draft: [{ tool: "add-state", params: {} }, { tool: "add-state", params: {} }] })], dry: () => ({ ok: false, problems: ["two states say the same"], touched: [] }) })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "drafted")).toBeUndefined()
    expect(calls.find(([k]) => k === "redraft")?.[1]).toEqual({ journey: "Set up", problems: ["two states say the same"] })
  })
  test("a model that does not answer leaves the proposal waiting and says why", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], down: true })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "propose")).toBeUndefined()
    expect(calls.find(([k]) => k === "rehearsing")?.[1]).toEqual({ journey: "Set up", note: "The driver model did not answer; the Triage Agent tries again on the next wake." })
  })
  test("the prompt shows link with a scenario and a state, and asks for new states by text", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: ["{}"] })
    await Effect.runPromise(t.tick)
    expect(SYSTEM_TEXT()).toContain('link {"scenario":"S-0001","edge":"then","state":{"text":')
    expect(SYSTEM_TEXT()).toContain("by text")
    expect(calls.length).toBeGreaterThan(0)
  })
  test("each try is recorded (time, tokens, how it ended, what was wrong) and sent with the scenario's title", async () => {
    const waiting = { scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }
    const { t, calls } = setup({ stages: [stage({ proposals: [waiting] })], answers: ["no json here", proposalJson] })
    await Effect.runPromise(t.tick)
    const p = calls.find(([k]) => k === "propose")![1] as { title: string; tries: Array<{ ms: number; problems: string[]; tokensOut: number }> }
    expect(p.title).toBe("scenario S-0001")
    expect(p.tries.map((x) => [x.ms, x.problems])).toEqual([[1500, ["the model did not answer with the JSON asked for"]], [1500, []]])
    // The view follows: it is drawn when a scenario starts and when it is done.
    expect(calls.filter(([k]) => k === "render").length).toBeGreaterThanOrEqual(2)
  })
  test("a scenario drafted again gets what failed before", async () => {
    const again = { scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting", problems: ["S-0001 would have 6 thens; it needs 1-5"] }
    const { t, calls } = setup({ stages: [stage({ proposals: [again] })], answers: [proposalJson] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("Your last proposal for this scenario failed: S-0001 would have 6 thens; it needs 1-5")
  })
  test("paused, it does nothing until resumed", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson] })
    expect(t.pause()).toBe(true)
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "complete")).toEqual([])
    expect(t.pause()).toBe(false)
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "propose").length).toBe(1)
  })
  test("workers take journeys in queue order; one worker takes the next only when it is free", async () => {
    const waiting = (scenario: string) => ({ scenario, changes: [], answers: [], summary: "", status: "waiting" })
    const later = stage({ journey: "Reconcile", queued: 2, proposals: [waiting("S-0002")] })
    const first = stage({ journey: "Set up", queued: 1, proposals: [waiting("S-0001")] })
    const two = setup({ stages: [later, first], answers: [proposalJson, proposalJson] })
    await Effect.runPromise(two.t.tick)
    expect(two.calls.filter(([k]) => k === "assign").map(([, x]) => x).slice(0, 2)).toEqual(["Set up → triage-1", "Reconcile → triage-2"])
    expect(two.calls.filter(([k]) => k === "propose").length).toBe(2)
    const one = setup({ stages: [later, first], answers: [proposalJson, proposalJson], workers: 1 })
    await Effect.runPromise(one.t.tick)
    expect(one.calls.filter(([k]) => k === "assign").map(([, x]) => x)).toEqual(["Set up → triage-1"])
    expect(one.calls.filter(([k]) => k === "propose").map(([, p]) => (p as { journey: string }).journey)).toEqual(["Set up"])
  })
  test("the model answers without reasoning (it ran away on scenarios); [plugins.triage] reasoning = true lets it reason", async () => {
    const waiting = { scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }
    const off = setup({ stages: [stage({ proposals: [waiting] })], answers: [proposalJson] })
    await Effect.runPromise(off.t.tick)
    expect(off.calls.filter(([k]) => k === "reasoning").map(([, r]) => r)).toEqual([{ enabled: false }])
    const on = setup({ stages: [stage({ proposals: [waiting] })], answers: [proposalJson], reasoning: true })
    await Effect.runPromise(on.t.tick)
    expect(on.calls.filter(([k]) => k === "reasoning").map(([, r]) => r)).toEqual([undefined])
  })
  test("a run the round left behind (d, Refine again) is stopped, and forgotten", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "refine", dropRun: "r-old", proposals: [] })] })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "stop" || k === "rehearsing")).toEqual([["stop", "r-old"], ["rehearsing", { journey: "Set up", dropped: true }]])
  })
  test("the prompt names each state by id, and the rules name the mistakes the checks refuse", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson] })
    await Effect.runPromise(t.tick)
    const prompt = calls.find(([k]) => k === "complete")![1] as string
    expect(prompt).toContain("Given the plugin runs  # ST-0001")
    expect(prompt).toContain("Then  the operator is asked  # ST-0002")
    expect(SYSTEM_TEXT()).toContain("add-scenario needs 1-5 then states")
    expect(SYSTEM_TEXT()).toContain("unlink only an edge the scenario has")
    expect(SYSTEM_TEXT()).toContain("reuse its id")
  })
  test("a scenario that failed is drafted again in the same run: the worker goes on while its journey changes", async () => {
    let st = stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })
    const s = setup({ stages: [], answers: ["no json", "still none", proposalJson] })
    const made = makeTriage({
      ...s.deps,
      stages: () => Effect.sync(() => [st] as never),
      // The backlog's settle: a failed round waits again, a proposal goes in.
      propose: (p) => Effect.sync(() => {
        s.calls.push(["propose", p])
        const ok = (p.problems ?? []).length === 0
        const cur = st as unknown as { proposals: Array<{ tries?: unknown[] }> }
        st = { ...st, proposals: [{ ...cur.proposals[0]!, status: ok ? "accepted" : "waiting", tries: [...(cur.proposals[0]!.tries ?? []), ...(p.tries ?? [])] }], ...(ok ? { stage: "rehearse" } : {}) } as never
      }),
    }, 1)
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    expect(s.calls.filter(([k]) => k === "propose").map(([, p]) => ((p as { problems?: string[] }).problems ?? []).length > 0)).toEqual([true, false])
  })
  test("a round still at the old Re-rehearse step: its run is stopped and it moves on to Plan", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "rehearse", run: "r-old", draft: [{ tool: "edit-state", params: {} }] })] })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "stop" || k === "rehearsed").map(([k, v]) => [k, v])).toEqual([["stop", "r-old"], ["rehearsed", { journey: "Set up", resolved: [], fresh: [], next: "plan" }]])
    expect(calls.find(([k]) => k === "run")).toBeUndefined()
  })
  test("a worker lets its journey go as soon as its plan is on the Backlog, without another wake", async () => {
    let st = stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })
    const s = setup({ stages: [], answers: [proposalJson] })
    const made = makeTriage({
      ...s.deps,
      stages: () => Effect.sync(() => [st] as never),
      propose: () => Effect.sync(() => void (st = { ...st, stage: "planned" } as never)),
    }, 1)
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    await Effect.runPromise(made.idle)
    expect(made.state().workers).toEqual([{ id: "triage-1" }])
    expect(s.calls.filter(([k]) => k === "worker").map(([, x]) => x)).toEqual(["triage-1: Set up", "triage-1: free"])
  })
  test("a plan drafted but not on the Backlog (the old Accept step) goes to the Backlog", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "plan", plan: { title: "Setup feedback", steps: ["one"] }, draft: [{ tool: "edit-state", params: {} }] })] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "drafted")?.[1]).toEqual({ journey: "Set up", title: "Setup feedback", steps: ["one"] })
    expect(calls.find(([k]) => k === "complete")).toBeUndefined()
  })
  test("a proposal that reaches scenarios outside its journey (a reworded shared state) fails its try: link a new state instead", async () => {
    const waiting = { scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }
    const s = setup({ stages: [], answers: [proposalJson, proposalJson] })
    const made = makeTriage({
      ...s.deps,
      stages: () => Effect.succeed([stage({ proposals: [waiting] })] as never),
      // The draft so far reaches S-0001; the proposal also reaches S-0050, a scenario of another journey.
      dryRun: (draft) => Effect.succeed({ ok: true, problems: [], touched: [], scenarios: draft.length > 0 ? ["S-0001", "S-0050"] : [] }),
    }, 1)
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    const prompts = s.calls.filter(([k]) => k === "complete").map(([, p]) => p as string)
    expect(prompts[1]).toContain("reaches S-0050, outside Set up (a state it shares): link a new state for S-0001 instead of rewording a shared one")
    expect((s.calls.find(([k]) => k === "propose")![1] as { problems?: string[] }).problems?.[0]).toContain("reaches S-0050")
  })
  test("the proposal prompt carries what zarg does now: the scenario's code", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ scenario: "S-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson], code: true })
    await Effect.runPromise(t.tick)
    const prompt = String(calls.find(([k]) => k === "complete")?.[1])
    expect(prompt).toContain("What zarg does now (the scenario's code):")
    expect(prompt).toContain("export const grant = () => ask()")
  })
})
