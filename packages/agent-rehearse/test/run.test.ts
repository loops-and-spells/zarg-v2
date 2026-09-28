import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeRehearse, ownCard, type RunDeps } from "../src/run"
import { rehearseSettings } from "../src/settings"
import type { Answer, DecisionRequest, StepView } from "../src/types"

const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })

type Opts = { inFlight?: number; slowWrite?: number; down?: boolean; slowDecide?: number; auto?: boolean; unreachable?: number; personas?: ReadonlyArray<{ name: string; text: string; cards: ReadonlyArray<string> }>; files?: Map<string, string>; cardText?: (card: string) => string }
const setup = (o: Opts = {}) =>
  Effect.gen(function* () {
    const files = o.files ?? new Map<string, string>()
    const decisions: Array<DecisionRequest> = []
    const llm = { n: 0 }
    const events: Array<{ event: string; id: string; text?: string; progress?: { done: number; total: number } }> = []
    let changed = 0
    const writing = new Map<string, number>()
    const overlap = { max: 0 }
    const pushes: Array<{ agent: string; path: string; data?: unknown; lines?: unknown; view?: string }> = []
    const attention: Array<[string, string | undefined]> = []
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
      agendaChanged: Effect.sync(() => void changed++),
      attention: {
        request: (agent, reason) => Effect.sync(() => void attention.push([agent, reason])),
        clear: (agent) => Effect.sync(() => void attention.push([agent, undefined])),
      },
      views: {
        set: (agent, v, path, data) => Effect.sync(() => void pushes.push({ agent, path, data, view: v.name })),
        append: (agent, _v, path, lines) => Effect.sync(() => void pushes.push({ agent, path, lines })),
      },
      surfaces: { open: (surface, agent) => Effect.sync(() => void events.push({ event: "open", id: agent, text: surface })) },
      settings: rehearseSettings({ ...(o.auto ? { auto_apply: true } : {}), ...(o.inFlight !== undefined ? { in_flight: o.inFlight } : {}) }, "stub:m"),
    }
    const r = yield* makeRehearse(deps)
    return { r, files, decisions, llm, events, changed: () => changed, overlap, pushes, attention }
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

  test("a run screens shared prefixes once, diagnoses only flagged steps, and by default applies nothing", async () => {
    const t = await finish()
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(4)
    expect(t.llm.n).toBe(2)
    const rec = t.r.record(t.run)!
    expect(rec.findings.map((f) => [f.kind, f.card, f.route])).toEqual([["friction", "B", "fix"]])
    expect(rec.report).toBe("Testers stalled at B.")
    expect(t.r.agenda()).toEqual([])
    expect(t.changed()).toBe(0)
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 finding to review")
  })

  test("each finding: card, journey, kind and severity in the list, everything in its search text, and in full in the detail beside it", async () => {
    const t = await finish()
    const [row] = rowsNow(t.pushes, "run", "review.findings") as ReadonlyArray<{ id: string; cells: Record<string, string>; search?: string }>
    expect(row!.cells).toEqual({ card: "B", journey: "Checkout", kind: "friction", severity: "medium" })
    expect(row!.search).toContain("B is unclear")
    expect(row!.search).toContain("Operator")
    const detail = t.pushes.filter((p) => p.agent === "run" && p.path === "detail").at(-1)?.data as { rows: Record<string, string> }
    const md = detail.rows[row!.id]!
    expect(md).toContain("card B")
    expect(md).toContain("by Operator")
    expect(md).toContain("in Checkout")
    expect(md).toContain("B is unclear")
    expect(md).toContain("```gherkin\nGiven before B\nWhen  do B\nThen  after B\n```")
  })

  test("the tables list the findings; apply sends only the chosen ones to the agenda and says so to the host", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    expect(rowsNow(t.pushes, "run", "review.findings").map((r) => r.id)).toEqual([id])
    expect(rowsNow(t.pushes, "run", "review.likes")).toEqual([])
    expect(await Effect.runPromise(t.r.finding(id))).toMatchObject({ chosen: false, stale: false })
    expect(await Effect.runPromise(t.r.act("apply", "review.findings", [id]))).toEqual({ notice: "sent 1 finding to zarg" })
    expect(t.r.agenda()).toEqual([expect.objectContaining({ title: expect.stringContaining("1 finding the developer sent to zarg") })])
    expect(t.changed()).toBe(1)
    expect(await Effect.runPromise(t.r.finding(id))).toMatchObject({ chosen: true })
  })

  test("chosen findings survive a restart", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    await Effect.runPromise(t.r.act("apply", "review.findings", [id]))
    const again = await Effect.runPromise(setup({ files: t.files }))
    expect(again.r.agenda().length).toBe(1)
  })

  test("dismissed findings stay dismissed on a rerun while the card is unchanged", async () => {
    const t = await finish()
    await Effect.runPromise(t.r.act("dismiss", "review.findings", [t.r.record(t.run)!.findings[0]!.id]))
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = (yield* t.r.start({})) as { run: string }
        yield* until(() => t.r.record(s.run)?.status === "done")
      }),
    )
    expect(rowsNow(t.pushes, "run", "review.findings")).toEqual([])
  })

  test("a finding whose card changed since the run is stale", async () => {
    let text = "do B"
    const t = await finish({ cardText: (c) => (c === "B" ? text : `do ${c}`) })
    text = "do B differently"
    expect(await Effect.runPromise(t.r.finding(t.r.record(t.run)!.findings[0]!.id))).toMatchObject({ stale: true })
  })

  test("auto_apply sends the decision model's local fixes to the agenda on its own", async () => {
    const t = await finish({ auto: true })
    expect(t.r.agenda().length).toBe(1)
    expect(t.changed()).toBe(1)
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
        raw: [], infra: [], findings: [], applying: [], resolved: [],
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
    expect(t.events.filter((e) => e.id === "run" && e.event === "status").at(-1)?.text).toBe("1 finding to review · 2 unreachable")
  })

  test("writes of one record never overlap, so a record is never half-written", async () => {
    const t = await finish({ slowWrite: 2 })
    expect(t.overlap.max).toBe(1)
  })

  test("a finding chosen in one run stays takeable after a later run reports it again unchosen", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    await Effect.runPromise(t.r.act("apply", "review.findings", [id]))
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = (yield* t.r.start({})) as { run: string }
        yield* until(() => t.r.record(s.run)?.status === "done")
      }),
    )
    expect(await Effect.runPromise(t.r.finding(id))).toMatchObject({ run: t.run, chosen: true })
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
    const review = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "review.findings").at(-1)!.data as { rows: ReadonlyArray<{ id: string }> }
    expect(review.rows.map((r) => r.id)).toEqual([id])
  })

  test("the run's view: progress over all testers, the report, every finding; apply refreshes it", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    expect(t.pushes.find((p) => p.agent === "run" && p.path === "report")?.data).toEqual({ markdown: "Testers stalled at B." })
    expect(await Effect.runPromise(t.r.act("apply", "review.findings", [id]))).toEqual({ notice: "sent 1 finding to zarg" })
    // Sent: its row turns green in the list, and the detail says so.
    const last = t.pushes.filter((p) => p.agent === "run" && p.path === "review.findings").at(-1)!.data as { rows: ReadonlyArray<{ id: string; tone?: string }> }
    expect(last.rows[0]!.tone).toBe("ok")
    const detail = t.pushes.filter((p) => p.agent === "run" && p.path === "detail").at(-1)!.data as { rows: Record<string, string> }
    expect(detail.rows[last.rows[0]!.id]).toContain("✓ sent to zarg")
  })

  test("while a run goes, actions are refused and the last run's tables do not replace the live ones", async () => {
    const t = await finish()
    const id = t.r.record(t.run)!.findings[0]!.id
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const s = (yield* t.r.start({})) as { run: string }
        const before = t.pushes.length
        const notice = yield* t.r.act("apply", "review.findings", [id])
        const clobbered = t.pushes.slice(before).some((p) => p.path.startsWith("review.") && ((p.data as { rows?: ReadonlyArray<{ id: string }> }).rows ?? []).some((r) => r.id === id))
        yield* until(() => t.r.record(s.run)?.status === "done")
        return { notice, clobbered }
      }),
    )
    expect(out.notice.notice).toContain("still going")
    expect(out.clobbered).toBe(false)
    expect(t.r.record(t.run)!.applying).toEqual([])
  })

  test("an action names only findings the finished run has; raw rows during a run have unique ids", async () => {
    const t = await finish()
    expect(await Effect.runPromise(t.r.act("apply", "review.findings", ["The developer|B|friction"]))).toEqual({ notice: "no such findings in the last run" })
    expect(t.r.record(t.run)!.applying).toEqual([])
    const raw = t.pushes.filter((p) => p.agent === "tester-1" && p.path === "review.findings").map((p) => (p.data as { rows: ReadonlyArray<{ id: string }> }).rows.map((r) => r.id))
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

  test("a tester with findings to review asks for attention; acting on the last one ends it", async () => {
    const t = await finish()
    expect(t.attention.filter(([a]) => a === "tester-1").at(-1)).toEqual(["tester-1", "1 finding to review"])
    const id = t.r.record(t.run)!.findings[0]!.id
    await Effect.runPromise(t.r.act("apply", "review.findings", [id]))
    expect(t.attention.filter(([a]) => a === "tester-1").at(-1)).toEqual(["tester-1", undefined])
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
