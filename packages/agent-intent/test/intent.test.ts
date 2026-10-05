import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Checkpoint, JourneyInfo, Statement } from "../src/checkpoint"
import { type IntentDeps, makeIntent, SYSTEM } from "../src/intent"

const intent = { id: "I-0001", title: "Plans", problem: "Visitors leave." }
const outcome: Statement = { id: "O-0001", kind: "outcome", text: "A visitor picks a plan in one minute", version: "v1", intent, journeys: [] }
const checkout: JourneyInfo = { id: "J-0001", name: "Checkout", version: "jv", scenarios: ["S-0001"], serves: ["O-0001"] }
const unit = (scenario: string, changes: ReadonlyArray<unknown>) => ({ scenario, title: `t ${scenario}`, summary: `s ${scenario}`, changes })

const setup = (o: { personas?: ReadonlyArray<{ name: string; kind: string }>; statements?: ReadonlyArray<Statement>; journeys?: ReadonlyArray<JourneyInfo>; answers?: ReadonlyArray<string>; cp?: Checkpoint; down?: boolean; dry?: (n: number) => { ok: boolean; problems: string[] }; versionAfter?: string; slow?: number; broken?: boolean; dropped?: ReadonlyArray<string> }) => {
  const calls: Array<[string, unknown]> = []
  const schemas: Array<unknown> = []
  const answers = [...(o.answers ?? [])]
  let cp: Checkpoint = o.cp ?? { statements: {}, journeys: {} }
  let dries = 0
  let reads = 0
  const deps: IntentDeps = {
    statements: () => Effect.sync(() => (reads++, (o.statements ?? [outcome]).map((s) => (o.versionAfter !== undefined && reads > 1 ? { ...s, version: o.versionAfter } : s)))),
    journeys: () => Effect.succeed(o.journeys ?? []),
    personas: () => Effect.succeed(o.personas ?? []),
    scene: (scenario) => Effect.succeed(`${scenario} title\nGiven a\nWhen b\nThen c`),
    code: () => Effect.succeed([]),
    dryRun: (draft) => Effect.sync(() => ({ scenarios: draft.length > 0 ? ["S-0001"] : [], ...(o.dry?.(dries++) ?? { ok: true, problems: [] }) })),
    complete: (req) =>
      (schemas.push(req.outputSchema), o.down === true)
        ? Effect.andThen(Effect.sync(() => void calls.push(["down", null])), Effect.fail("down"))
        : Effect.andThen(Effect.sleep(o.slow ?? 0), Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), { text: answers.shift() ?? "no json" }))),
    version: (ref) => Effect.succeed(`${ref.split(":")[1]}-ver`),
    plan: (p) => Effect.sync(() => (calls.push(["plan", p]), { id: `B-${calls.filter(([k]) => k === "plan").length}` })),
    dropServing: (statement) => Effect.sync(() => (calls.push(["dropServing", statement]), { ids: ["B-9"] })),
    post: (t) => Effect.sync(() => (calls.push(["post", t]), "T-1")),
    settle: (id, why) => Effect.sync(() => void calls.push(["settle", `${id}: ${why}`])),
    load: o.broken === true ? Effect.fail("the checkpoint is not JSON") : Effect.sync(() => cp),
    dropped: (ids) => Effect.succeed(ids.filter((id) => (o.dropped ?? []).includes(id))),
    save: (c) => Effect.sync(() => void (cp = c)),
    log: (text) => Effect.sync(() => void calls.push(["log", text])),
    render: Effect.void,
  }
  return { a: makeIntent(deps), calls, cp: () => cp, schemas }
}

