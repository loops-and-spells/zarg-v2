import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Checkpoint, JourneyInfo, Statement } from "../src/checkpoint"
import { type IntentDeps, makeIntent } from "../src/intent"

const intent = { id: "I-0001", title: "Plans", problem: "Visitors leave." }
const outcome: Statement = { id: "O-0001", kind: "outcome", text: "A visitor picks a plan in one minute", version: "v1", intent, journeys: [] }
const checkout: JourneyInfo = { id: "J-0001", name: "Checkout", version: "jv", scenarios: ["S-0001"], serves: ["O-0001"] }
const unit = (scenario: string, changes: ReadonlyArray<unknown>) => ({ scenario, title: `t ${scenario}`, summary: `s ${scenario}`, changes })

const setup = (o: { statements?: ReadonlyArray<Statement>; journeys?: ReadonlyArray<JourneyInfo>; answers?: ReadonlyArray<string>; cp?: Checkpoint; down?: boolean; dry?: (n: number) => { ok: boolean; problems: string[] }; versionAfter?: string }) => {
  const calls: Array<[string, unknown]> = []
  const answers = [...(o.answers ?? [])]
  let cp: Checkpoint = o.cp ?? { statements: {}, journeys: {} }
  let dries = 0
  let reads = 0
  const deps: IntentDeps = {
    statements: () => Effect.sync(() => (reads++, (o.statements ?? [outcome]).map((s) => (o.versionAfter !== undefined && reads > 1 ? { ...s, version: o.versionAfter } : s)))),
    journeys: () => Effect.succeed(o.journeys ?? []),
    scene: (scenario) => Effect.succeed(`${scenario} title\nGiven a\nWhen b\nThen c`),
    code: () => Effect.succeed([]),
    dryRun: (draft) => Effect.sync(() => ({ scenarios: draft.length > 0 ? ["S-0001"] : [], ...(o.dry?.(dries++) ?? { ok: true, problems: [] }) })),
    complete: (req) => (o.down === true ? Effect.fail("down") : Effect.sync(() => (calls.push(["complete", req.messages.at(-1)?.content]), { text: answers.shift() ?? "no json" }))),
    version: (ref) => Effect.succeed(`${ref.split(":")[1]}-ver`),
    plan: (p) => Effect.sync(() => (calls.push(["plan", p]), { id: `B-${calls.filter(([k]) => k === "plan").length}` })),
    dropServing: (statement) => Effect.sync(() => (calls.push(["dropServing", statement]), { ids: ["B-9"] })),
    post: (t) => Effect.sync(() => (calls.push(["post", t]), "T-1")),
    settle: (id, why) => Effect.sync(() => void calls.push(["settle", `${id}: ${why}`])),
    load: Effect.sync(() => cp),
    save: (c) => Effect.sync(() => void (cp = c)),
    log: (text) => Effect.sync(() => void calls.push(["log", text])),
    render: Effect.void,
  }
  return { a: makeIntent(deps), calls, cp: () => cp }
}

describe("the Intent Agent", () => {
  test("a new outcome: one round, its draft dry-run, one plan serving it, the checkpoint at its version", async () => {
    const answer = JSON.stringify({ units: [unit("S-0001", [{ tool: "edit-scenario", params: { id: "S-0001", title: "Visitor picks a plan" } }])], steps: ["Shorten the pricing scenario"], ask: null })
    const { a, calls, cp } = setup({ journeys: [checkout], answers: [answer] })
    await Effect.runPromise(a.tick)
    expect(String(calls.find(([k]) => k === "complete")![1])).toContain("O-0001 (outcome): A visitor picks a plan in one minute")
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "t S-0001", journey: "Checkout", serves: "gherkin/outcome:O-0001@v1", scenarios: [{ ref: "gherkin/scenario:S-0001@S-0001-ver" }], steps: ["Shorten the pricing scenario"], feedback: [] })
    expect(cp().statements["O-0001"]).toEqual({ version: "v1", state: "planned", plans: ["B-1"] })
  })

  test("nothing due: no model call, nothing filed", async () => {
    const { a, calls } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned" } }, journeys: {} } })
    await Effect.runPromise(a.tick)
    expect(calls.filter(([k]) => k === "complete" || k === "plan" || k === "post")).toEqual([])
  })

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
    const { a, calls, cp } = setup({ cp: { statements: { "O-0001": { version: "v1", state: "planned" } }, journeys: {} }, journeys: [checkout, browse], answers: [JSON.stringify({ serves: ["O-0001"], ask: null })] })
    await Effect.runPromise(a.tick)
    expect(calls.find(([k]) => k === "plan")![1]).toMatchObject({ title: "Browse serves O-0001", journey: "Browse", changes: [{ tool: "link", params: { edge: "serves", journey: { id: "J-0002" }, outcome: "O-0001" } }] })
    expect(cp().journeys["J-0002"]).toEqual({ version: "bv", state: "planned", plans: ["B-1"] })
  })
})
