import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import { Model, ModelError } from "@zarg/model"
import { bind, type Bound, defineService } from "@zarg/kernel"
import { Schema } from "effect"
import { fs, fsRead, type Plan, planProblems, Rlm, type Scope, settings, waves } from "../src"
import { type Reply, stubModel } from "./stub-model"

const child = (id: string, dependsOn: ReadonlyArray<string> = [], preset = "research") => ({ id, task: `do ${id}`, preset, paths: [], focus: [], dependsOn })

describe("plan checks", () => {
  test("waves follow dependsOn; a cycle has no waves", () => {
    const plan: Plan = { children: [child("a"), child("b", ["a"]), child("c"), child("d", ["b", "c"])] }
    expect(waves(plan)!.map((w) => w.map((c) => c.id))).toEqual([["a", "c"], ["b"], ["d"]])
    expect(waves({ children: [child("a", ["b"]), child("b", ["a"])] })).toBeUndefined()
  })

  test("problems: count, duplicates, unknown deps, disallowed presets, cycles", () => {
    expect(planProblems({ children: [child("a")] }, ["research"])).toEqual(["a plan has 2 to 8 children, got 1"])
    expect(planProblems({ children: [child("a"), child("a")] }, ["research"])).toContain('duplicate child id "a"')
    expect(planProblems({ children: [child("a", ["zz"]), child("b")] }, ["research"])).toContain('a depends on unknown "zz"')
    expect(planProblems({ children: [child("a", [], "fix"), child("b")] }, ["research"])[0]).toContain('preset "fix" is not one you may spawn')
    expect(planProblems({ children: [child("a", ["b"]), child("b", ["a"])] }, ["research"])).toEqual(["dependsOn has a cycle"])
  })
})

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zarg-fold-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/**
 * Decisions stub. Atomize: the root task ("big") is atomic only when `atomic` is true; planned children
 * are always atomic, so they do not plan again. Verify answers come from `verdict`.
 */
const decisions = (atomic: boolean, verdict = { answer: true, confidence: 0.9 }, atomizeConfidence = 0.9) => {
  const calls: Array<DecisionRequest> = []
  return {
    calls,
    service: {
      decide: (req: DecisionRequest) =>
        Effect.sync(() => {
          calls.push(req)
          const answer = (yes: boolean, confidence: number): Answer => ({ type: "noul", answer: yes, probability: yes ? confidence : 1 - confidence, confidence })
          const root = req.state.startsWith("Task: big")
          return Object.fromEntries(Object.keys(req.questions).map((k) => [k, k === "ok" ? answer(verdict.answer, verdict.confidence) : answer(root ? atomic : true, root ? atomizeConfidence : 0.9)]))
        }),
    },
  }
}

let gatePasses = true
const VerifyDef = defineService("Verify", "gate", { run: { doc: "gate", params: Schema.Struct({}), success: Schema.Struct({ passed: Schema.Boolean, output: Schema.String }) } })
const factory = (name: string, scope: Scope): Bound | undefined => {
  if (name === "Fs") return fs({ root, scope, sensitive: [] })
  if (name === "Fs:read") return fsRead({ root, scope, sensitive: [] })
  if (name === "Verify") return bind(VerifyDef, { run: () => Effect.succeed({ passed: gatePasses, output: gatePasses ? "ok" : "2 tests failed" }) })
  return undefined
}

const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, d: ReturnType<typeof decisions>, raw: unknown = {}, observe?: (e: Rlm.RlmEvent) => void) => {
  const stub = stubModel(scripts)
  return Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings(raw)
      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", implement: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000, ...(observe ? { observe } : {}) })
      return yield* Effect.exit(rlm.exec(spec))
    }).pipe(Effect.provide(stub.layer)),
  ).then((exit) => ({ exit, seen: stub.seen }))
}
const value = (r: { exit: any }) => {
  if (r.exit._tag !== "Success") throw new Error(JSON.stringify(r.exit.cause))
  return r.exit.value.value
}
const planText = (p: Plan) => ({ text: JSON.stringify(p) })
const researchDone = (finding: string): Reply => ({ cell: `yield* Rlm.done({ value: { findings: [${JSON.stringify(finding)}], sources: [] } })` })