describe("the Intent Agent", () => {
  // @scenario S-0103
  test("a new outcome: one round, its draft dry-run, one plan serving it, the checkpoint at its version", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", title: "Visitor picks a plan" } }])], steps: ["Shorten the pricing scenario"], ask: null })
    const { a, calls, cp } = setup({ journeys: [checkout], answers: [answer] })
    await Effect.runPromise(a.tick)
    expect(String(calls.find(([k]) => k === "complete")![1])).toContain("O-0001 (outcome): A visitor picks a plan in one minute")
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "t S-0001", journey: "Checkout", serves: "gherkin/outcome:O-0001@v1", scenarios: [{ ref: "gherkin/scenario:S-0001@S-0001-ver" }], steps: ["Shorten the pricing scenario"], feedback: [] })
    expect(cp().statements["O-0001"]).toEqual({ version: "v1", state: "planned", plans: ["B-1"] })
  })

  test("the log says why a round got nothing: the model call failed, or its answer was not JSON (how it began)", async () => {
    const down = setup({ down: true })
    await Effect.runPromise(down.a.tick)
    expect(down.calls.filter(([k]) => k === "log").map(([, t]) => String(t))).toContainEqual(expect.stringContaining("O-0001: the driver model failed: down"))
    const prose = setup({ answers: ["Sure! Here is my plan for the outcome"] })
    await Effect.runPromise(prose.a.tick)
    expect(prose.calls.filter(([k]) => k === "log").map(([, t]) => String(t))).toContainEqual(expect.stringMatching(/O-0001: the driver model did not answer with JSON \(\d+ chars; it began: "Sure! Here is my plan.*ended: /))
  })

  // @scenario S-0103
  test("the model answers in the plan's JSON shape: units, steps and ask are its output schema", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", title: "Visitor picks a plan" } }])], steps: ["Shorten"], ask: null })
    const { a, schemas } = setup({ journeys: [checkout], answers: [answer] })
    await Effect.runPromise(a.tick)
    expect(schemas[0]).toMatchObject({ type: "object", required: ["units", "steps", "ask"] })
  })

  // @scenario S-0103
  test("the model knows who can act: the personas there are (or none yet), and add-persona to add one", async () => {
    const none = setup({ journeys: [checkout], answers: [] })
    await Effect.runPromise(none.a.tick)
    expect(String(none.calls.find(([k]) => k === "complete")![1])).toContain("Personas: none yet (add one with add-persona before a scenario names it)")
    const some = setup({ journeys: [checkout], answers: [], personas: [{ name: "Parent", kind: "human" }] })
    await Effect.runPromise(some.a.tick)
    expect(String(some.calls.find(([k]) => k === "complete")![1])).toContain("Personas: Parent (human)")
    expect(SYSTEM).toContain('add-persona {"name":')
  })

  // @scenario S-0104
  test("the model sees the intent's constraints beside the outcome it drafts, so a conflict can come back as an ask", async () => {
    const rule: Statement = { id: "K-0001", kind: "constraint", text: "Data never leaves the phone", version: "k1", intent, journeys: [] }
    const { a, calls } = setup({ statements: [outcome, rule], journeys: [checkout], answers: [], cp: { statements: { "K-0001": { version: "k1", state: "planned" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(String(calls.find(([k]) => k === "complete")![1])).toContain("The intent's constraints:\n- K-0001: Data never leaves the phone")
  })

  test("nothing due: no model call, nothing filed", async () => {
    const { a, calls } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete" || k === "plan" || k === "post")).toEqual([])
  })

  // @scenario S-0104
  test("the model asks: a topic with its options; the round waits; the answer makes it due with the decision", async () => {
    const ask = JSON.stringify({ units: [], steps: [], ask: { question: "O-0001 has no journey: add to Checkout, or a new journey?", options: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }] } })
    const { a, calls, cp } = setup({ answers: [ask] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "post")![1]).toMatchObject({ kind: "ask", key: "decide:O-0001", title: "O-0001 has no journey: add to Checkout, or a new journey?", answers: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }, { id: "leave", label: "Leave it" }] })
    expect(cp().statements["O-0001"]).toEqual({ version: "v1", state: "asked", topic: "T-1", options: [{ id: "J-0001", label: "Add to Checkout" }, { id: "new", label: "A new journey" }, { id: "leave", label: "Leave it" }] })
    expect(await Effect.runPromise(a.answered("decide:O-0001", "J-0001", undefined))).toBe("O-0001: drafting again with your answer")
    expect(cp().statements["O-0001"]!.decision).toBe("Add to Checkout")
  })

  test("an answer to a statement that changed or went is ignored, saying so", async () => {
    const { a } = setup({ cp: { statements: { "O-0001": { version: "old", state: "asked", topic: "T-1" } }, journeys: {} } })
    expect(await Effect.runPromise(a.answered("decide:O-0001", "J-0001", undefined))).toBe("O-0001 changed since it asked: its next round starts fresh")
    expect(await Effect.runPromise(a.answered("decide:O-0042", "J-0001", undefined))).toBe("O-0042 is gone")
  })

  // @scenario S-0104
  test("a draft that fails its dry-run is tried again with the problems, up to 3 tries; then left out with a topic", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001" } }])], steps: [], ask: null })
    const { a, calls, cp } = setup({ answers: [answer, answer, answer], dry: () => ({ ok: false, problems: ["S-0001: a clause has if"] }) })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete").length).toBe(3)
    expect(String(calls.filter(([k]) => k === "complete")[1]![1])).toContain("S-0001: a clause has if")
    expect(calls.find(([k]) => k === "post")![1]).toMatchObject({ key: "left:O-0001", answers: [{ id: "again", label: "Draft again" }, { id: "leave", label: "Leave it" }] })
    expect(cp().statements["O-0001"]!.state).toBe("left")
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
  })

  test("the model down or answering no JSON: one log line, nothing filed, nothing checkpointed", async () => {
    for (const o of [{ down: true }, { answers: ["I think it is fine"] }]) {
      const { a, calls, cp } = setup(o)
      await Effect.runPromise(a.tick)
      expect(calls.filter(([k]) => k === "plan" || k === "post")).toEqual([])
      expect(cp().statements).toEqual({})
      expect(calls.filter(([k]) => k === "log").map(([, t]) => String(t)).some((t) => t.includes("O-0001") && t.includes("next wake"))).toBe(true)
    }
  })

  test("a statement that changed while drafting files nothing and stays due", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001" } }])], steps: [], ask: null })
    const { a, calls, cp } = setup({ answers: [answer], versionAfter: "v2" })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
    expect(cp().statements["O-0001"]).toBeUndefined()
  })

  test("a removed statement: its Backlog plans dropped, its open topic settled, its entry gone", async () => {
    const { a, calls, cp } = setup({ statements: [], cp: { statements: { "O-0007": { version: "v", state: "asked", topic: "T-7" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "dropServing")![1]).toBe("O-0007")
    expect(calls.find(([k]) => k === "settle")![1]).toBe("T-7: its statement was removed")
    expect(cp().statements).toEqual({})
  })

  test("an unserving journey: the model names the outcomes it serves; a plan links them", async () => {
    const browse: JourneyInfo = { id: "J-0002", name: "Browse", version: "bv", scenarios: ["S-0002"], serves: [] }
    const { a, calls, cp } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "nothing" } }, journeys: {} }, journeys: [checkout, browse], answers: [JSON.stringify({ serves: ["O-0001"], ask: null })] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "Browse serves O-0001", journey: "Browse", changes: [{ tool: "link", params: { edge: "serves", journey: { id: "J-0002" }, outcome: "O-0001" } }] })
    expect(cp().journeys["J-0002"]).toEqual({ version: "bv", state: "planned", plans: ["B-1"] })
  })
})

