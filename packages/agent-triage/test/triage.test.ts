import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeTriage, SYSTEM, type TriageDeps } from "../src/triage"
const SYSTEM_TEXT = () => SYSTEM

type Stage = Parameters<TriageDeps["propose"]>[0] extends never ? never : any
const stage = (over: Record<string, unknown>) => ({ journey: "Set up", stage: "refine", proposals: [], draft: [], ...over })
const entry = { id: "F-00000001", ref: "gherkin/card:UX-0001@abc", kind: "gap", severity: "high", note: "No deny path.", persona: "Operator", on: true, operatorNote: "Deny should say why." }
const offEntry = { id: "F-00000002", ref: "gherkin/card:UX-0002@abc", kind: "friction", severity: "low", note: "Wordy.", persona: "Operator", on: false }
const setup = (o: { stages: ReadonlyArray<Stage>; answers?: ReadonlyArray<string>; spent?: boolean; workers?: number; reasoning?: boolean; dry?: (n: number) => { ok: boolean; problems: string[]; touched: string[]; cards?: string[] }; run?: unknown; result?: unknown; fresh?: boolean; down?: boolean; journeys?: ReadonlyArray<unknown> }) => {
  const calls: Array<[string, unknown]> = []
  const answers = [...(o.answers ?? [])]
  let dries = 0
  let clock = 0
  const deps: TriageDeps = {
    stages: () => Effect.succeed(o.stages as never),
    feedbackOf: () => Effect.succeed([entry, offEntry]),
    journeys: () => Effect.succeed((o.journeys ?? [{ id: "J-0001", name: "Set up", cards: ["UX-0001", "UX-0002"] }]) as never),
    step: (card) => Effect.succeed({ card, title: `card ${card}`, given: "the plugin runs", when: "it needs a scope", thens: ["the operator is asked"], fork: [], hasFailure: false, ids: { given: "S-0001", context: [], thens: ["S-0002"] } }),
    dryRun: (draft) => Effect.succeed({ cards: draft.length > 0 ? ["UX-0001", "UX-0003"] : [], ...(o.dry?.(dries++) ?? { ok: true, problems: [], touched: draft.length > 0 ? ["S-0002", "UX-0001"] : [] }) }),
    complete: (req) => (o.down === true ? Effect.fail("model down") : Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), calls.push(["maxTokens", req.maxTokens]), calls.push(["reasoning", req.reasoning]), o.spent === true ? { text: "", completionTokens: 16384, reasoningTokens: 16384, finishReason: "length" } : { text: answers.shift() ?? "{}" }))),
    propose: (p) => Effect.sync(() => void calls.push(["propose", p])),
    rehearsing: (p) => Effect.sync(() => void calls.push(["rehearsing", p])),
    rehearsed: (p) => Effect.sync(() => void calls.push(["rehearsed", p])),
    drafted: (p) => Effect.sync(() => void calls.push(["drafted", p])),
    redraft: (p) => Effect.sync(() => void calls.push(["redraft", p])),
    run: (p) => Effect.sync(() => (calls.push(["run", p]), (o.run ?? { run: "r-9" }) as never)),
    result: () => Effect.succeed((o.result ?? { status: "running", findings: [] }) as never),
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
const proposalJson = JSON.stringify({ changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator sees: once, always, deny" } }], answers: ["F-00000001"], summary: "Name the choices." })

describe("the Triage Agent", () => {
  test("Refine: a proposal per waiting card, from the model, dry-run over the draft so far", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [`Here it is:\n\`\`\`json\n${proposalJson}\n\`\`\``] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("No deny path.")
    // The operator's note says how they want it fixed.
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("Operator's note: Deny should say why.")
    expect(SYSTEM_TEXT()).toContain("operator's notes")
    expect(calls.find(([k]) => k === "propose")?.[1]).toMatchObject({ journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator sees: once, always, deny" } }], answers: ["F-00000001"], summary: "Name the choices." })
  })
  test("a proposal that fails its dry-run is retried once with the problems; still failing, it is shown with them", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson, proposalJson], dry: () => ({ ok: false, problems: ["a clause has if"], touched: [] }) })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "complete").length).toBe(2)
    expect(calls.filter(([k]) => k === "complete")[1]![1]).toContain("a clause has if")
    expect((calls.find(([k]) => k === "propose")![1] as { problems: string[] }).problems).toEqual(["a clause has if"])
  })
  test("a model that answers no JSON twice: the card shows no proposal, to be skipped", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: ["sorry", "still no"] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "propose")?.[1]).toMatchObject({ card: "UX-0001", changes: [], problems: ["the Triage Agent could not draft a proposal"] })
  })
  test("Re-rehearse: walks the journey's and the draft's cards over the draft, filing nothing; another run going: it waits", async () => {
    const draft = [{ tool: "edit-state", params: { id: "S-0002", text: "x" } }]
    const a = setup({ stages: [stage({ stage: "rehearse", draft })] })
    await Effect.runPromise(a.t.tick)
    expect(a.calls.find(([k]) => k === "run")?.[1]).toEqual({ strategy: "journey", focus: ["UX-0001", "UX-0002", "UX-0003"], draft, file: false })
    expect(a.calls.find(([k]) => k === "rehearsing")?.[1]).toEqual({ journey: "Set up", run: "r-9", cards: ["UX-0001", "UX-0003"] })
    const b = setup({ stages: [stage({ stage: "rehearse", draft })], run: { refused: "run r-1 is still going" } })
    await Effect.runPromise(b.t.tick)
    expect(b.calls.find(([k]) => k === "rehearsing")?.[1]).toEqual({ journey: "Set up", clear: true, note: "waits: run r-1 is still going" })
  })
  test("a finished re-rehearse: feedback it no longer reports is resolved; new findings are named; always on to Plan", async () => {
    const clean = setup({ stages: [stage({ stage: "rehearse", run: "r-9", cards: ["UX-0001"] })], result: { status: "done", findings: [{ card: "UX-0002", kind: "gap", severity: "low", note: "meh", on: false }] } })
    await Effect.runPromise(clean.t.tick)
    expect(clean.calls.find(([k]) => k === "rehearsed")?.[1]).toEqual({ journey: "Set up", resolved: ["F-00000001"], fresh: [], next: "plan", cards: ["UX-0001"] })
    // A finding the operator turned off, or dismissed, is not fresh: only a new one sends the journey back.
    const again = setup({ stages: [stage({ stage: "rehearse", run: "r-9", dismissed: [{ card: "UX-0004", kind: "gap" }] })], result: { status: "done", findings: [{ card: "UX-0001", kind: "gap", severity: "high", note: "still no deny", on: true }, { card: "UX-0002", kind: "friction", severity: "medium", note: "off before", on: true }, { card: "UX-0004", kind: "gap", severity: "low", note: "dismissed", on: true }, { card: "UX-0003", kind: "gap", severity: "medium", note: "new", on: true }] } })
    await Effect.runPromise(again.t.tick)
    expect(again.calls.find(([k]) => k === "rehearsed")?.[1]).toEqual({ journey: "Set up", resolved: [], fresh: [{ card: "UX-0003", kind: "gap", severity: "medium", note: "new" }], next: "plan" })
    const going = setup({ stages: [stage({ stage: "rehearse", run: "r-9" })] })
    await Effect.runPromise(going.t.tick)
    expect(going.calls.filter(([k]) => k === "rehearsed")).toEqual([])
  })
  test("Plan: the model drafts a title and steps; without JSON, a plain plan from the accepted proposals", async () => {
    const accepted = [{ card: "UX-0001", changes: [], answers: [], summary: "Name the choices.", status: "accepted" }]
    const draft = [{ tool: "edit-state", params: {} }]
    // Nothing drafted: no plan to write.
    const none = setup({ stages: [stage({ stage: "plan", proposals: [] })] })
    await Effect.runPromise(none.t.tick)
    expect(none.calls.filter(([k]) => k !== "render")).toEqual([])
    const a = setup({ stages: [stage({ stage: "plan", proposals: accepted, draft })], answers: [JSON.stringify({ title: "Grant prompt names its choices", steps: ["Name them"] })] })
    await Effect.runPromise(a.t.tick)
    expect(a.calls.find(([k]) => k === "drafted")?.[1]).toEqual({ journey: "Set up", title: "Grant prompt names its choices", steps: ["Name them"] })
    const b = setup({ stages: [stage({ stage: "plan", proposals: accepted, draft })], answers: ["no"] })
    await Effect.runPromise(b.t.tick)
    expect(b.calls.find(([k]) => k === "drafted")?.[1]).toEqual({ journey: "Set up", title: "Set up: 1 card refined", steps: ["UX-0001: Name the choices."] })
  })
  test("each card is drafted over the draft as it stands after the last one went in", async () => {
    const waiting = (card: string) => ({ card, changes: [], answers: [], summary: "", status: "waiting" })
    const first = { tool: "edit-state", params: { id: "S-0002", text: "the operator sees: once, always, deny" } }
    // The first proposal goes in: the stage has it in the draft from then on.
    let proposed = 0
    const drafts: Array<unknown> = []
    const base = {
      stages: () => Effect.sync(() => (proposed === 0 ? [stage({ proposals: [waiting("UX-0001"), waiting("UX-0002")] })] : proposed === 1 ? [stage({ proposals: [{ ...waiting("UX-0001"), status: "accepted" }, waiting("UX-0002")], draft: [first] })] : [stage({ stage: "planned" })]) as never),
      propose: () => Effect.sync(() => void proposed++),
    }
    const s = setup({ stages: [], answers: [proposalJson, proposalJson] })
    const made = makeTriage({ ...s.deps, ...base, dryRun: (d) => Effect.sync(() => (drafts.push(d), { ok: true, problems: [], touched: [], cards: [] })) })
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    expect(drafts.map((d) => (d as unknown[]).length)).toEqual([1, 2])
  })
  test("its history says what it does: each card drafted (into the draft, or left out and why, with what the model said), each run", async () => {
    const waiting = (card: string) => ({ card, changes: [], answers: [], summary: "", status: "waiting" })
    const a = setup({ stages: [stage({ proposals: [waiting("UX-0001")] })], answers: [proposalJson] })
    await Effect.runPromise(a.t.tick)
    const b = setup({ stages: [stage({ proposals: [waiting("UX-0001")] })], answers: ["Let me think about the deny path first", "still thinking"] })
    await Effect.runPromise(b.t.tick)
    const c = setup({ stages: [stage({ stage: "rehearse", draft: [{ tool: "edit-state", params: {} }] })] })
    await Effect.runPromise(c.t.tick)
    const steps = (x: { calls: Array<[string, unknown]> }) => x.calls.filter(([k]) => k === "log").map(([, t]) => t)
    expect(steps(a)).toEqual(["Set up: drafting UX-0001 (1 feedback)", "Set up: UX-0001 into the draft: Name the choices."])
    expect(steps(b)).toEqual([
      "Set up: drafting UX-0001 (1 feedback)",
      "Set up: UX-0001: the model did not answer with the JSON asked for: “Let me think about the deny path first”",
      "Set up: UX-0001: the model did not answer with the JSON asked for: “still thinking”",
      "Set up: UX-0001 left out: the Triage Agent could not draft a proposal",
    ])
    expect(steps(c)).toEqual(["Set up: re-rehearsing on 3 cards (run r-9)"])
  })
  test("an empty answer says how it ended: the budget went on reasoning; answers get room to reason", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], spent: true })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "maxTokens").map(([, n]) => n)).toEqual([16384, 16384])
    expect(calls.filter(([k]) => k === "log").map(([, x]) => x)).toContain("Set up: UX-0001: the model gave no answer: it stopped at its token limit (16384 tokens, 16384 of them reasoning)")
  })
  test("stages that wait on the operator, or are done, are left alone", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "triage" }), stage({ stage: "refine", proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "s", status: "proposed" }] }), stage({ stage: "plan", plan: { title: "t", steps: [] } }), stage({ stage: "planned" })] })
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k !== "render")).toEqual([])
  })
  test("a stopped re-rehearse starts again; the agent never waits on a dead run", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "rehearse", run: "r-8", draft: [{ tool: "edit-state", params: {} }] })], result: { status: "stopped", findings: [] } })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "run")).toBeDefined()
    expect(calls.find(([k]) => k === "rehearsing")?.[1]).toMatchObject({ journey: "Set up", run: "r-9" })
  })
  test("an accepted draft that fails as a whole goes back to Refine before any run", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "rehearse", draft: [{ tool: "add-state", params: {} }, { tool: "add-state", params: {} }] })], dry: () => ({ ok: false, problems: ["two states say the same"], touched: [] }) })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "run")).toBeUndefined()
    expect(calls.find(([k]) => k === "redraft")?.[1]).toEqual({ journey: "Set up", problems: ["two states say the same"] })
  })
  test("nothing to walk (no journey cards, no cards changed): straight to Plan", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "rehearse", journey: "—", draft: [] })], journeys: [] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "run")).toBeUndefined()
    expect(calls.find(([k]) => k === "rehearsed")?.[1]).toEqual({ journey: "—", resolved: [], fresh: [], next: "plan", cards: [] })
  })
  test("a model that does not answer leaves the proposal waiting and says why", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], down: true })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "propose")).toBeUndefined()
    expect(calls.find(([k]) => k === "rehearsing")?.[1]).toEqual({ journey: "Set up", note: "The driver model did not answer; the Triage Agent tries again on the next wake." })
  })
  test("the prompt shows link with a card and a state, and asks for new states by text", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: ["{}"] })
    await Effect.runPromise(t.tick)
    expect(SYSTEM_TEXT()).toContain('link {"card":"UX-0001","edge":"then","state":{"text":')
    expect(SYSTEM_TEXT()).toContain("by text")
    expect(calls.length).toBeGreaterThan(0)
  })
  test("each try is recorded (time, tokens, how it ended, what was wrong) and sent with the card's title", async () => {
    const waiting = { card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }
    const { t, calls } = setup({ stages: [stage({ proposals: [waiting] })], answers: ["no json here", proposalJson] })
    await Effect.runPromise(t.tick)
    const p = calls.find(([k]) => k === "propose")![1] as { title: string; tries: Array<{ ms: number; problems: string[]; tokensOut: number }> }
    expect(p.title).toBe("card UX-0001")
    expect(p.tries.map((x) => [x.ms, x.problems])).toEqual([[1500, ["the model did not answer with the JSON asked for"]], [1500, []]])
    // The view follows: it is drawn when a card starts and when it is done.
    expect(calls.filter(([k]) => k === "render").length).toBeGreaterThanOrEqual(2)
  })
  test("a card drafted again gets what failed before", async () => {
    const again = { card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting", problems: ["UX-0001 would have 6 thens; it needs 1-5"] }
    const { t, calls } = setup({ stages: [stage({ proposals: [again] })], answers: [proposalJson] })
    await Effect.runPromise(t.tick)
    expect(calls.find(([k]) => k === "complete")?.[1]).toContain("Your last proposal for this card failed: UX-0001 would have 6 thens; it needs 1-5")
  })
  test("paused, it does nothing until resumed", async () => {
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson] })
    expect(t.pause()).toBe(true)
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "complete")).toEqual([])
    expect(t.pause()).toBe(false)
    await Effect.runPromise(t.tick)
    expect(calls.filter(([k]) => k === "propose").length).toBe(1)
  })
  test("workers take journeys in queue order; one worker takes the next only when it is free", async () => {
    const waiting = (card: string) => ({ card, changes: [], answers: [], summary: "", status: "waiting" })
    const later = stage({ journey: "Reconcile", queued: 2, proposals: [waiting("UX-0002")] })
    const first = stage({ journey: "Set up", queued: 1, proposals: [waiting("UX-0001")] })
    const two = setup({ stages: [later, first], answers: [proposalJson, proposalJson] })
    await Effect.runPromise(two.t.tick)
    expect(two.calls.filter(([k]) => k === "assign").map(([, x]) => x).slice(0, 2)).toEqual(["Set up → triage-1", "Reconcile → triage-2"])
    expect(two.calls.filter(([k]) => k === "propose").length).toBe(2)
    const one = setup({ stages: [later, first], answers: [proposalJson, proposalJson], workers: 1 })
    await Effect.runPromise(one.t.tick)
    expect(one.calls.filter(([k]) => k === "assign").map(([, x]) => x)).toEqual(["Set up → triage-1"])
    expect(one.calls.filter(([k]) => k === "propose").map(([, p]) => (p as { journey: string }).journey)).toEqual(["Set up"])
  })
  test("a worker lets its journey go once it needs nothing more", async () => {
    let n = 0
    const waiting = { card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }
    const s = setup({ stages: [], answers: [proposalJson] })
    const made = makeTriage({ ...s.deps, stages: () => Effect.sync(() => (n++ < 4 ? [stage({ proposals: [waiting] })] : [stage({ stage: "planned" })]) as never) }, 1)
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    expect(made.state().workers).toEqual([{ id: "triage-1", journey: "Set up" }])
    await Effect.runPromise(Effect.andThen(made.tick, made.idle))
    expect(made.state().workers).toEqual([{ id: "triage-1" }])
    expect(s.calls.filter(([k]) => k === "worker").map(([, x]) => x)).toEqual(["triage-1: Set up", "triage-1: free"])
  })
  test("the model answers without reasoning (it ran away on cards); [plugins.triage] reasoning = true lets it reason", async () => {
    const waiting = { card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }
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
    const { t, calls } = setup({ stages: [stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })], answers: [proposalJson] })
    await Effect.runPromise(t.tick)
    const prompt = calls.find(([k]) => k === "complete")![1] as string
    expect(prompt).toContain("Given the plugin runs  # S-0001")
    expect(prompt).toContain("Then  the operator is asked  # S-0002")
    expect(SYSTEM_TEXT()).toContain("add-card needs 1-5 then states")
    expect(SYSTEM_TEXT()).toContain("unlink only an edge the card has")
    expect(SYSTEM_TEXT()).toContain("reuse its id")
  })
  test("a card that failed is drafted again in the same run: the worker goes on while its journey changes", async () => {
    let st = stage({ proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "", status: "waiting" }] })
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
})
