# Phase 2a-4: Folding and Live Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ROMA-informed folding to the RLM (atomize with Decisions, typed plans run in dependency waves, verification before a child's result folds into its parent), expose Decisions to cells, and run the first live RLM against real models.

**Architecture:** Before its first turn, an RLM that may spawn children asks `Decisions` five yes/no questions (ROMA's atomic test). Atomic tasks run as before. Otherwise one structured-output call returns a plan of 2-8 children (preset, scope, dependsOn); the host checks it against the spawn graph and for cycles, retries once with the problems, runs the children in waves, verifies each result (the preset's `gate` or `decision` check), and hands the parent a `children` global plus a note. Failed children are explicit entries, never dropped.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117`, `@zarg/rlm`, `@zarg/decisions`, `@zarg/kernel`.

**Spec:** `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` (Folding; build step 8). Research: `outputs/roma-folding-research.md`.

## Global Constraints

- Run bun only as `mise x -- bun ...`.
- Tests never call a real model: the stub `Model` answers plan requests (structured output) from a `plan` script, and a stub `Decisions` answers atomize and verify questions.
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- The live smoke test (`mise run smoke`) is outside `verify`. It warms a model on the developer's GPU (zarg-router may evict other models), so **ask the developer before running it**.
- Every code block was prototyped and passes (`mise run verify`: 203 tests).

### Deliberate differences from the spec

- The `children` global is typed `any` in the parent's cells (persisted like any earlier-cell name); its shape is shown to the model in the note. A typed manifest entry per plan would need a manifest rebuild mid-run.
- A plan's scope is expressed as `paths` and `focus` arrays (strict structured output requires every property); `focus` maps to a graph scope with `k = 2`.
- If `Decisions` cannot answer, the task executes directly (logged) rather than failing.
- Plan requests take a model-turn permit like any turn, so `max_concurrent` bounds them too.

## Review Focus

1. Planned children must not plan again by accident: a child's own atomize decides (the fold tests' `Decisions` stub makes children atomic; a real model answering "not atomic" at every level recurses until `max_depth`, which is the backstop).
2. A failed, unverified or out-of-budget child must appear in `children` with `ok: false` and a reason, never vanish (Task 2).
3. A plan with a disallowed preset, a cycle, unknown dependencies or the wrong size must never run (Task 2).
4. Children in a later wave must receive the results they depend on (Task 2).
5. A Decisions outage must not stop work (Task 2).

---

### Task 1: Decisions as a kernel service

**Files:**
- Modify: `packages/rlm/src/services/io.ts` (append), `packages/rlm/test/graph.test.ts`

**Interfaces:**
- Produces: `DecisionsDef` and `decisionsService(decisions)` (`Decisions.decide({ state, questions })` from cells).

- [ ] **Step 1: Write the failing test**

In `packages/rlm/test/graph.test.ts`, import `decisionsService` from `../src` and add inside the `"Inquire, Agenda and Verify"` describe block:

```ts
  test("Decisions.decide answers from cells", async () => {
    const svc = decisionsService({
      decide: (req) => Effect.succeed(Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", answer: true, probability: 0.8, confidence: 0.6 }]))),
    })
    const out = await kernel([svc], (k) => k.run('const a = yield* Decisions.decide({ state: "s", questions: { ok: { type: "noul", instructions: "fine?" } } })\nreturn a.ok.answer'))
    expect(out.output).toBe("true")
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/rlm && mise x -- bun test test/graph.test.ts`
Expected: FAIL, `decisionsService` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/rlm/src/services/io.ts`:

```ts
const DQuestion = Schema.Union([
  Schema.Struct({ type: Schema.Literal("choice"), instructions: Schema.String, criteria: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ type: Schema.Literal("noul"), instructions: Schema.String }),
  Schema.Struct({ type: Schema.Literal("score"), instructions: Schema.String, levels: Schema.Array(Schema.String) }),
])
const DAnswer = Schema.Struct({
  type: Schema.String,
  choice: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.Boolean),
  level: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Number),
  probability: Schema.optionalKey(Schema.Number),
  confidence: Schema.Number,
})

export const DecisionsDef = defineService("Decisions", "Fast judgments by a small decision model: choice, yes/no (noul), or score, each with a confidence.", {
  decide: {
    doc: "Answer 1-8 questions about a state. Use it to classify work or check a result before acting on it.",
    params: Schema.Struct({ state: Schema.String, questions: Schema.Record(Schema.String, DQuestion) }),
    success: Schema.Record(Schema.String, DAnswer),
  },
})

/** The Decisions service (from @zarg/decisions) as a kernel service. */
export const decisionsService = (decisions: {
  readonly decide: (req: { state: string; questions: Record<string, unknown> }) => Effect.Effect<Readonly<Record<string, unknown>>, { readonly message: string; readonly kind?: string }>
}): Bound =>
  bind(DecisionsDef, {
    decide: (req) =>
      decisions.decide(req as never).pipe(
        Effect.map((answers) => answers as never),
        Effect.mapError((e): ServiceFailure => ({ _tag: "DecisionError", message: e.message })),
      ),
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bun test`
Expected: PASS, 30 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/rlm
git commit -m "feat(rlm): Decisions as a kernel service

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Atomize, plan, waves and verify before folding

**Files:**
- Create: `packages/rlm/src/fold.ts`, `packages/rlm/test/fold.test.ts`
- Modify: `packages/rlm/src/rlm.ts`, `packages/rlm/src/index.ts`, `packages/rlm/test/stub-model.ts`

**Interfaces:**
- Consumes: `Decisions` type, `Answer`, `DecisionRequest` (`@zarg/decisions`); `Model.Model`; Task 1 is independent.
- Produces:
  - `atomize(decisions, task, scope, minConfidence)`: `{ atomic, reason }`; `ATOMIC_CRITERIA`
  - `Plan`, `PlanChild { id, task, preset, paths, focus, dependsOn }`, `planJsonSchema(presets)`, `planProblems(plan, allowed)`, `waves(plan)`, `scopeOf(child)`, `requestPlan(model, ref, task, scope, choices, allowed)`
  - `ChildResult = { id, preset, ok: true, value } | { id, preset, ok: false, kind: "verify" | "decode" | "budget" | "error", reason }`
  - `RlmDeps.decisions?`, `RlmDeps.minConfidence?` (default 0.5); `RlmErrorKind` gains `"plan"`

- [ ] **Step 1: Write the failing tests**

In `packages/rlm/test/stub-model.ts`, treat structured-output requests as plan requests:

```ts
      // Structured-output requests are plan requests.
      const preset = req.outputSchema !== undefined ? "plan" : (/zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1] ?? "?")
```

`packages/rlm/test/fold.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
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
    expect(planProblems({ children: [child("a", [], "sync"), child("b")] }, ["research"])[0]).toContain('preset "sync" is not one you may spawn')
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
const decisions = (atomic: boolean, verdict = { answer: true, confidence: 0.9 }) => {
  const calls: Array<DecisionRequest> = []
  return {
    calls,
    service: {
      decide: (req: DecisionRequest) =>
        Effect.sync(() => {
          calls.push(req)
          const answer = (yes: boolean, confidence: number): Answer => ({ type: "noul", answer: yes, probability: yes ? confidence : 1 - confidence, confidence })
          const root = req.state.startsWith("Task: big")
          return Object.fromEntries(Object.keys(req.questions).map((k) => [k, k === "ok" ? answer(verdict.answer, verdict.confidence) : answer(root ? atomic : true, 0.9)]))
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

const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, d: ReturnType<typeof decisions>, raw: unknown = {}) => {
  const stub = stubModel(scripts)
  return Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings(raw)
      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000 })
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
        sync: [{ cell: "yield* Rlm.done({ value: JSON.stringify(children.map((c: any) => [c.id, c.ok, c.kind ?? null])) })" }],
      },
      { task: "big", preset: "sync", scope: { paths: ["src/**"] } },
      decisions(false),
    )
    gatePasses = true
    expect(JSON.parse(value(r))).toEqual([["i1", false, "verify"], ["r1", true, null]])
    const note = String(r.seen.filter((s) => s.preset === "sync")[0]!.messages.at(-1)?.content)
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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/rlm && mise x -- bun test test/fold.test.ts`
Expected: FAIL, `waves` is not exported.

- [ ] **Step 3: Implement**

`packages/rlm/src/fold.ts`:

```ts
import { Effect, Schema, Stream } from "effect"
import type { Answer, DecisionRequest, Decisions } from "@zarg/decisions"
import { Model } from "@zarg/model"
import type { Scope } from "./scope"

/** ROMA's atomic test: a task is atomic only when all five hold. */
export const ATOMIC_CRITERIA = {
  single: "The task has a single deliverable.",
  oneExecutor: "One agent working alone can do all of it.",
  noSteps: "Its steps do not depend on each other's results.",
  noPackaging: "It does not need several outputs packaged together.",
  noCoordination: "It needs no coordination with other work.",
} as const

export interface Atomized {
  readonly atomic: boolean
  /** Why: each criterion's answer and confidence, or why the check was skipped. */
  readonly reason: string
}

/** Ask Decisions whether a task is atomic. If Decisions cannot answer, treat the task as atomic. */
export const atomize = (decisions: Decisions["Service"], task: string, scope: string, minConfidence: number) =>
  Effect.gen(function* () {
    const questions = Object.fromEntries(
      Object.entries(ATOMIC_CRITERIA).map(([k, v]) => [k, { type: "noul" as const, instructions: v }]),
    )
    const req: DecisionRequest = { state: `Task: ${task}\nScope: ${scope}`, questions }
    const answers = yield* decisions.decide(req).pipe(Effect.option)
    if (answers._tag === "None") return { atomic: true, reason: "decisions unavailable; executing directly" } satisfies Atomized
    const notes = Object.entries(answers.value).map(([k, a]: [string, Answer]) =>
      a.type === "noul" ? `${k}: ${a.answer ? "yes" : "no"} (${a.confidence.toFixed(2)})` : `${k}: ?`,
    )
    const atomic = Object.values(answers.value).every((a) => a.type === "noul" && a.answer && a.confidence >= minConfidence)
    return { atomic, reason: notes.join(", ") } satisfies Atomized
  })

export const PlanChild = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  preset: Schema.String,
  paths: Schema.Array(Schema.String),
  focus: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
})
export type PlanChild = typeof PlanChild.Type
export const Plan = Schema.Struct({ children: Schema.Array(PlanChild) })
export type Plan = typeof Plan.Type

/** JSON Schema for strict structured output (every property required, no extras). */
export const planJsonSchema = (presets: ReadonlyArray<string>) => ({
  type: "object",
  additionalProperties: false,
  required: ["children"],
  properties: {
    children: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "task", "preset", "paths", "focus", "dependsOn"],
        properties: {
          id: { type: "string", description: "short unique id, e.g. c1" },
          task: { type: "string", description: "self-contained task with a verifiable completion condition" },
          preset: { type: "string", enum: [...presets] },
          paths: { type: "array", items: { type: "string" }, description: "file globs the child may use" },
          focus: { type: "array", items: { type: "string" }, description: "graph node ids the child works around" },
          dependsOn: { type: "array", items: { type: "string" }, description: "ids whose results this child needs" },
        },
      },
    },
  },
})

/** Problems with a plan, or an empty list when it can run. */
export const planProblems = (plan: Plan, allowed: ReadonlyArray<string>): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const n = plan.children.length
  if (n < 2 || n > 8) problems.push(`a plan has 2 to 8 children, got ${n}`)
  const ids = new Set<string>()
  for (const c of plan.children) {
    if (ids.has(c.id)) problems.push(`duplicate child id "${c.id}"`)
    ids.add(c.id)
    if (!allowed.includes(c.preset)) problems.push(`${c.id}: preset "${c.preset}" is not one you may spawn (${allowed.join(", ")})`)
  }
  for (const c of plan.children) for (const d of c.dependsOn) if (!ids.has(d)) problems.push(`${c.id} depends on unknown "${d}"`)
  if (problems.length === 0 && waves(plan) === undefined) problems.push("dependsOn has a cycle")
  return problems
}

/** Children grouped into waves: each wave depends only on earlier waves. Undefined on a cycle. */
export const waves = (plan: Plan): ReadonlyArray<ReadonlyArray<PlanChild>> | undefined => {
  const done = new Set<string>()
  const left = [...plan.children]
  const out: Array<Array<PlanChild>> = []
  while (left.length > 0) {
    const ready = left.filter((c) => c.dependsOn.every((d) => done.has(d)))
    if (ready.length === 0) return undefined
    out.push(ready)
    for (const c of ready) {
      done.add(c.id)
      left.splice(left.indexOf(c), 1)
    }
  }
  return out
}

export const scopeOf = (c: PlanChild): Scope => ({
  ...(c.paths.length > 0 ? { paths: c.paths } : {}),
  ...(c.focus.length > 0 ? { graph: { focus: c.focus, k: 2 } } : {}),
})

const PLAN_GUIDE = [
  "Split the task into 2 to 8 subtasks for child agents.",
  "- Cover the task completely with the fewest subtasks; do not overlap.",
  "- Each task is self-contained (a child starts fresh) and says how to tell it is done.",
  "- Use dependsOn only when a subtask needs another's result.",
  "- Give each child the narrowest paths and graph focus it needs.",
].join("\n")

/** One structured-output call that returns a plan, retried once with the problems found. */
export const requestPlan = (model: Model.Model["Service"], ref: string, task: string, scope: string, choices: ReadonlyArray<string>, allowed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let feedback = ""
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = yield* Stream.runCollect(
        model.stream({
          model: ref,
          messages: [
            { role: "system", content: `${PLAN_GUIDE}\n\nPresets you may use and what each returns:\n${choices.join("\n")}` },
            { role: "user", content: `Task: ${task}\nScope: ${scope}${feedback}` },
          ],
          outputSchema: planJsonSchema(allowed),
          maxTokens: 4096,
        }),
      ).pipe(Effect.mapError((e) => e.message))
      const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")
      const plan = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => "the plan is not JSON" }).pipe(
        Effect.flatMap((j) => Schema.decodeUnknownEffect(Plan)(j).pipe(Effect.mapError((e) => e.message))),
        Effect.result,
      )
      const problems = plan._tag === "Failure" ? [plan.failure] : planProblems(plan.success, allowed)
      if (plan._tag === "Success" && problems.length === 0) return plan.success
      feedback = `\n\nYour previous plan could not run:\n- ${problems.join("\n- ")}\nFix it.`
    }
    return yield* Effect.fail(feedback.trim())
  })

/** A child's outcome as its parent sees it: the result, or an explicit failure. */
export type ChildResult =
  | { readonly id: string; readonly preset: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly preset: string; readonly ok: false; readonly kind: "verify" | "decode" | "budget" | "error"; readonly reason: string }
```

`packages/rlm/src/rlm.ts` (full file):

```ts
import { Data, Effect, Ref, Schema, Semaphore, Stream } from "effect"
import { bind, type Bound, defineService, Kernel, type ServiceFailure, tsType } from "@zarg/kernel"
import { Model, type ChatMessage, type ToolCall } from "@zarg/model"
import type { Decisions } from "@zarg/decisions"
import { atomize, type ChildResult, requestPlan, scopeOf, waves } from "./fold"
import { budgetOf, type Budget, type Preset, RESULTS, type RlmSettings } from "./presets"
import { describeScope, type Scope } from "./scope"

export type RlmErrorKind = "budget" | "result" | "model" | "kernel" | "spawn" | "config" | "plan"

export class RlmError extends Data.TaggedError("RlmError")<{
  readonly kind: RlmErrorKind
  readonly message: string
}> {}

export interface RlmSpec {
  readonly task: string
  readonly preset: string
  readonly scope: Scope
  readonly budget?: Partial<Budget>
}

/** Builds the services an RLM's layer names ("Fs:read", "Graph", ...) for its scope. */
export type ServiceFactory = (name: string, scope: Scope) => Bound | undefined

export interface RlmDeps {
  readonly settings: RlmSettings
  readonly services: ServiceFactory
  /** Role → `provider:model` (from config `[roles]`). */
  readonly roles: Readonly<Record<string, string>>
  readonly results?: Readonly<Record<string, Schema.Codec<any, any>>>
  /** Per-cell worker deadline (time yielded on calls does not count). */
  readonly cellTimeoutMs?: number
  /** Tool outputs kept in full; older ones are trimmed. */
  readonly keepOutputs?: number
  /** Enables folding: atomize with Decisions, then plan children when a task is not atomic. */
  readonly decisions?: Decisions["Service"]
  /** Minimum confidence for atomize and for "decision" verification (default 0.5). */
  readonly minConfidence?: number
}

export interface RlmOutcome {
  readonly id: string
  readonly value: unknown
  readonly turns: number
  readonly tokens: number
}

const EXEC_TOOL = {
  name: "exec",
  description: "Run a TypeScript cell in your kernel. It is the body of a generator: `yield*` service calls, `return` a value to see it. Top-level declarations persist into later cells.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
}

const resultType = (schema: Schema.Codec<any, any>) => {
  const d = Schema.toJsonSchemaDocument(schema) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions ?? {})
}

const systemPrompt = (
  spec: RlmSpec,
  preset: Preset,
  manifest: string,
  result: string,
  budget: Budget,
  depth: number,
  maxDepth: number,
  children: ReadonlyArray<string>,
) =>
  [
    preset.stance ?? `You are a zarg ${spec.preset} agent.`,
    "You work only by calling the `exec` tool with TypeScript cells. Each cell is a generator body: `const x = yield* Service.method(params)`; `return` a value to see it in the tool result. Declarations persist across cells, and older tool outputs get shortened, so keep results you need in variables.",
    children.length > 0
      ? [
          "Stay inside your scope. Work that needs files or graph nodes outside it, or reading more than a few files, goes to a child with `yield* Rlm.exec({ task, preset, scope })`: you get back only its result, which keeps your context small. A child starts fresh: put everything it needs to know in its task.",
          `Presets you may spawn and what each returns:\n${children.join("\n")}`,
        ].join("\n\n")
      : "Stay inside your scope. You cannot spawn children.",
    `When you are done, finish with \`yield* Rlm.done({ value })\` where value is: ${result}`,
    `Scope: ${describeScope(spec.scope)}`,
    `Depth: ${depth} of ${maxDepth}. Budget: ${budget.turns} turns.`,
    "Services available to your cells:",
    "```ts",
    manifest.trim(),
    "```",
  ].join("\n\n")

/**
 * Keep the latest tool outputs whole; shorten older ones so a long run stays in context.
 * Outputs of cells that folded work into a child (`Rlm.exec`) are the valuable part and stay whole.
 * Large cell arguments (a file written in full) are shortened once they are old.
 */
const trimOld = (messages: Array<ChatMessage>, keep: number) => {
  const folded = new Set<string>()
  for (const m of messages) for (const c of m.toolCalls ?? []) if (c.function.arguments.includes("Rlm.exec")) folded.add(c.id)
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []))
  const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)))
  for (const i of old) {
    const m = messages[i]!
    const c = m.content ?? ""
    if (m.toolCallId !== undefined && folded.has(m.toolCallId)) continue
    if (c.length > 600) messages[i] = { ...m, content: `${c.slice(0, 400)}\n… [older output trimmed] …` }
  }
  const oldCalls = new Set([...old].map((i) => messages[i]!.toolCallId))
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant" || m.toolCalls === undefined) continue
    if (!m.toolCalls.some((c) => oldCalls.has(c.id) && c.function.arguments.length > 600 && !folded.has(c.id))) continue
    messages[i] = {
      ...m,
      toolCalls: m.toolCalls.map((c) =>
        oldCalls.has(c.id) && c.function.arguments.length > 600 && !folded.has(c.id)
          ? { ...c, function: { ...c.function, arguments: JSON.stringify({ code: `${String((JSON.parse(c.function.arguments) as { code?: unknown }).code ?? "").slice(0, 300)}\n// … [older cell trimmed] …` }) } }
          : c,
      ),
    }
  }
}