describe("the Intent Agent under load", () => {
  const three = ["O-0001", "O-0002", "O-0003"].map((id): Statement => ({ ...outcome, id }))
  const answer = (id: string) => JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", title: id } }])], steps: [], ask: null })
  test("ticks that overlap run one at a time: each statement planned once", async () => {
    const { a, calls } = setup({ statements: three, answers: three.map((s) => answer(s.id)).concat(three.map((s) => answer(s.id))), slow: 20 })
    await Effect.runPromise(Effect.all([a.tick, a.tick, a.tick], { concurrency: "unbounded" }))
    expect(calls.filter(([k]) => k === "plan").length).toBe(3)
  })
  test("an outage stops the tick at the first statement: one model call, one log line", async () => {
    const { a, calls } = setup({ statements: three, down: true })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "down").length).toBe(1)
    expect(calls.filter(([k]) => k === "log").length).toBe(1)
  })
  test("a checkpoint it cannot read stops the tick (never treated as empty): no model call, one log line", async () => {
    const { a, calls } = setup({ statements: three, broken: true })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete" || k === "plan")).toEqual([])
    expect(calls.filter(([k]) => k === "log").map(([, t]) => String(t))).toEqual(["the checkpoint could not be read (the checkpoint is not JSON): the Intent Agent waits until it is fixed"])
  })
  test("a planned statement whose plans were all dropped is due again", async () => {
    const { a, calls } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned", plans: ["B-1"] } }, journeys: {} }, dropped: ["B-1"], answers: [answer("O-0001")] })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "plan").length).toBe(1)
  })
})

describe("a journey serving nothing, asked", () => {
  const browse: JourneyInfo = { id: "J-0002", name: "Browse", version: "bv", scenarios: ["S-0002"], serves: [] }
  const settled: Checkpoint = { statements: { "O-0001": { version: "v1", state: "nothing" } }, journeys: {} }
  test("the topic offers the outcomes themselves (and Leave), whatever ids the model invented", async () => {
    const { a, calls } = setup({ cp: settled, journeys: [checkout, browse], answers: [JSON.stringify({ serves: [], ask: { question: "Which?", options: [{ id: "new-journey", label: "Make a journey" }] } })] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "post")![1]).toMatchObject({ key: "serve:J-0002", title: "Which?", answers: [{ id: "O-0001", label: "O-0001: A visitor picks a plan in one minute" }, { id: "leave", label: "Leave it" }] })
  })
  test("an answer after the journey changed files nothing and says so", async () => {
    const { a, calls, cp } = setup({ cp: { ...settled, journeys: { "J-0002": { version: "old", state: "asked", topic: "T-1" } } }, journeys: [checkout, browse] })
    expect(await Effect.runPromise(a.answered("serve:J-0002", "O-0001", undefined))).toBe("J-0002 changed since it asked: its next round starts fresh")
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
    expect(cp().journeys["J-0002"]).toBeUndefined()
  })
  test("an answer for a journey that went files nothing", async () => {
    const { a, calls } = setup({ cp: { ...settled, journeys: { "J-0009": { version: "x", state: "asked", topic: "T-1" } } }, journeys: [checkout] })
    expect(await Effect.runPromise(a.answered("serve:J-0009", "O-0001", undefined))).toBe("J-0009 is gone")
    expect(calls.filter(([k]) => k === "plan")).toEqual([])
  })
})
