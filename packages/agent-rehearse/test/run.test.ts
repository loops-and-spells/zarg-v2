import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type FiledEntry, makeRehearse, ownScenario, type RunDeps } from "../src/run"
import { rehearseSettings } from "../src/settings"
import type { Answer, DecisionRequest, SceneView } from "../src/types"
import { FEEDBACK_COLUMNS, RunView, TesterView } from "../src/views"

const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })

type Opts = { statusDown?: boolean; fileSome?: boolean; inFlight?: number; slowWrite?: number; down?: boolean; slowDecide?: number; gone?: ReadonlyArray<string>; state?: string; on?: boolean; unreachable?: number; personas?: ReadonlyArray<{ name: string; text: string; scenarios: ReadonlyArray<string> }>; files?: Map<string, string>; scenarioText?: (scenario: string) => string; built?: Record<string, "planned" | "untagged">; prompts?: Array<string>; codeDown?: boolean }
const setup = (o: Opts = {}) =>
  Effect.gen(function* () {
    const files = o.files ?? new Map<string, string>()
    const decisions: Array<DecisionRequest> = []
    const llm = { n: 0 }
    const events: Array<{ event: string; id: string; text?: string; progress?: { done: number; total: number } }> = []
    const filedCalls: Array<ReadonlyArray<FiledEntry>> = []
    const filedWith: Array<{ walked?: ReadonlyArray<string>; run?: string }> = []
    const walking: Array<[string, ReadonlyArray<string>]> = []
    const drafts: Array<[string, unknown]> = []
    const strategies: Array<string> = []
    const agendaChanges = { n: 0 }
    const gone = new Set(o.gone ?? [])
    const writing = new Map<string, number>()
    const overlap = { max: 0 }
    const pushes: Array<{ agent: string; path: string; data?: unknown; lines?: unknown; view?: string }> = []
    let ids = 0
    const view = (scenario: string): SceneView => ({ scenario, title: `scenario ${scenario}`, given: `before ${scenario}`, when: o.scenarioText?.(scenario) ?? `do ${scenario}`, thens: [`after ${scenario}`], fork: [], hasFailure: false, journeys: ["Checkout"], by: ["Operator"] })
    const deps: RunDeps = {
      personas: () => Effect.succeed(o.personas ?? [{ name: "Operator", text: "The operator, through the zarg TUI.", scenarios: ["A", "B", "C", "D"] }]),
      stories: (strategy, _f, draft) => Effect.sync(() => (drafts.push(["stories", draft]), strategies.push(strategy), { stories: [["A", "B", "C"], ["A", "B", "D"]], unreachable: o.unreachable ?? 0 })),
      scene: (scenario, _via, draft) => Effect.sync(() => (drafts.push(["step", draft]), draft !== undefined && scenario === "B" ? { ...view(scenario), thens: ["after B, drafted"] } : { ...view(scenario), ...(o.built?.[scenario] === "planned" ? { planned: true } : {}) })),
      ...(o.built !== undefined ? { code: (scenario: string) => o.codeDown === true ? Effect.fail("no git") : Effect.succeed(o.built![scenario] !== undefined ? [] : [{ file: `src/${scenario}.ts`, line: 1, text: `export const do${scenario} = () => "${scenario} code"` }]) } : {}),
      agendaChanged: Effect.sync(() => void agendaChanges.n++),
      decide: (req) =>
        Effect.andThen(
          Effect.sleep(o.slowDecide ?? 0),
          Effect.suspend((): Effect.Effect<Readonly<Record<string, Answer>>, string> => {
            decisions.push(req)
            if (req.questions.person) return Effect.succeed({ person: noul(0.9) })
            if (req.questions.real) return Effect.succeed({ real: noul(0.9), route: { type: "choice", choice: "fix", probabilities: { fix: 1 }, confidence: 1 } })
            if (o.down) return Effect.fail("down")
            return Effect.succeed({ feel: { type: "score", score: req.state.includes("When do B") ? 1.0 : 1.8, level: "fine", probabilities: [], confidence: 0 }, fail: noul(0.3), arrive: noul(0.7) })
          }),
        ),
      complete: (req) =>
        Effect.sync(() => {
          llm.n++
          o.prompts?.push(req.messages.map((m) => m.content).join("\n"))
          return { text: req.outputSchema ? JSON.stringify({ findings: [{ kind: "friction", severity: "medium", note: "B is unclear" }] }) : "Testers stalled at B." }
        }),
      agents: {
        start: (a) => Effect.sync(() => void events.push({ event: "start", id: a.id, ...(a.id === "run" ? { text: a.task } : {}) })),
        status: (a) => Effect.sync(() => void events.push({ event: "status", id: a.id, ...(a.text !== undefined ? { text: a.text } : {}), ...(a.progress !== undefined ? { progress: a.progress } : {}) })),
        step: (a) => Effect.sync(() => void events.push({ event: "step", id: a.id, text: a.text })),
        end: (a) => Effect.sync(() => void events.push({ event: "end", id: a.id })),
      },
      now: Effect.sync(() => 1_000 + ids),
      uuid: Effect.sync(() => `0000000${++ids}-uuid`),
      read: (path) => (files.has(path) ? Effect.succeed(files.get(path)!) : Effect.fail("missing")),
      write: (path, text) =>
        Effect.gen(function* () {
          const n = (writing.get(path) ?? 0) + 1
          writing.set(path, n)
          overlap.max = Math.max(overlap.max, n)
          yield* Effect.sleep(o.slowWrite ?? 0)
          files.set(path, text)
          writing.set(path, n - 1)
        }),
      list: (dir) => Effect.succeed([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1))),
      version: (scenario) => Effect.succeed(gone.has(scenario) ? null : `v${scenario.toLowerCase()}00000000000`.slice(0, 12)),
      walking: (run, journeys) => Effect.sync(() => void walking.push([run, journeys])),
      journeysOf: (scenarios) => Effect.succeed(scenarios.length > 0 ? ["Checkout"] : []),
      file: (entries, opts) => Effect.sync(() => (filedCalls.push(entries), filedWith.push(opts ?? {}), { ids: entries.map((_, i) => (o.fileSome === true ? "" : `F-${i}`)) })),
      status: (ids) => (o.statusDown === true ? Effect.fail("down") : Effect.succeed(ids.map((id) => ({ id, state: o.state ?? "open", on: o.on ?? true })))),
      views: {
        set: (agent, v, path, data) => Effect.sync(() => void pushes.push({ agent, path, data, view: v.name })),
        append: (agent, _v, path, lines) => Effect.sync(() => void pushes.push({ agent, path, lines })),
      },
      surfaces: { open: (surface, agent) => Effect.sync(() => void events.push({ event: "open", id: agent, text: surface })) },
      settings: rehearseSettings({ ...(o.inFlight !== undefined ? { in_flight: o.inFlight } : {}) }, "stub:m"),
    }
    const r = yield* makeRehearse(deps)
    return { r, files, decisions, llm, events, filedCalls, filedWith, walking, overlap, pushes, drafts, agendaChanges, strategies }
  })
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300 && !check(); i++) yield* Effect.sleep(10)
  })