export const make = (deps: RlmDeps) =>
  Effect.gen(function* () {
    const model = yield* Model.Model
    const results = deps.results ?? RESULTS
    const turns = yield* Semaphore.make(deps.settings.maxConcurrent)
    let counter = 0

    const exec = (spec: RlmSpec, parent?: { readonly id: string; readonly preset: string; readonly depth: number }): Effect.Effect<RlmOutcome, RlmError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const preset = deps.settings.presets[spec.preset]
          if (preset === undefined) return yield* new RlmError({ kind: "spawn", message: `no preset "${spec.preset}"` })
          const depth = parent === undefined ? 0 : parent.depth + 1
          if (parent !== undefined) {
            const allowed = deps.settings.presets[parent.preset]?.spawns ?? []
            if (!allowed.includes(spec.preset)) {
              return yield* new RlmError({ kind: "spawn", message: `preset "${parent.preset}" may not spawn "${spec.preset}" (allowed: ${allowed.join(", ") || "none"})` })
            }
            if (depth > deps.settings.maxDepth) return yield* new RlmError({ kind: "spawn", message: `max depth ${deps.settings.maxDepth} reached` })
          }
          const ref = deps.roles[preset.role]
          if (ref === undefined) return yield* new RlmError({ kind: "config", message: `no model for role "${preset.role}"; set roles.${preset.role}` })
          const resultSchema = results[preset.result ?? "text"]
          if (resultSchema === undefined) return yield* new RlmError({ kind: "config", message: `unknown result "${preset.result}"` })
          const budget = budgetOf(preset, spec.budget)
          const id = `rlm-${++counter}`
          const me = { id, preset: spec.preset, depth }

          // The value handed to Rlm.done, once it decodes against the preset's result Schema.
          const finished = yield* Ref.make<{ readonly value: unknown } | undefined>(undefined)
          const RlmDef = defineService("Rlm", "Finish, or fold work into a child RLM.", {
            done: { doc: "Finish with your result (must match the result type in your instructions).", params: Schema.Struct({ value: Schema.Unknown }), success: Schema.String },
            exec: {
              doc: "Run a child RLM on a scoped task; returns only its result. preset must be one you may spawn.",
              params: Schema.Struct({ task: Schema.String, preset: Schema.String, scope: Schema.Struct({ paths: Schema.optionalKey(Schema.Array(Schema.String)), graph: Schema.optionalKey(Schema.Struct({ focus: Schema.Array(Schema.String), k: Schema.Number })), kind: Schema.optionalKey(Schema.String) }) }),
              success: Schema.Unknown,
            },
          })
          const rlmService = bind(RlmDef, {
            done: ({ value }) =>
              Schema.decodeUnknownEffect(Schema.toCodecJson(resultSchema))(value).pipe(
                Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `the result does not match ${resultType(resultSchema)}: ${e.message}` })),
                Effect.flatMap((decoded) => Ref.set(finished, { value: decoded })),
                Effect.as("done: stop now"),
              ),
            exec: (child) =>
              exec(child as RlmSpec, me).pipe(
                Effect.flatMap((o) => Schema.encodeEffect(Schema.toCodecJson(results[deps.settings.presets[child.preset]!.result ?? "text"]!))(o.value)),
                Effect.mapError((e): ServiceFailure => ({ _tag: e._tag === "RlmError" ? "RlmError" : "InvalidResult", message: e.message })),
              ),
          })
          const layer = preset.layer.filter((n) => n !== "Rlm").flatMap((n) => {
            const b = deps.services(n, spec.scope)
            return b === undefined ? [] : [b]
          })
          const kernel = yield* Kernel.make({ services: [...layer, rlmService], env: {}, ...(deps.cellTimeoutMs ? { timeoutMs: deps.cellTimeoutMs } : {}) })

          const messages: Array<ChatMessage> = [
            {
              role: "system",
              content: systemPrompt(
                spec,
                preset,
                kernel.manifest,
                resultType(resultSchema),
                budget,
                depth,
                deps.settings.maxDepth,
                depth >= deps.settings.maxDepth
                  ? []
                  : (preset.spawns ?? []).map((p) => `- ${p} → ${resultType(results[deps.settings.presets[p]?.result ?? "text"] ?? Schema.String)}`),
              ),
            },
            { role: "user", content: spec.task },
          ]
          const started = Date.now()
          let tokens = 0
          let restarts = 0
          yield* Effect.logInfo("rlm.start").pipe(Effect.annotateLogs({ rlm: id, parent: parent?.id ?? "", preset: spec.preset, depth }))

          const turn = Effect.gen(function* () {
            const events = yield* Semaphore.withPermits(turns, 1)(
              Stream.runCollect(model.stream({ model: ref, messages, tools: [EXEC_TOOL] })),
            ).pipe(Effect.mapError((e) => new RlmError({ kind: "model", message: e.message })))
            let text = ""
            const calls: Array<ToolCall> = []
            for (const e of events) {
              if (e.type === "text") text += e.delta
              if (e.type === "toolCall") calls.push(e.call)
              if (e.type === "usage") tokens += e.usage.promptTokens + e.usage.completionTokens
            }
            messages.push({ role: "assistant", content: text.length > 0 ? text : null, ...(calls.length > 0 ? { toolCalls: calls } : {}) })
            if (calls.length === 0) {
              messages.push({ role: "user", content: "Use the exec tool. Finish with `yield* Rlm.done({ value })`." })
              return
            }
            for (const call of calls) {
              let code = ""
              try {
                code = String((JSON.parse(call.function.arguments) as { code?: unknown }).code ?? "")
              } catch {
                messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: "error: exec arguments must be JSON {\"code\": string}" })
                continue
              }
              const r = yield* kernel.run(code)
              restarts = r.restarted ? restarts + 1 : 0
              if (restarts >= 2) return yield* new RlmError({ kind: "kernel", message: "the kernel died twice in a row" })
              messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: `${r.ok ? "ok" : "failed"}\n${r.output}` })
            }
            trimOld(messages, deps.keepOutputs ?? 4)
          })

          // Folding: a task that is not atomic is planned into children, run in waves, verified,
          // and handed to this RLM as the `children` global before its first turn.
          const spawnable = depth >= deps.settings.maxDepth ? [] : (preset.spawns ?? [])
          if (deps.decisions !== undefined && spawnable.length > 0) {
            const minConfidence = deps.minConfidence ?? 0.5
            const a = yield* atomize(deps.decisions, spec.task, describeScope(spec.scope), minConfidence)
            yield* Effect.logInfo("rlm.atomize").pipe(Effect.annotateLogs({ rlm: id, atomic: a.atomic, reason: a.reason }))
            if (!a.atomic) {
              const choices = spawnable.map((p) => `- ${p} → ${resultType(results[deps.settings.presets[p]?.result ?? "text"] ?? Schema.String)}`)
              const plan = yield* Semaphore.withPermits(turns, 1)(requestPlan(model, ref, spec.task, describeScope(spec.scope), choices, spawnable)).pipe(
                Effect.mapError((reason) => new RlmError({ kind: "plan", message: reason })),
              )
              const byId = new Map<string, ChildResult>()
              for (const wave of waves(plan)!) {
                const outcomes = yield* Effect.forEach(
                  wave,
                  (c) => {
                    const inputs = c.dependsOn.map((d) => `- ${d}: ${JSON.stringify(byId.get(d))}`)
                    const task = inputs.length === 0 ? c.task : `${c.task}\n\nResults you depend on:\n${inputs.join("\n")}`
                    return runChild({ task, preset: c.preset, scope: scopeOf(c) }, me, c.id, minConfidence)
                  },
                  { concurrency: deps.settings.maxConcurrent },
                )
                for (const o of outcomes) byId.set(o.id, o)
              }
              const children = plan.children.map((c) => byId.get(c.id)!)
              yield* kernel.run(`const children = ${JSON.stringify(children)}`)
              messages.push({
                role: "user",
                content: `This task was split into ${children.length} children. Their results are in the global \`children\` (failed ones have ok: false with a reason):\n${JSON.stringify(children, null, 2)}\nCombine them into your result and finish with \`yield* Rlm.done({ value })\`.`,
              })
            }
          }

          const over = () => tokens >= budget.tokens || Date.now() - started >= budget.wallMs
          for (let n = 1; n <= budget.turns && !over(); n++) {
            yield* turn
            const done = yield* Ref.get(finished)
            if (done !== undefined) {
              yield* Effect.logInfo("rlm.end").pipe(Effect.annotateLogs({ rlm: id, turns: n, tokens }))
              return { id, value: done.value, turns: n, tokens }
            }
          }
          // Budget spent: one final turn to report what it has.
          messages.push({ role: "user", content: "Your budget is exhausted. In your next cell call `yield* Rlm.done({ value })` with your best result now." })
          yield* turn
          const last = yield* Ref.get(finished)
          if (last !== undefined) return { id, value: last.value, turns: budget.turns + 1, tokens }
          return yield* new RlmError({ kind: "budget", message: `${spec.preset} did not finish within its budget (${budget.turns} turns)` })
        }),
      )

    /** Run one planned child, then check it before its parent sees it. Failures become explicit entries. */
    const runChild = (
      spec: RlmSpec,
      parent: { readonly id: string; readonly preset: string; readonly depth: number },
      childId: string,
      minConfidence: number,
    ): Effect.Effect<ChildResult> =>
      Effect.gen(function* () {
        const preset = deps.settings.presets[spec.preset]!
        const outcome = yield* Effect.exit(exec(spec, parent))
        if (outcome._tag === "Failure") {
          const e = outcome.cause.reasons.find((r) => r._tag === "Fail")?.error as RlmError | undefined
          return { id: childId, preset: spec.preset, ok: false, kind: e?.kind === "budget" ? "budget" : "error", reason: e?.message ?? "the child failed" }
        }
        const value = yield* Schema.encodeEffect(Schema.toCodecJson(results[preset.result ?? "text"] ?? Schema.String))(outcome.value.value).pipe(Effect.option)
        if (value._tag === "None") return { id: childId, preset: spec.preset, ok: false, kind: "decode", reason: "the result could not be encoded" }
        if (preset.verify === "gate") {
          const gate = deps.services("Verify", spec.scope)
          const check = gate?.handlers["run"]
          if (check === undefined) return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: "no Verify service to gate this result" }
          const r = (yield* check({}).pipe(Effect.orElseSucceed(() => ({ passed: false, output: "the gate could not run" })))) as { passed: boolean; output: string }
          if (!r.passed) return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: `the verify gate failed:\n${r.output.slice(-2000)}` }
        }
        if (preset.verify === "decision" && deps.decisions !== undefined) {
          const d = yield* deps.decisions
            .decide({ state: `Task: ${spec.task}\nResult: ${JSON.stringify(value.value)}`, questions: { ok: { type: "noul", instructions: "Does the result satisfy the task?" } } })
            .pipe(Effect.option)
          const a = d._tag === "Some" ? d.value.ok : undefined
          if (a === undefined || a.type !== "noul" || !a.answer || a.confidence < minConfidence) {
            return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: a === undefined ? "the result could not be checked" : `a check judged the result insufficient (confidence ${a.confidence.toFixed(2)})` }
          }
        }
        return { id: childId, preset: spec.preset, ok: true, value: value.value }
      })

    return { exec: (spec: RlmSpec) => exec(spec) }
  })