describe("folding", () => {
  test("an atomic task runs directly: no plan is requested", async () => {
    const d = decisions(true)
    const r = await run({ driver: [{ cell: 'yield* Rlm.done({ value: "direct" })' }] }, { task: "small", preset: "driver", scope: {} }, d)
    expect(value(r)).toBe("direct")
    expect(r.seen.some((s) => s.preset === "plan")).toBe(false)
    expect(Object.keys(d.calls[0]!.questions)).toEqual(["single", "oneExecutor", "noSteps", "noPackaging", "noCoordination"])
  })

  test("the atomize event carries each criterion's answer and confidence", async () => {
    const events: Array<Rlm.RlmEvent> = []
    await run({ driver: [{ cell: 'yield* Rlm.done({ value: "direct" })' }] }, { task: "small", preset: "driver", scope: {} }, decisions(true), {}, (e) => events.push(e))
    const a = events.find((e) => e.type === "atomize")
    expect(a?.type === "atomize" && a.atomic).toBe(true)
    expect(a?.type === "atomize" && typeof a.ms).toBe("number")
    expect(a?.type === "atomize" && a.criteria).toEqual(
      ["single", "oneExecutor", "noSteps", "noPackaging", "noCoordination"].map((name) => ({ name, answer: true, confidence: 0.9 })),
    )
  })

  test("a non-atomic task is planned; children run in dependency order; the parent folds `children`", async () => {
    const plan: Plan = { children: [child("c1"), child("c2", ["c1"])] }
    const r = await run(
      {
        plan: [planText(plan)],
        research: [researchDone("first"), researchDone("second")],
        driver: [{ cell: "yield* Rlm.done({ value: children.map((c: any) => c.value.findings[0]).join(' then ') })" }],
      },
      { task: "big", preset: "driver", scope: {} },
      decisions(false),
    )
    expect(value(r)).toBe("first then second")
    const secondChild = r.seen.filter((s) => s.preset === "research")[1]!.messages
    expect(String(secondChild[1]!.content)).toContain("Results you depend on:\n- c1:")
    expect(String(secondChild[1]!.content)).toContain('"first"')
  })

  test("a plan that cannot run is sent back once with its problems", async () => {
    const bad: Plan = { children: [child("a")] }
    const good: Plan = { children: [child("a"), child("b")] }
    const r = await run(
      { plan: [planText(bad), planText(good)], research: [researchDone("x")], driver: [{ cell: 'yield* Rlm.done({ value: "ok" })' }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false),
    )
    expect(value(r)).toBe("ok")
    const retry = r.seen.filter((s) => s.preset === "plan")[1]!.messages
    expect(String(retry[1]!.content)).toContain("a plan has 2 to 8 children, got 1")
  })

  test("two bad plans fail the RLM with a plan error", async () => {
    const bad: Plan = { children: [child("a", ["a"]), child("b")] }
    const r = await run({ plan: [planText(bad)] }, { task: "big", preset: "driver", scope: {} }, decisions(false))
    const exit = r.exit as any
    expect(exit._tag).toBe("Failure")
    expect(exit.cause.reasons[0].error).toMatchObject({ kind: "plan" })
  })

  test("a child whose gate fails reaches the parent as an explicit verify failure", async () => {
    gatePasses = false
    const plan: Plan = { children: [child("i1", [], "implement-card"), child("r1")] }
    const r = await run(
      {
        plan: [planText(plan)],
        "implement-card": [{ cell: 'yield* Rlm.done({ value: { files: ["src/a.ts"], summary: "edited" } })' }],
        research: [researchDone("fine")],
        lead: [{ cell: "yield* Rlm.done({ value: JSON.stringify(children.map((c: any) => [c.id, c.ok, c.kind ?? null])) })" }],
      },
      { task: "big", preset: "lead", scope: { paths: ["src/**"] } },
      decisions(false),
      { presets: { lead: { layer: ["Graph", "Fs", "Sh", "Verify", "Decisions", "Rlm"], spawns: ["implement-card", "research"], role: "implement", result: "text", verify: "gate" } } },
    )
    gatePasses = true
    expect(JSON.parse(value(r))).toEqual([["i1", false, "verify"], ["r1", true, null]])
    const note = String(r.seen.filter((s) => s.preset === "lead")[0]!.messages.at(-1)?.content)
    expect(note).toContain("2 tests failed")
  })

  test("a decision check below the confidence threshold fails the child", async () => {
    const raw = { presets: { research: { layer: ["Fs:read", "Rlm"], spawns: ["research"], role: "driver", result: "research", verify: "decision" } } }
    const plan: Plan = { children: [child("a"), child("b")] }
    const r = await run(
      { plan: [planText(plan)], research: [researchDone("weak")], driver: [{ cell: "yield* Rlm.done({ value: String(children.every((c: any) => c.ok === false && c.kind === 'verify')) })" }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false, { answer: true, confidence: 0.2 }),
      raw,
    )
    expect(value(r)).toBe("true")
  })

  test("a child that runs out of budget is reported, not silently dropped", async () => {
    const raw = { presets: { research: { layer: ["Fs:read", "Rlm"], spawns: ["research"], role: "driver", result: "research", verify: "none", budget: { turns: 1 } } } }
    const plan: Plan = { children: [child("a"), child("b")] }
    const r = await run(
      { plan: [planText(plan)], research: [{ cell: "return 1" }], driver: [{ cell: "yield* Rlm.done({ value: children.map((c: any) => c.kind).join(',') })" }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false),
      raw,
    )
    expect(value(r)).toBe("budget,budget")
  })

  test("at max depth a task executes without atomizing", async () => {
    const d = decisions(false)
    const r = await run({ driver: [{ cell: 'yield* Rlm.done({ value: "leaf" })' }] }, { task: "t", preset: "driver", scope: {} }, d, { max_depth: 0 })
    expect(value(r)).toBe("leaf")
    expect(d.calls.length).toBe(0)
  })

  test("when Decisions cannot answer, the task executes directly", async () => {
    const failing = { calls: [] as Array<DecisionRequest>, service: { decide: () => Effect.fail({ _tag: "DecisionError" as const, kind: "unavailable" as const, message: "down" }) } }
    const r = await run({ driver: [{ cell: 'yield* Rlm.done({ value: "direct" })' }] }, { task: "t", preset: "driver", scope: {} }, failing as never)
    expect(value(r)).toBe("direct")
  })

  test("a hedging decision model does not trigger planning: only a confident no plans", async () => {
    const hedging = await run({ driver: [{ cell: 'yield* Rlm.done({ value: "direct" })' }] }, { task: "big", preset: "driver", scope: {} }, decisions(false, undefined, 0.1))
    expect(value(hedging)).toBe("direct")
    expect(hedging.seen.some((s) => s.preset === "plan")).toBe(false)
  })

  test("the children note is capped; the global keeps everything", async () => {
    const huge = "z".repeat(20000)
    const plan: Plan = { children: [child("a"), child("b")] }
    const r = await run(
      { plan: [planText(plan)], research: [researchDone(huge)], driver: [{ cell: "yield* Rlm.done({ value: String(children[0].value.findings[0].length) })" }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false),
    )
    expect(value(r)).toBe("20000")
    const note = String(r.seen.filter((s) => s.preset === "driver")[0]!.messages.at(-1)?.content)
    expect(note.length).toBeLessThan(3000)
  })

  test("when the decision check cannot run, the child's work is kept and marked unverified", async () => {
    const raw = { presets: { research: { layer: ["Fs:read", "Rlm"], spawns: ["research"], role: "driver", result: "research", verify: "decision" } } }
    const plan: Plan = { children: [child("a"), child("b")] }
    const base = decisions(false)
    const flaky = {
      calls: base.calls,
      service: {
        decide: (req: DecisionRequest) =>
          "ok" in req.questions ? Effect.fail({ _tag: "DecisionError" as const, kind: "deadline" as const, message: "slow" }) : base.service.decide(req),
      },
    }
    const r = await run(
      { plan: [planText(plan)], research: [researchDone("kept")], driver: [{ cell: "yield* Rlm.done({ value: JSON.stringify(children.map((c: any) => [c.ok, c.unverified ?? null, c.value?.findings[0] ?? null])) })" }] },
      { task: "big", preset: "driver", scope: {} },
      flaky as never,
      raw,
    )
    expect(JSON.parse(value(r))).toEqual([[true, "the result could not be checked", "kept"], [true, "the result could not be checked", "kept"]])
  })

  test("[rlm.atomize] min_confidence from config is used", async () => {
    const r = await run(
      { plan: [planText({ children: [child("a"), child("b")] })], research: [researchDone("x")], driver: [{ cell: 'yield* Rlm.done({ value: "done" })' }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false, undefined, 0.3),
      { atomize: { min_confidence: 0.2 } },
    )
    expect(value(r)).toBe("done")
    expect(r.seen.some((s) => s.preset === "plan")).toBe(true)
  })

  test("time spent in children does not use up the parent's wall budget", async () => {
    const raw = { presets: { driver: { layer: ["Rlm"], spawns: ["research"], role: "driver", result: "text", verify: "none", budget: { wallMs: 300 } }, research: { layer: ["Rlm"], role: "driver", result: "research", verify: "none" } } }
    const slow: Reply = { cell: 'const end = Date.now() + 400\nwhile (Date.now() < end) {}\nyield* Rlm.done({ value: { findings: ["slow"], sources: [] } })' }
    const r = await run(
      { plan: [planText({ children: [child("a"), child("b")] })], research: [slow], driver: [{ cell: "return children.length" }, { cell: 'yield* Rlm.done({ value: "combined" })' }] },
      { task: "big", preset: "driver", scope: {} },
      decisions(false),
      raw,
    )
    expect(value(r)).toBe("combined")
  })

  test("a model error while planning is a model error, not a plan error", async () => {
    const stub = stubModel({})
    const failing = Layer.succeed(Model.Model, { ...stub.service, stream: (req: any) => (req.outputSchema ? Stream.fail(new ModelError({ kind: "transport", message: "router down" })) : stub.service.stream(req)) })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* settings({})
        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, decisions: decisions(false).service, cellTimeoutMs: 5000 })
        return yield* Effect.exit(rlm.exec({ task: "big", preset: "driver", scope: {} }))
      }).pipe(Effect.provide(failing)),
    )
    expect((exit as any).cause.reasons[0].error).toMatchObject({ kind: "model" })
  })
})