const finish = (o: Opts = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* setup(o)
      const s = (yield* t.r.start({})) as { run: string }
      yield* until(() => t.r.record(s.run)?.status === "done")
      return { ...t, run: s.run }
    }),
  )
type Pushes = ReadonlyArray<{ agent: string; path: string; data?: unknown; lines?: unknown }>
/** The rows an agent's table shows now: its last push. */
const rowsNow = (pushes: Pushes, agent: string, path: string) => ((pushes.filter((p) => p.agent === agent && p.path === path).at(-1)?.data as { rows?: ReadonlyArray<{ id: string; cells: Record<string, string> }> } | undefined)?.rows ?? [])

describe("the run's line", () => {
  test("counts stories as stories (never storys)", async () => {
    const t = await finish()
    const line = String(t.events.find((e) => e.event === "start" && e.id === "run")?.text)
    expect(line).toMatch(/\d+ stor(y|ies) ×/)
  })
})

describe("rehearse run files", () => {
  test("they are this machine's: their folder ignores itself in any project", async () => {
    const t = await finish()
    expect(t.files.get(".zarg/rehearse/.gitignore")).toBe("*\n")
  })
})

describe("rehearse runs in the plugin", () => {
  test("a run shows its progress in a status panel, opened before the first tester starts", async () => {
    const t = await finish()
    const open = t.events.findIndex((e) => e.event === "open")
    expect(t.events[open]).toEqual({ event: "open", id: "run", text: "status" })
    expect(open).toBeLessThan(t.events.findIndex((e) => e.event === "start" && e.id === "tester-1"))
    const line = t.pushes.filter((p) => p.agent === "run" && p.view === "status" && p.path === "line").at(-1)?.data as { items: ReadonlyArray<{ label: string; value: string }> }
    expect(line.items.map((i) => i.label)).toEqual(["rehearse", "testers"])
    expect(line.items[0]!.value).toMatch(/^\d+\/\d+ scenes$/)
  })

  test("a run screens shared prefixes once, diagnoses only flagged scenes, and files what it found", async () => {
    const t = await finish()
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(4)
    expect(t.llm.n).toBe(2)
    const rec = t.r.record(t.run)!
    expect(rec.findings.map((f) => [f.kind, f.scenario, f.route])).toEqual([["friction", "B", "fix"]])
    expect(rec.report).toBe("Testers stalled at B.")
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 feedback entry filed · triage in Feedback")
  })

  test("each finding: scenario, journey, kind and severity in the list, everything in its search text, and in full in the detail beside it", async () => {
    const t = await finish()
    const [row] = rowsNow(t.pushes, "tester-1", "review.feedback") as ReadonlyArray<{ id: string; cells: Record<string, string>; search?: string }>
    expect(row!.cells).toEqual({ scenario: "gherkin/scenario:B", journey: "Checkout", kind: "friction", severity: "medium", now: "open" })
    expect(row!.search).toContain("B is unclear")
    expect(row!.search).toContain("Operator")
    const detail = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "detail").at(-1)?.data as { rows: Record<string, string> }
    const md = detail.rows[row!.id]!
    expect(md).toContain("scenario B")
    expect(md).toContain("B is unclear")
    // Who and where on the scenario's By / In lines, so the highlighter colours them.
    expect(md).toContain("```gherkin\nBy    Operator\nIn    Checkout\nGiven before B\nWhen  do B\nThen  after B\n```")
  })

  test("testers walk journeys by default; edge-pair and teleport on request", async () => {
    const t = await finish()
    expect(t.strategies).toEqual(["journey"])
    expect(t.r.record(t.run)!.strategy).toBe("journey")
  })

  test("a run over a draft walks the drafted scenarios, files nothing, and holds its findings for the caller; its end changes the agenda", async () => {
    const draft = [{ tool: "edit-state", params: { id: "ST-0002", text: "after B, drafted" } }]
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup()
        const s = (yield* t.r.start({ draft, file: false })) as { run: string }
        yield* until(() => t.r.record(s.run)?.status === "done")
        return { ...t, run: s.run }
      }),
    )
    expect(t.drafts.length).toBeGreaterThan(0)
    expect(t.drafts.every(([, d]) => JSON.stringify(d) === JSON.stringify(draft))).toBe(true)
    expect(t.filedCalls).toEqual([])
    expect(t.r.result(t.run)).toEqual({ status: "done", findings: [{ scenario: "B", kind: "friction", severity: "medium", note: "B is unclear", on: true }] })
    expect(t.r.result("r-none")).toEqual({ status: "unknown", findings: [] })
    expect(t.agendaChanges.n).toBe(1)
  })

  // @scenario S-0106
  test("a finished run files each finding with the backlog: the scenario's version, its journeys, and the run's first call", async () => {
    const t = await finish()
    expect(t.filedCalls).toEqual([
      [{ ref: "gherkin/scenario:B@vb0000000000", journeys: ["Checkout"], persona: "Operator", kind: "friction", severity: "medium", note: "B is unclear", from: { agent: "rehearse", run: t.run }, triage: { on: true, why: "fix · real 0.90" } }],
    ])
    expect(t.r.record(t.run)!.filed).toEqual({ [t.r.record(t.run)!.findings[0]!.id]: "F-0" })
    // The scenarios it walked: their feedback it no longer reports closes in the backlog.
    expect(t.filedWith).toEqual([{ walked: ["A", "B", "C", "D"], run: t.run }])
    // Its journeys' feedback was locked while it walked, and freed at its end.
    expect(t.walking).toEqual([[t.run, ["Checkout"]], [t.run, []]])
  })

  test("a finding on a scenario that is gone is not filed; the run still reconciles the scenarios it walked", async () => {
    const t = await finish({ gone: ["B"] })
    expect(t.filedCalls).toEqual([[]])
    expect(t.filedWith[0]!.walked).toEqual(["A", "B", "C", "D"])
  })

  test("a tester's Feedback table says where each entry is now: off when triaged off", async () => {
    const t = await finish({ on: false })
    expect(rowsNow(t.pushes, "tester-1", "review.feedback").map((r) => r.cells.now)).toEqual(["off"])
  })

  test("where feedback stands is unknown when the backlog does not answer; an entry the backlog refused is not filed", async () => {
    expect(rowsNow((await finish({ statusDown: true })).pushes, "tester-1", "review.feedback").map((r) => r.cells.now)).toEqual(["unknown"])
    const t = await finish({ fileSome: true })
    expect(t.r.record(t.run)!.filed).toEqual({})
    expect(rowsNow(t.pushes, "tester-1", "review.feedback").map((r) => r.cells.now)).toEqual(["not filed"])
  })

  test("the run shows its feedback by journey and severity, and has no actions", async () => {
    const t = await finish()
    expect(rowsNow(t.pushes, "run", "journeys").map((r) => r.cells)).toEqual([{ journey: "Checkout", feedback: "1", high: "0", medium: "1", low: "0" }])
    expect(JSON.stringify([TesterView, RunView])).not.toContain("actions")
  })

  test("a second run is refused while one is going; with no testers a run does not start", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup()
        yield* t.r.start({})
        const second = yield* t.r.start({})
        const none = yield* (yield* setup({ personas: [] })).r.start({})
        return { second, none }
      }),
    )
    expect(out.second).toMatchObject({ refused: expect.stringContaining("is still going") })
    expect(out.none).toMatchObject({ refused: expect.stringContaining("no personas yet") })
  })

  test("a decision-model outage leaves scenes unscreened and counted; only the report reaches the model", async () => {
    const t = await finish({ down: true })
    expect(Object.values(t.r.record(t.run)!.screened).every((v) => v === null)).toBe(true)
    expect(t.r.record(t.run)!.findings).toEqual([])
    expect(t.llm.n).toBe(1)
  })

  test("a run left running resumes from its record without screening finished scenes again", async () => {
    const files = new Map<string, string>()
    const run = "r-resume"
    files.set(".zarg/rehearse/index.json", JSON.stringify([run]))
    files.set(
      `.zarg/rehearse/${run}.json`,
      JSON.stringify({
        run, startedAt: 1, status: "running", strategy: "edge-pair", focus: [], personas: [{ name: "The developer", text: "The developer, through the zarg TUI." }],
        stories: [["A", "B", "C"], ["A", "B", "D"]], unreachable: 0,
        screened: { "The developer|A": { feel: 1.8, fail: 0.3, arrive: 0.7, flags: [] }, "The developer|A>B": { feel: 1.0, fail: 0.3, arrive: 0.7, flags: ["feel"] } },
        raw: [], infra: [], findings: [],
      }),
    )
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ files })
        yield* t.r.resume
        yield* until(() => t.r.record(run)?.status === "done")
        return t
      }),
    )
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(2)
  })

  test("a stopped run tells the core (a re-rehearse waiting on it starts again)", async () => {
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ slowDecide: 20 })
        yield* t.r.start({})
        yield* t.r.stop()
        return t
      }),
    )
    expect(t.agendaChanges.n).toBe(1)
  })

  test("a stop that names another run leaves this one going (triage stops only its own)", async () => {
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ slowDecide: 20 })
        const s = (yield* t.r.start({})) as { run: string }
        yield* t.r.stop("r-someone-else")
        const going = t.r.record(s.run)!.status
        yield* t.r.stop(s.run)
        return { going, after: t.r.record(s.run)!.status }
      }),
    )
    expect(t).toEqual({ going: "running", after: "stopped" })
  })

  test("a stopped run frees its journeys' feedback", async () => {
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ slowDecide: 20 })
        const s = (yield* t.r.start({})) as { run: string }
        yield* t.r.stop()
        return { ...t, run: s.run }
      }),
    )
    expect(t.walking.at(-1)).toEqual([t.run, []])
  })

  test("stop keeps the partial record, marked stopped", async () => {
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ slowDecide: 20 })
        const s = (yield* t.r.start({})) as { run: string }
        yield* t.r.stop()
        return { ...t, run: s.run }
      }),
    )
    expect(t.r.record(t.run)!.status).toBe("stopped")
  })

  test("a tester's progress only goes up, to distinct scenes checked out of those to check", async () => {
    const t = await finish({ slowDecide: 3, unreachable: 2 })
    const rows = t.events.filter((e) => e.id === "tester-1" && e.event === "status").map((e) => e.progress!)
    expect(rows.map((r) => r.done)).toEqual([...rows.map((r) => r.done)].sort((a, b) => a - b))
    expect(rows.at(-1)).toEqual({ done: 4, total: 4 })
    expect(t.pushes.filter((p) => p.agent === "tester-1" && p.path === "scenes").flatMap((p) => p.lines as ReadonlyArray<{ text: string }>).map((l) => l.text)).toContain("B: feel 1.00, fail 0.30 → flagged feel → 1 finding")
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 feedback entry filed · triage in Feedback · 2 unreachable")
  })

  test("writes of one record never overlap, so a record is never half-written", async () => {
    const t = await finish({ slowWrite: 2 })
    expect(t.overlap.max).toBe(1)
  })

  test("the tester's view: workers follow the walk, scenes are logged, its findings fill the review table", async () => {
    const t = await finish({ slowDecide: 3 })
    const workers = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "workers").map((p) => p.data as { items: ReadonlyArray<{ state?: string; detail?: string }> })
    expect(workers.some((w) => w.items.some((i) => i.state === "busy"))).toBe(true)
    // Both stories start with A, B: one screens the shared scene, the other waits for it.
    expect(workers.some((w) => w.items.some((i) => i.state === "waiting"))).toBe(true)
    expect(workers.at(-1)!.items).toEqual([])
    expect(t.pushes.filter((p) => p.agent === "tester-1" && p.path === "scenes").flatMap((p) => p.lines as ReadonlyArray<{ text: string }>).map((l) => l.text)).toContain("B: feel 1.00, fail 0.30 → flagged feel → 1 finding")
    const id = t.r.record(t.run)!.findings[0]!.id
    const review = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "review.feedback").at(-1)!.data as { rows: ReadonlyArray<{ id: string }> }
    expect(review.rows.map((r) => r.id)).toEqual([id])
  })

  test("while a run goes, the last run's tables do not replace the live ones; raw rows have unique ids", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    const clobbered = await Effect.runPromise(
      Effect.gen(function* () {
        const s = (yield* t.r.start({})) as { run: string }
        const before = t.pushes.length
        yield* t.r.refresh
        const out = t.pushes.slice(before).some((p) => p.path.startsWith("review.") && ((p.data as { rows?: ReadonlyArray<{ id: string }> }).rows ?? []).some((r) => r.id === id))
        yield* until(() => t.r.record(s.run)?.status === "done")
        return out
      }),
    )
    expect(clobbered).toBe(false)
    const raw = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "review.feedback").map((p) => (p.data as { rows: ReadonlyArray<{ id: string }> }).rows.map((r) => r.id))
    for (const ids of raw) expect(new Set(ids).size).toBe(ids.length)
  })

  test("workers show busy only for stories holding a slot; the rest are queued, and progress says how many slots are busy", async () => {
    const t = await finish({ inFlight: 1, slowDecide: 3 })
    const lists = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "workers").map((p) => (p.data as { items: ReadonlyArray<{ state?: string; detail?: string }> }).items)
    expect(Math.max(...lists.map((l) => l.filter((i) => i.state === "busy").length))).toBe(1)
    expect(lists.some((l) => l.some((i) => i.detail === "queued"))).toBe(true)
    const progress = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "progress").map((p) => (p.data as { items: ReadonlyArray<{ label: string; value: string }> }).items)
    expect(progress.some((items) => items.some((i) => i.label === "busy" && i.value === "1/1"))).toBe(true)
  })

})