export type Rlm = Effect.Success<ReturnType<typeof make>>
```

`packages/rlm/src/index.ts`:

```ts
export * from "./presets"
export * as Rlm from "./rlm"
export * from "./scope"
export * from "./services/core"
export * from "./services/graph"
export * from "./services/io"
export * from "./fold"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bun test`
Expected: PASS, 41 tests.

- [ ] **Step 5: Gate and commit**

Run: `mise run verify` (expected exit 0), then:

```bash
git add packages/rlm
git commit -m "feat(rlm): folding: atomize with Decisions, typed plans in waves, verify before folding

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Live smoke test

**Files:**
- Create: `packages/rlm/smoke/smoke.ts`
- Modify: `packages/rlm/tsconfig.json`, `packages/rlm/package.json` (dev dependencies), `mise.toml`

**Interfaces:**
- Consumes: everything from 2a: `Env`, `Config`, `Model`, both providers, `Decisions`, `PluginHost`/`GraphStore`, `Rlm`.
- Produces: `mise run smoke [task]` runs one real research RLM scoped to `packages/graph/**` and prints `{ result, turns, tokens, seconds }`.

- [ ] **Step 1: Wire the script**

```bash
cd packages/rlm && mise x -- bun add -d @zarg/provider-zarg-router@workspace:* @zarg/provider-openrouter@workspace:* && cd ../..
```

