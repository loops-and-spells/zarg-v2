import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type FiledEntry, makeRehearse, ownCard, type RunDeps } from "../src/run"
import { rehearseSettings } from "../src/settings"
import type { Answer, DecisionRequest, StepView } from "../src/types"
import { FEEDBACK_COLUMNS, RunView, TesterView } from "../src/views"

const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })

type Opts = { statusDown?: boolean; fileSome?: boolean; inFlight?: number; slowWrite?: number; down?: boolean; slowDecide?: number; gone?: ReadonlyArray<string>; state?: string; on?: boolean; unreachable?: number; personas?: ReadonlyArray<{ name: string; text: string; cards: ReadonlyArray<string> }>; files?: Map<string, string>; cardText?: (card: string) => string }
const setup = (o: Opts = {}) =>
  Effect.gen(function* () {
    const files = o.files ?? new Map<string, string>()
    const decisions: Array<DecisionRequest> = []
    const llm = { n: 0 }
    const events: Array<{ event: string; id: string; text?: string; progress?: { done: number; total: number } }> = []
    const filedCalls: Array<ReadonlyArray<FiledEntry>> = []
    const gone = new Set(o.gone ?? [])
    const writing = new Map<string, number>()
    const overlap = { max: 0 }
    const pushes: Array<{ agent: string; path: string; data?: unknown; lines?: unknown; view?: string }> = []
    let ids = 0
    const view = (card: string): StepView => ({ card, title: `card ${card}`, given: `before ${card}`, when: o.cardText?.(card) ?? `do ${card}`, thens: [`after ${card}`], fork: [], hasFailure: false, journeys: ["Checkout"], by: ["Operator"] })
    const deps: RunDeps = {
      personas: () => Effect.succeed(o.personas ?? [{ name: "Operator", text: "The operator, through the zarg TUI.", cards: ["A", "B", "C", "D"] }]),
      stories: () => Effect.succeed({ stories: [["A", "B", "C"], ["A", "B", "D"]], unreachable: o.unreachable ?? 0 }),
      step: (card) => Effect.succeed(view(card)),
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
          return { text: req.outputSchema ? JSON.stringify({ findings: [{ kind: "friction", severity: "medium", note: "B is unclear" }] }) : "Testers stalled at B." }
        }),
      agents: {
        start: (a) => Effect.sync(() => void events.push({ event: "start", id: a.id })),
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
      version: (card) => Effect.succeed(gone.has(card) ? null : `v${card.toLowerCase()}00000000000`.slice(0, 12)),
      file: (entries) => Effect.sync(() => (filedCalls.push(entries), { ids: entries.map((_, i) => (o.fileSome === true ? "" : `F-${i}`)) })),
      status: (ids) => (o.statusDown === true ? Effect.fail("down") : Effect.succeed(ids.map((id) => ({ id, state: o.state ?? "open", on: o.on ?? true })))),
      views: {
        set: (agent, v, path, data) => Effect.sync(() => void pushes.push({ agent, path, data, view: v.name })),
        append: (agent, _v, path, lines) => Effect.sync(() => void pushes.push({ agent, path, lines })),
      },
      surfaces: { open: (surface, agent) => Effect.sync(() => void events.push({ event: "open", id: agent, text: surface })) },
      settings: rehearseSettings({ ...(o.inFlight !== undefined ? { in_flight: o.inFlight } : {}) }, "stub:m"),
    }
    const r = yield* makeRehearse(deps)
    return { r, files, decisions, llm, events, filedCalls, overlap, pushes }
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

describe("rehearse runs in the plugin", () => {
  test("a run shows its progress in a status panel, opened before the first tester starts", async () => {
    const t = await finish()
    const open = t.events.findIndex((e) => e.event === "open")
    expect(t.events[open]).toEqual({ event: "open", id: "run", text: "status" })
    expect(open).toBeLessThan(t.events.findIndex((e) => e.event === "start" && e.id === "tester-1"))
    const line = t.pushes.filter((p) => p.agent === "run" && p.view === "status" && p.path === "line").at(-1)?.data as { items: ReadonlyArray<{ label: string; value: string }> }
    expect(line.items.map((i) => i.label)).toEqual(["rehearse", "testers"])
    expect(line.items[0]!.value).toMatch(/^\d+\/\d+ steps$/)
  })

  test("a run screens shared prefixes once, diagnoses only flagged steps, and files what it found", async () => {
    const t = await finish()
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(4)
    expect(t.llm.n).toBe(2)
    const rec = t.r.record(t.run)!
    expect(rec.findings.map((f) => [f.kind, f.card, f.route])).toEqual([["friction", "B", "fix"]])
    expect(rec.report).toBe("Testers stalled at B.")
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 feedback entry filed · triage in Feedback")
  })

  test("each finding: card, journey, kind and severity in the list, everything in its search text, and in full in the detail beside it", async () => {
    const t = await finish()
    const [row] = rowsNow(t.pushes, "tester-1", "review.feedback") as ReadonlyArray<{ id: string; cells: Record<string, string>; search?: string }>
    expect(row!.cells).toEqual({ card: "gherkin/card:B", journey: "Checkout", kind: "friction", severity: "medium", now: "open" })
    expect(row!.search).toContain("B is unclear")
    expect(row!.search).toContain("Operator")
    const detail = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "detail").at(-1)?.data as { rows: Record<string, string> }
    const md = detail.rows[row!.id]!
    expect(md).toContain("card B")
    expect(md).toContain("B is unclear")
    // Who and where on the card's By / In lines, so the highlighter colours them.
    expect(md).toContain("```gherkin\nBy    Operator\nIn    Checkout\nGiven before B\nWhen  do B\nThen  after B\n```")
  })

  test("a finished run files each finding with the backlog: the card's version, its journeys, and the run's first call", async () => {
    const t = await finish()
    expect(t.filedCalls).toEqual([
      [{ ref: "gherkin/card:B@vb0000000000", journeys: ["Checkout"], persona: "Operator", kind: "friction", severity: "medium", note: "B is unclear", from: { agent: "rehearse", run: t.run }, triage: { on: true, why: "fix · real 0.90" } }],
    ])
    expect(t.r.record(t.run)!.filed).toEqual({ [t.r.record(t.run)!.findings[0]!.id]: "F-0" })
  })

  test("a finding on a card that is gone is not filed", async () => {
    const t = await finish({ gone: ["B"] })
    expect(t.filedCalls).toEqual([])
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

  test("a decision-model outage leaves steps unscreened and counted; only the report reaches the model", async () => {
    const t = await finish({ down: true })
    expect(Object.values(t.r.record(t.run)!.screened).every((v) => v === null)).toBe(true)
    expect(t.r.record(t.run)!.findings).toEqual([])
    expect(t.llm.n).toBe(1)
  })

  test("a run left running resumes from its record without screening finished steps again", async () => {
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

  test("stop keeps the partial record, marked stopped", async () => {
    const t = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* setup({ slowDecide: 20 })
        const s = (yield* t.r.start({})) as { run: string }
        yield* t.r.stop
        return { ...t, run: s.run }
      }),
    )
    expect(t.r.record(t.run)!.status).toBe("stopped")
  })

  test("a tester's progress only goes up, to distinct steps checked out of those to check", async () => {
    const t = await finish({ slowDecide: 3, unreachable: 2 })
    const rows = t.events.filter((e) => e.id === "tester-1" && e.event === "status").map((e) => e.progress!)
    expect(rows.map((r) => r.done)).toEqual([...rows.map((r) => r.done)].sort((a, b) => a - b))
    expect(rows.at(-1)).toEqual({ done: 4, total: 4 })
    expect(t.pushes.filter((p) => p.agent === "tester-1" && p.path === "steps").flatMap((p) => p.lines as ReadonlyArray<{ text: string }>).map((l) => l.text)).toContain("B: feel 1.00, fail 0.30 → flagged feel → 1 finding")
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 feedback entry filed · triage in Feedback · 2 unreachable")
  })

  test("writes of one record never overlap, so a record is never half-written", async () => {
    const t = await finish({ slowWrite: 2 })
    expect(t.overlap.max).toBe(1)
  })

  test("the tester's view: workers follow the walk, steps are logged, its findings fill the review table", async () => {
    const t = await finish({ slowDecide: 3 })
    const workers = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "workers").map((p) => p.data as { items: ReadonlyArray<{ state?: string; detail?: string }> })
    expect(workers.some((w) => w.items.some((i) => i.state === "busy"))).toBe(true)
    // Both stories start with A, B: one screens the shared step, the other waits for it.
    expect(workers.some((w) => w.items.some((i) => i.state === "waiting"))).toBe(true)
    expect(workers.at(-1)!.items).toEqual([])
    expect(t.pushes.filter((p) => p.agent === "tester-1" && p.path === "steps").flatMap((p) => p.lines as ReadonlyArray<{ text: string }>).map((l) => l.text)).toContain("B: feel 1.00, fail 0.30 → flagged feel → 1 finding")
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
  expect(list.items[0]!.detail).toMatch(/\d+\/\d+ steps · \d+ found/)
})

describe("testers from the graph's personas", () => {
  test("no personas: refused, so the Driver Agent asks; personas that act in no card: refused", async () => {
    const none = await Effect.runPromise(Effect.flatMap(setup({ personas: [] }), (t) => t.r.start({})))
    expect(none).toEqual({ refused: "no personas yet: the Driver Agent asks about them" })
    const idle = await Effect.runPromise(Effect.flatMap(setup({ personas: [{ name: "Ghost", text: "nobody", cards: [] }] }), (t) => t.r.start({})))
    expect(idle).toEqual({ refused: "no persona acts in any card" })
  })

  test("a tester walks only stories with its cards; others' steps are context", async () => {
    const t = await finish({ personas: [{ name: "Operator", text: "The operator.", cards: ["A", "C"] }, { name: "Driver Agent", text: "The agent.", cards: ["B", "D"] }] })
    const screenedBy = (who: string) => t.decisions.filter((d) => d.questions.feel !== undefined && d.state.startsWith(`You are ${who}`)).map((d) => /The next step[\s\S]*When do (\w)/.exec(d.state)![1])
    // The operator judges A and C, never B or D; it sees B as what happened before C.
    expect([...new Set(screenedBy("The operator."))].sort()).toEqual(["A", "C"])
    expect(t.decisions.some((d) => d.state.startsWith("You are The operator.") && /do B[\s\S]*The next step[\s\S]*When do C/.test(d.state))).toBe(true)
    expect([...new Set(screenedBy("The agent."))].sort()).toEqual(["B", "D"])
  })

  test("a record from before personas walks every card", () => {
    expect(ownCard({ name: "Operator", text: "The operator." }, "Z")).toBe(true)
    expect(ownCard({ name: "Operator", text: "The operator.", cards: ["A"] }, "Z")).toBe(false)
  })
})

test("the findings columns colour by meaning: card, journey, severity keys", () => {
  expect(FEEDBACK_COLUMNS.map((c) => [c.id, "tone" in c ? c.tone : undefined, "tones" in c ? c.tones : undefined])).toEqual([
    ["card", undefined, undefined],
    ["journey", "journey", undefined],
    ["kind", undefined, undefined],
    ["severity", undefined, { high: "severity.high", medium: "severity.medium", low: "severity.low" }],
    ["now", undefined, { open: "attention", off: "dim", stale: "dim", planned: "accent", closed: "ok" }],
  ])
})