test("the run's view lists its testers: each with its progress and findings", async () => {
  const t = await finish()
  const list = t.pushes.filter((p) => p.agent === "run" && p.path === "testers").at(-1)?.data as { items: ReadonlyArray<{ id: string; text: string; detail?: string; state?: string }> }
  expect(list.items.map((i) => i.id)).toEqual(t.r.record(t.run)!.personas.map((_, i) => `tester-${i + 1}`))
  expect(list.items.every((i) => i.state === "done")).toBe(true)
  expect(list.items[0]!.detail).toMatch(/\d+\/\d+ scenes · \d+ found/)
})

describe("testers from the graph's personas", () => {
  test("no personas: refused, so the Driver Agent asks; personas that act in no scenario: refused", async () => {
    const none = await Effect.runPromise(Effect.flatMap(setup({ personas: [] }), (t) => t.r.start({})))
    expect(none).toEqual({ refused: "no personas yet: the Driver Agent asks about them" })
    const idle = await Effect.runPromise(Effect.flatMap(setup({ personas: [{ name: "Ghost", text: "nobody", scenarios: [] }] }), (t) => t.r.start({})))
    expect(idle).toEqual({ refused: "no persona acts in any scenario" })
  })

  // @scenario S-0105
  test("a tester walks only stories with its scenarios; others' scenes are context", async () => {
    const t = await finish({ personas: [{ name: "Operator", text: "The operator.", scenarios: ["A", "C"] }, { name: "Driver Agent", text: "The agent.", scenarios: ["B", "D"] }] })
    const screenedBy = (who: string) => t.decisions.filter((d) => d.questions.feel !== undefined && d.state.startsWith(`You are ${who}`)).map((d) => /The next step[\s\S]*When do (\w)/.exec(d.state)![1])
    // The operator judges A and C, never B or D; it sees B as what happened before C.
    expect([...new Set(screenedBy("The operator."))].sort()).toEqual(["A", "C"])
    expect(t.decisions.some((d) => d.state.startsWith("You are The operator.") && /do B[\s\S]*The next step[\s\S]*When do C/.test(d.state))).toBe(true)
    expect([...new Set(screenedBy("The agent."))].sort()).toEqual(["B", "D"])
  })

  test("a record from before personas walks every scenario", () => {
    expect(ownScenario({ name: "Operator", text: "The operator." }, "Z")).toBe(true)
    expect(ownScenario({ name: "Operator", text: "The operator.", scenarios: ["A"] }, "Z")).toBe(false)
  })
})