`packages/rlm/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "smoke"]
}
```

`packages/rlm/smoke/smoke.ts`:

```ts
// Live smoke test: one real research RLM against this repository through the configured models.
// Run with `mise run smoke` from the repo root. Needs zarg-router (or the configured providers) up.
import { BunServices } from "@effect/platform-bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Decisions, layer as decisionsLayer } from "@zarg/decisions"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { Config, Env, layer as envLayer, Model } from "@zarg/model"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "@zarg/plugin-gherkin/server"
import { openrouter } from "@zarg/provider-openrouter"
import { zargRouter } from "@zarg/provider-zarg-router"
import { type Bound } from "@zarg/kernel"
import { decisionsService, fsRead, graph, Rlm, type Scope, settings } from "../src"

const root = process.env.ZARG_ROOT ?? process.cwd()
const task = process.argv[2] ?? "Which functions does packages/graph/src/diff.ts export, and what does each do? One sentence each."
const scope: Scope = { paths: ["packages/graph/**"], kind: "research" }

const program = Effect.gen(function* () {
  const config = yield* Config.Config
  const model = yield* Model.Model
  const env = yield* Env
  const host = yield* PluginHost
  const store = yield* GraphStore
  const decisions = yield* Decisions
  const sensitive = yield* env.sensitive
  const role = config.roles.driver
  if (role === undefined) return yield* Effect.fail(new Error("set roles.driver in .zarg/config.toml"))

  console.log(`warming ${role} (a cold router model can take minutes)…`)
  const t0 = Date.now()
  yield* model.warm(role)
  console.log(`warm after ${Math.round((Date.now() - t0) / 1000)}s`)

  const info = yield* model.info(role)
  if (!info.supportsTools) console.log(`warning: ${role} does not advertise tool calling; the run may fail`)

  const factory = (name: string, s: Scope): Bound | undefined => {
    if (name === "Fs:read") return fsRead({ root, scope: s, sensitive })
    if (name === "Graph") return graph({ host, snapshot: store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))), scope: s })
    if (name === "Decisions") return decisionsService(decisions as never)
    return undefined
  }
  const rlm = yield* Rlm.make({ settings: yield* settings(config.extra.rlm), services: factory, roles: config.roles, decisions })
  const t1 = Date.now()
  const outcome = yield* rlm.exec({ task, preset: "research", scope })
  console.log(JSON.stringify({ result: outcome.value, turns: outcome.turns, tokens: outcome.tokens, seconds: Math.round((Date.now() - t1) / 1000) }, null, 2))
})

const base = Layer.merge(envLayer(root), BunServices.layer)
const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
const model = Layer.provideMerge(Model.layer([zargRouter, openrouter]), config)
const decisions = Layer.provideMerge(decisionsLayer(), model)
const graphs = Layer.provideMerge(hostLayer([gherkin]), graphLayer(join(root, ".zarg", "graph")))

await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))))).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
```

Append to the root `mise.toml`:

```toml
[tasks.smoke]
description = "Live smoke test: one real research RLM on this repo (needs the configured model providers)"
run = "mise x -- bun packages/rlm/smoke/smoke.ts"
```

- [ ] **Step 2: Gate and commit**

Run: `mise run verify` (expected exit 0, 203 tests; the smoke script is typechecked, not run), then:

```bash
git add packages/rlm mise.toml bun.lock
git commit -m "feat(rlm): live smoke test (mise run smoke)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Run it live (ask the developer first)**

Ask the developer to confirm: warming `roles.driver` loads it on the GPU and zarg-router may evict other models; zarg-router must advertise `tools` for the model (restart the router service after commit `4b4da15e0`). Then:

Run: `mise run smoke`
Expected: `warming …`, `warm after Ns`, then JSON with a `result` whose `findings` name the exports of `packages/graph/src/diff.ts` (`diff`, `isEmpty`) and `sources` including that file, plus `turns`, `tokens`, `seconds`. Record the output in the ledger. A failure here is a finding about the live system (router, model behavior, prompt), not a reason to change tests.
