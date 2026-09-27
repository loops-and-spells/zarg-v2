// packages/core/test/rehearse-run.test.ts
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import type { Model, StreamEvent } from "@zarg/model"
import { makeLog } from "../src/log"
import { makeRehearse, type RehearseDeps } from "../src/rehearse/run"
import { rehearseSettings } from "../src/rehearse/settings"

const INTENT = "## Affected users and systems\n\n- The developer, through the zarg TUI.\n"
const view = (card: string) => ({ card, title: card, given: `before ${card}`, when: `do ${card}`, thens: [`after ${card}`], fork: [], hasFailure: false })
const noul = (p: number): Answer => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })
/** Decisions: every step fine except card "B" (low feel); the persona is a person; findings are real local fixes. */
const decide = (calls: Array<DecisionRequest>, down = false) => (req: DecisionRequest) =>
  Effect.suspend((): Effect.Effect<Readonly<Record<string, Answer>>, string> => {
    calls.push(req)
    if (req.questions.person) return Effect.succeed({ person: noul(0.9) })
    if (req.questions.real) return Effect.succeed({ real: noul(0.9), route: { type: "choice", choice: "fix", probabilities: { fix: 1 }, confidence: 1 } as Answer })
    if (down) return Effect.fail("down")
    return Effect.succeed({ feel: { type: "score", score: req.state.includes("When do B") ? 1.0 : 1.8, level: "fine", probabilities: [], confidence: 0 } as Answer, fail: noul(0.3), arrive: noul(0.7) })
  })
const model = (calls: { n: number }) =>
  ({
    stream: (req: { outputSchema?: unknown }) => {
      calls.n++
      const text = req.outputSchema ? JSON.stringify({ findings: [{ kind: "friction", severity: "medium", note: "B is unclear" }] }) : "Testers stalled at B."
      return Stream.fromIterable<StreamEvent>([{ type: "text", delta: text }, { type: "done", finishReason: "stop" }])
    },
  }) as unknown as Model.Model["Service"]

const setup = (opts: { down?: boolean; dir?: string } = {}) =>
  Effect.gen(function* () {
    const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "zarg-rehearse-"))
    const log = yield* makeLog(join(dir, "threads"), (t) => t)
    const decisions: Array<DecisionRequest> = []
    const llm = { n: 0 }
    const said: Array<string> = []
    let woke = 0
    const deps: RehearseDeps = {
      dir: join(dir, "rehearse"),
      log,
      stories: () => Effect.succeed({ stories: [["A", "B", "C"], ["A", "B", "D"]], unreachable: 0 }),
      step: (card) => Effect.succeed(view(card)),
      decide: decide(decisions, opts.down),
      model: model(llm),
      settings: rehearseSettings({}, { driver: "stub:m" }),
      intent: () => INTENT,
      built: () => Effect.succeed(false),
      announce: (t) => Effect.sync(() => void said.push(t)),
      wake: Effect.sync(() => void woke++),
    }
    const r = yield* makeRehearse(deps)
    return { r, dir, decisions, llm, said, woke: () => woke }
  })
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i++) yield* Effect.sleep(10)
  })

describe("rehearse run", () => {
  test("a run starts at once, screens shared prefixes once, diagnoses only flagged steps, and lands one agenda item", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* setup()
          const started = yield* t.r.start({})
          yield* until(() => t.r.record((started as { run: string }).run)?.status === "done")
          return { t, started }
        }),
      ),
    )
    const { t, started } = out
    expect(started).toMatchObject({ stories: 2, steps: 6, personas: ["The developer"] })
    const run = (started as { run: string }).run
    const rec = t.r.record(run)!
    // A, A>B shared: 4 distinct prefixes (A, A>B, A>B>C, A>B>D), one person question.
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(4)
    expect(t.llm.n).toBe(2) // one diagnosis (B) and one report
    expect(rec.findings.map((f) => [f.kind, f.card, f.route])).toEqual([["friction", "B", "fix"]])
    expect(rec.report).toBe("Testers stalled at B.")
    expect(t.r.agenda()).toEqual([expect.objectContaining({ id: `rehearse:${run}`, title: `Rehearse run ${run}: 1 finding`, priority: 0 })])
    expect(t.said.at(-1)).toContain("1 finding")
    expect(t.woke()).toBe(1)
    expect(existsSync(join(t.dir, "rehearse", `${run}.json`))).toBe(true)
  })

  test("a second run is refused while one is going", async () => {
    const second = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const t = yield* setup()
      yield* t.r.start({})
      return yield* t.r.start({})
    })))
    expect(second).toMatchObject({ refused: expect.stringContaining("is still going") })
  })

  test("a decision-model outage leaves steps unscreened and counted", async () => {
    const t = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const t = yield* setup({ down: true })
      const s = yield* t.r.start({})
      yield* until(() => t.r.record((s as { run: string }).run)?.status === "done")
      return { ...t, run: (s as { run: string }).run }
    })))
    const rec = t.r.record(t.run)!
    expect(Object.values(rec.screened).every((v) => v === null)).toBe(true)
    expect(rec.findings).toEqual([])
    expect(t.llm.n).toBe(1) // the report only
  })

  test("a run left running resumes from its record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-rehearse-"))
    const run = "r-resume"
    const screened = { "The developer|A": { feel: 1.8, fail: 0.3, arrive: 0.7, flags: [] }, "The developer|A>B": { feel: 1.0, fail: 0.3, arrive: 0.7, flags: ["feel"] } }
    await Bun.write(join(dir, "rehearse", `${run}.json`), JSON.stringify({ run, status: "running", strategy: "edge-pair", focus: [], personas: [{ name: "The developer", text: "The developer, through the zarg TUI." }], stories: [["A", "B", "C"], ["A", "B", "D"]], unreachable: 0, screened, raw: [], infra: [], findings: [], triaged: false, resolved: [] }))
    const t = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const t = yield* setup({ dir })
      yield* t.r.resume
      yield* until(() => t.r.record(run)?.status === "done")
      return t
    })))
    expect(t.decisions.filter((d) => d.questions.feel).length).toBe(2) // only A>B>C and A>B>D
    expect(t.r.record(run)!.status).toBe("done")
  })

  test("stop keeps the partial record, marked stopped", async () => {
    const t = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const t = yield* setup()
      const s = yield* t.r.start({})
      yield* t.r.stop
      yield* until(() => t.r.record((s as { run: string }).run)?.status !== "running")
      return { ...t, run: (s as { run: string }).run }
    })))
    expect(t.r.record(t.run)!.status).toBe("stopped")
    expect(t.r.agenda()).toEqual([])
  })
})
