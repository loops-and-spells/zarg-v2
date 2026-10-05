import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginHost } from "@zarg/plugin/server"
import { gherkin, run, type Seen } from "./harness"

const setUp = (why = "fix · real 0.90") =>
  Effect.gen(function* () {
    yield* gherkin("add-persona", { name: "Operator", kind: "human", text: "The person using zarg." })
    yield* gherkin("add-state", { text: "the plugin runs", entry: true })
    yield* gherkin("add-scenario", { title: "Plugin asks for a scope", when: "the plugin needs a scope", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the operator is asked" }] })
    const h = yield* PluginHost
    const scenario = yield* h.entities.get("gherkin/scenario:S-0001")
    const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: scenario.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "high", note: "No deny path.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why } }] })) as { ids: string[] }
    return { scenario, ids, h }
  })
const topic = (seen: Seen, key: string) => (seen.inbox ?? []).find((t) => t.key === key)

describe("the backlog's topics in the inbox", () => {
  test("a plan that needs the operator is a plan topic; Back to Ready moves it and clears the need; the topic settles", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plan", { title: "T", journey: "Set up", scenarios: [{ ref: scenario.ref }], changes: [], feedback: ids, steps: [] })
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "Planner", needs: "commit your uncommitted changes to ST-0002 first" })
        const t = { ...topic(seen, "needs:B-01")! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: "needs:B-01", answer: "ready" })
        const item = (yield* h.entities.get("backlog/item:B-01")).data as { status: string; needs?: string }
        return { t, item, after: topic(seen, "needs:B-01") }
      }),
    )
    expect(out.t).toMatchObject({ kind: "plan", title: "B-01 T can't apply: commit your uncommitted changes to ST-0002 first", answers: [{ id: "ready" }, { id: "drop" }] })
    expect([out.item.status, out.item.needs]).toEqual(["ready", undefined])
    expect(out.after).toMatchObject({ state: "moot" })
  })
  test("feedback rehearse routed to ask is one topic per journey, not one per entry; Turn them all off flips each off as the operator; the topic settles", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, ids, h } = yield* setUp("ask · real 0.62")
        const more = (yield* h.invoke("backlog", "file", { entries: [{ ref: scenario.ref, journeys: ["Set up"], persona: "Operator", kind: "friction", severity: "low", note: "Wordy.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "ask · real 0.55" } }] })) as { ids: string[] }
        const all = [...ids, ...more.ids]
        const topics = (seen.inbox ?? []).filter((t) => t.key?.startsWith("ask:"))
        const t = { ...topics[0]! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: t.key, answer: "off" })
        const status = (yield* h.invoke("backlog", "status", { ids: all })) as Array<{ on: boolean }>
        return { keys: topics.map((x) => x.key), t, on: status.map((x) => x.on), after: topic(seen, "ask:Set up") }
      }),
    )
    expect(out.keys).toEqual(["ask:Set up"])
    expect(out.t).toMatchObject({ kind: "question", title: "Set up: 2 feedback entries want your call", answers: [{ id: "on" }, { id: "off" }] })
    expect(out.on).toEqual([false, false])
    expect(out.after).toMatchObject({ state: "moot" })
  })
  test("a scenario left out of a round is a plan topic; Draft again sends it back to triage; the round's plans are a report", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { ids, h } = yield* setUp()
        // A second scenario whose change goes in: the round moves on to Plan with S-0001 left out.
        yield* gherkin("add-scenario", { title: "Plugin loads", when: "the plugin starts", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plugin is loaded" }] })
        const two = yield* h.entities.get("gherkin/scenario:S-0002")
        yield* h.invoke("backlog", "file", { entries: [{ ref: two.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "low", note: "Say when.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix · real 0.90" } }] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "refine", rows: [] })
        // A scenario is left out once its rounds of tries are spent.
        for (let i = 0; i < 3; i++) yield* h.invoke("backlog", "propose", { journey: "Set up", scenario: "S-0001", changes: [], answers: [], summary: "", problems: ["a clause has if"] })
        yield* h.invoke("backlog", "propose", { journey: "Set up", scenario: "S-0002", changes: [{ tool: "edit-scenario", params: { id: "S-0002", when: "the plugin starts up" } }], answers: [], summary: "s" })
        const t = { ...topic(seen, "left:Set up:S-0001")! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: "left:Set up:S-0001", answer: "draft" })
        const stage = ((yield* h.invoke("backlog", "stages", {})) as Array<{ proposals: Array<{ scenario: string; status: string }> }>)[0]!
        void ids
        return { t, status: stage.proposals.find((p) => p.scenario === "S-0001")?.status }
      }),
    )
    expect(out.t).toMatchObject({ kind: "plan", title: "S-0001 left out of Set up's round", answers: [{ id: "draft" }, { id: "leave" }] })
    expect(out.status).toBe("waiting")
  })
  test("a folded round's plans and a finished rehearse run are reports", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [{ title: "First", steps: [], changes: [], scenarios: ["S-0001"], feedback: ids, after: [] }] })
        const two = { ref: scenario.ref, journeys: ["Set up"], persona: "Operator", from: { agent: "rehearse", run: "r-2" }, triage: { on: false, why: "drop · real 0.10" } }
        yield* h.invoke("backlog", "file", { entries: [{ ...two, kind: "friction", severity: "low", note: "Wordy." }, { ...two, kind: "gap", severity: "low", note: "Missing." }], walked: ["S-0001"], run: "r-2" })
        return (seen.inbox ?? []).filter((t) => t.kind === "report").map((t) => t.title)
      }),
    )
    expect(out).toEqual(["Set up folded into 1 plan: B-01", "Rehearse run r-2: 2 entries on Set up"])
  })
  test("a rehearse run that files nothing is a report too: the operator hears it ended clean", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { h } = yield* setUp()
        yield* h.invoke("backlog", "file", { entries: [], walked: ["S-0001"], run: "r-3" })
        return (seen.inbox ?? []).filter((t) => t.kind === "report").map((t) => t.title)
      }),
    )
    expect(out).toContainEqual("Rehearse run r-3: nothing found")
  })
  test("a folded round's report settles once all its plans are dropped (it named plans that are gone)", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plans", { journey: "Set up", plans: [{ title: "First", steps: [], changes: [], scenarios: ["S-0001"], feedback: ids, after: [] }] })
        const before = { ...(seen.inbox ?? []).find((t) => t.kind === "report" && t.title.includes("B-01"))! }
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "Planner", needs: "x" })
        const t = { ...topic(seen, "needs:B-01")! }
        yield* h.invoke("backlog", "answered", { id: t.id, key: "needs:B-01", answer: "drop" })
        return { before: before.state, after: (seen.inbox ?? []).find((x) => x.id === before.id)?.state }
      }),
    )
    expect(out).toEqual({ before: "open", after: "moot" })
  })
  test("stale answers change nothing and say so: a parked plan's Back to Ready, a dropped plan's Drop", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, ids, h } = yield* setUp()
        yield* h.invoke("backlog", "plan", { title: "T", journey: "Set up", scenarios: [{ ref: scenario.ref }], changes: [], feedback: ids, steps: [] })
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "Planner", needs: "commit first" })
        const t = { ...topic(seen, "needs:B-01")! }
        // The operator parks it on the board: the need is gone, so is the topic.
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "backlog", by: "operator" })
        const settled = topic(seen, "needs:B-01")?.state
        const r = (yield* h.invoke("backlog", "answered", { id: t.id, key: "needs:B-01", answer: "ready" })) as { notice: string }
        const item = (yield* h.entities.get("backlog/item:B-01")).data as { status: string }
        return { settled, notice: r.notice, status: item.status }
      }),
    )
    expect(out.settled).toBe("moot")
    expect(out.notice).toBe("B-01 no longer needs you")
    expect(out.status).toBe("backlog")
  })
  test("an ask settles when the operator flips the entry in Feedback; answering it then changes nothing", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { ids, h } = yield* setUp("ask · real 0.62")
        const t = { ...topic(seen, "ask:Set up")! }
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "toggle", rows: ids })
        const settled = topic(seen, "ask:Set up")?.state
        const r = (yield* h.invoke("backlog", "answered", { id: t.id, key: "ask:Set up", answer: "on" })) as { notice: string }
        const status = (yield* h.invoke("backlog", "status", { ids })) as Array<{ on: boolean }>
        return { settled, notice: r.notice, on: status[0]!.on }
      }),
    )
    expect(out.settled).toBe("moot")
    expect(out.notice).toBe("Set up: nothing left to decide there")
    expect(out.on).toBe(false)
  })
  test("Leave it out is kept: the scenario is not raised again", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { h } = yield* setUp()
        yield* gherkin("add-scenario", { title: "Plugin loads", when: "the plugin starts", by: [{ id: "P-0001" }], arrives: { id: "ST-0001" }, then: [{ text: "the plugin is loaded" }] })
        const two = yield* h.entities.get("gherkin/scenario:S-0002")
        yield* h.invoke("backlog", "file", { entries: [{ ref: two.ref, journeys: ["Set up"], persona: "Operator", kind: "gap", severity: "low", note: "Say when.", from: { agent: "rehearse", run: "r-1" }, triage: { on: true, why: "fix · real 0.90" } }] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "open", rows: [] })
        yield* h.invoke("backlog", "act", { agent: "feedback", action: "refine", rows: [] })
        for (let i = 0; i < 3; i++) yield* h.invoke("backlog", "propose", { journey: "Set up", scenario: "S-0001", changes: [], answers: [], summary: "", problems: ["a clause has if"] })
        yield* h.invoke("backlog", "propose", { journey: "Set up", scenario: "S-0002", changes: [{ tool: "edit-scenario", params: { id: "S-0002", when: "the plugin starts up" } }], answers: [], summary: "s" })
        const t = { ...topic(seen, "left:Set up:S-0001")! }
        Object.assign(topic(seen, "left:Set up:S-0001")!, { state: "answered" })
        yield* h.invoke("backlog", "answered", { id: t.id, key: "left:Set up:S-0001", answer: "leave" })
        // Anything else changes (a new filing syncs the topics): the scenario is not raised again.
        yield* h.invoke("backlog", "file", { entries: [{ ref: two.ref, journeys: ["Set up"], persona: "Operator", kind: "friction", severity: "low", note: "Wordy.", from: { agent: "rehearse", run: "r-3" }, triage: { on: false, why: "drop · real 0.10" } }] })
        return (seen.inbox ?? []).filter((x) => x.key === "left:Set up:S-0001" && x.state === "open").length
      }),
    )
    expect(out).toBe(0)
  })
  // @scenario S-0107
  test("a drift is the operator's decision: Change the code files a code plan the Planner never takes; its topic's Done moves it to Done and closes the feedback", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, h } = yield* setUp()
        const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: scenario.ref, journeys: ["Set up"], persona: "Operator", kind: "drift", severity: "medium", note: "The scenario says one agent stops; the code stops the whole run.", from: { agent: "rehearse", run: "r-5" }, triage: { on: true, why: "ask · real 1.00" } }] })) as { ids: string[] }
        const d = { ...topic(seen, `drift:${ids[0]}`)! }
        const noAsk = topic(seen, "ask:Set up")
        yield* h.invoke("backlog", "answered", { id: d.id, key: `drift:${ids[0]}`, answer: "code" })
        const item = (yield* h.entities.get("backlog/item:B-01")).data as { kind?: string; status: string; changes: unknown[] }
        yield* h.invoke("backlog", "moved", { id: "B-01", to: "ready", by: "operator" })
        const next = yield* h.invoke("backlog", "next", {})
        const c = { ...topic(seen, "code:B-01")! }
        yield* h.invoke("backlog", "answered", { id: c.id, key: "code:B-01", answer: "done" })
        const done = (yield* h.entities.get("backlog/item:B-01")).data as { status: string }
        const fb = (yield* h.invoke("backlog", "status", { ids })) as Array<{ state: string }>
        return { d, noAsk, item, next, c, done: done.status, fb: fb[0]!.state }
      }),
    )
    expect(out.d).toMatchObject({ kind: "drift", answers: [{ id: "scenario" }, { id: "code" }] })
    expect(out.noAsk).toBeUndefined()
    expect([out.item.kind, out.item.status, out.item.changes]).toEqual(["code", "backlog", []])
    expect(out.next).toBeNull()
    expect(out.c).toMatchObject({ kind: "plan", answers: [{ id: "done" }, { id: "drop" }] })
    expect([out.done, out.fb]).toEqual(["done", "closed"])
  })
  // @scenario S-0107
  test("a drift answered Reword the scenario keeps the entry on with the operator's note, for the next Refine", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, h } = yield* setUp()
        const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: scenario.ref, journeys: ["Set up"], persona: "Operator", kind: "drift", severity: "medium", note: "The scenario and the code differ.", from: { agent: "rehearse", run: "r-5" }, triage: { on: true, why: "ask · real 1.00" } }] })) as { ids: string[] }
        const d = { ...topic(seen, `drift:${ids[0]}`)! }
        yield* h.invoke("backlog", "answered", { id: d.id, key: `drift:${ids[0]}`, answer: "scenario" })
        const e = (yield* h.invoke("backlog", "feedbackOf", { journey: "Set up" })) as Array<{ id: string; on: boolean; operatorNote?: string }>
        return e.find((x) => x.id === ids[0])
      }),
    )
    expect(out).toMatchObject({ on: true, operatorNote: "reword the scenario to match the code" })
  })
  test("while a run walks the journey, a drift answer changes nothing and its topic settles; the run's end raises it again", async () => {
    const out = await run((seen) =>
      Effect.gen(function* () {
        const { scenario, h } = yield* setUp()
        const { ids } = (yield* h.invoke("backlog", "file", { entries: [{ ref: scenario.ref, journeys: ["Set up"], persona: "Operator", kind: "drift", severity: "medium", note: "differ", from: { agent: "rehearse", run: "r-5" }, triage: { on: true, why: "ask · real 1.00" } }] })) as { ids: string[] }
        const d = { ...topic(seen, `drift:${ids[0]}`)! }
        yield* h.invoke("backlog", "walking", { run: "r-6", journeys: ["Set up"] })
        const during = topic(seen, `drift:${ids[0]}`)?.state
        const r = (yield* h.invoke("backlog", "answered", { id: d.id, key: `drift:${ids[0]}`, answer: "code" })) as { notice: string }
        yield* h.invoke("backlog", "walking", { run: "r-6", journeys: [] })
        const after = (seen.inbox ?? []).filter((t) => t.key === `drift:${ids[0]}` && t.state === "open").length
        return { during, notice: r.notice, after, plans: (yield* h.invoke("backlog", "next", {})) }
      }),
    )
    expect(out.during).toBe("moot")
    expect(out.notice).toBe("that feedback's journey is being rehearsed: read-only until the run ends")
    expect(out.after).toBe(1)
  })
  test("Leave it out on a round that moved on changes nothing and says so", async () => {
    const out = await run(() =>
      Effect.gen(function* () {
        const { h } = yield* setUp()
        return ((yield* h.invoke("backlog", "answered", { id: "T-00000009", key: "left:Set up:S-0001", answer: "leave" })) as { notice: string }).notice
      }),
    )
    expect(out).toBe("S-0001 is no longer left out of Set up's round")
  })
})
