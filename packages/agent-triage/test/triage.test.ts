import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeTriage, SYSTEM, type TriageDeps } from "../src/triage"
const SYSTEM_TEXT = () => SYSTEM

type Stage = Parameters<TriageDeps["propose"]>[0] extends never ? never : any
const stage = (over: Record<string, unknown>) => ({ journey: "Set up", stage: "refine", proposals: [], draft: [], ...over })
const entry = { id: "F-00000001", ref: "gherkin/card:UX-0001@abc", kind: "gap", severity: "high", note: "No deny path.", persona: "Operator", on: true, operatorNote: "Deny should say why." }
const offEntry = { id: "F-00000002", ref: "gherkin/card:UX-0002@abc", kind: "friction", severity: "low", note: "Wordy.", persona: "Operator", on: false }
const setup = (o: { stages: ReadonlyArray<Stage>; answers?: ReadonlyArray<string>; dry?: (n: number) => { ok: boolean; problems: string[]; touched: string[]; cards?: string[] }; run?: unknown; result?: unknown; fresh?: boolean; down?: boolean; journeys?: ReadonlyArray<unknown> }) => {
  const calls: Array<[string, unknown]> = []
  const answers = [...(o.answers ?? [])]
  let dries = 0
  const deps: TriageDeps = {
    stages: () => Effect.succeed(o.stages as never),
    feedbackOf: () => Effect.succeed([entry, offEntry]),
    journeys: () => Effect.succeed((o.journeys ?? [{ id: "J-0001", name: "Set up", cards: ["UX-0001", "UX-0002"] }]) as never),
    step: (card) => Effect.succeed({ card, title: `card ${card}`, given: "the plugin runs", when: "it needs a scope", thens: ["the operator is asked"], fork: [], hasFailure: false }),
    dryRun: (draft) => Effect.succeed({ cards: draft.length > 0 ? ["UX-0001", "UX-0003"] : [], ...(o.dry?.(dries++) ?? { ok: true, problems: [], touched: draft.length > 0 ? ["S-0002", "UX-0001"] : [] }) }),
    complete: (req) => (o.down === true ? Effect.fail("model down") : Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), { text: answers.shift() ?? "{}" }))),
    propose: (p) => Effect.sync(() => void calls.push(["propose", p])),
    rehearsing: (p) => Effect.sync(() => void calls.push(["rehearsing", p])),
    rehearsed: (p) => Effect.sync(() => void calls.push(["rehearsed", p])),
    drafted: (p) => Effect.sync(() => void calls.push(["drafted", p])),
    redraft: (p) => Effect.sync(() => void calls.push(["redraft", p])),
    run: (p) => Effect.sync(() => (calls.push(["run", p]), (o.run ?? { run: "r-9" }) as never)),
    result: () => Effect.succeed((o.result ?? { status: "running", findings: [] }) as never),
    status: () => Effect.void,
  }
  return { t: makeTriage(deps), calls, deps }
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
    expect(calls.find(([k]) => k === "propose")?.[1]).toEqual({ journey: "Set up", card: "UX-0001", changes: [{ tool: "edit-state", params: { id: "S-0002", text: "the operator sees: once, always, deny" } }], answers: ["F-00000001"], summary: "Name the choices." })
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
    expect(none.calls).toEqual([])
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
    let reads = 0
    const drafts: Array<unknown> = []
    const base = { stages: () => Effect.sync(() => (reads++ < 2 ? [stage({ proposals: [waiting("UX-0001"), waiting("UX-0002")] })] : [stage({ proposals: [{ ...waiting("UX-0001"), status: "accepted" }, waiting("UX-0002")], draft: [first] })]) as never) }
    const s = setup({ stages: [], answers: [proposalJson, proposalJson] })
    const tri = makeTriage({ ...s.deps, ...base, dryRun: (d) => Effect.sync(() => (drafts.push(d), { ok: true, problems: [], touched: [], cards: [] })) })
    await Effect.runPromise(tri.tick)
    expect(drafts.map((d) => (d as unknown[]).length)).toEqual([1, 2])
  })
  test("stages that wait on the operator, or are done, are left alone", async () => {
    const { t, calls } = setup({ stages: [stage({ stage: "triage" }), stage({ stage: "refine", proposals: [{ card: "UX-0001", changes: [], answers: [], summary: "s", status: "proposed" }] }), stage({ stage: "plan", plan: { title: "t", steps: [] } }), stage({ stage: "planned" })] })
    await Effect.runPromise(t.tick)
    expect(calls).toEqual([])
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
})