test("the findings columns colour by meaning: scenario, journey, severity keys", () => {
  expect(FEEDBACK_COLUMNS.map((c) => [c.id, "tone" in c ? c.tone : undefined, "tones" in c ? c.tones : undefined])).toEqual([
    ["scenario", undefined, undefined],
    ["journey", "journey", undefined],
    ["kind", undefined, undefined],
    ["severity", undefined, { high: "severity.high", medium: "severity.medium", low: "severity.low" }],
    ["now", undefined, { open: "attention", off: "dim", stale: "dim", planned: "accent", closed: "ok" }],
  ])
})

test("stories stop before a planned or untagged scenario (the run notes why); testers see the scene's code", async () => {
  const prompts: Array<string> = []
  const out = await finish({ built: { C: "planned", D: "untagged" }, prompts })
  // The same story twice after the cut is one story.
  expect(out.r.record(out.run)?.stories).toEqual([["A", "B"]])
  expect(out.r.record(out.run)?.infra).toEqual(expect.arrayContaining(["C: not built yet (planned): not walked", "D: no code tagged and not planned: tag its code or mark it planned"]))
  expect(prompts.some((p) => p.includes("What zarg does now") && p.includes('export const doB = () => "B code"'))).toBe(true)
})

test("the cut is said where the operator sees it: in the start result; with nothing built to walk the run is refused with why", async () => {
  const r = await Effect.runPromise(Effect.gen(function* () {
    const t = yield* setup({ built: { C: "planned", D: "untagged" } })
    const started = (yield* t.r.start({})) as { notes?: ReadonlyArray<string> }
    const t2 = yield* setup({ built: { A: "untagged" } })
    const refused = (yield* t2.r.start({})) as { refused?: string }
    return { started, refused }
  }))
  expect(r.started.notes).toEqual(["C: not built yet (planned): not walked", "D: no code tagged and not planned: tag its code or mark it planned"])
  expect(r.refused.refused).toBe("nothing built to walk: A: no code tagged and not planned: tag its code or mark it planned")
})
test("code that cannot be read (no git) checks no scenario: every scenario is walked, and the run says so", async () => {
  const r = await Effect.runPromise(Effect.gen(function* () {
    const t = yield* setup({ built: {}, codeDown: true })
    return (yield* t.r.start({})) as { notes?: ReadonlyArray<string>; stories: number }
  }))
  expect(r.stories).toBe(2)
  expect(r.notes).toEqual(["the scenarios' code could not be read: built or not, every scenario is walked"])
})
