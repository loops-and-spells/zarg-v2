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
  /** Each criterion's answer and confidence (empty when Decisions was unavailable). */
  readonly criteria: ReadonlyArray<{ readonly name: string; readonly answer: boolean; readonly confidence: number }>
}

/** Ask Decisions whether a task is atomic. If Decisions cannot answer, treat the task as atomic. */
// The decision model reads the state once per question: judge the task's head, not its pages of context.
const ATOMIZE_TASK_MAX = 600

export const atomize = (decisions: Decisions["Service"], task: string, scope: string, minConfidence: number) =>
  Effect.gen(function* () {
    const questions = Object.fromEntries(
      Object.entries(ATOMIC_CRITERIA).map(([k, v]) => [k, { type: "noul" as const, instructions: v }]),
    )
    const head = task.length > ATOMIZE_TASK_MAX ? `${task.slice(0, ATOMIZE_TASK_MAX)}\n… (task cut for this judgment)` : task
    const req: DecisionRequest = { state: `Task: ${head}\nScope: ${scope}`, questions }
    const answers = yield* decisions.decide(req).pipe(Effect.option)
    if (answers._tag === "None") return { atomic: true, reason: "decisions unavailable; executing directly", criteria: [] } satisfies Atomized
    const notes = Object.entries(answers.value).map(([k, a]: [string, Answer]) =>
      a.type === "noul" ? `${k}: ${a.answer ? "yes" : "no"} (${a.confidence.toFixed(2)})` : `${k}: ?`,
    )
    // Plan only on a confident "no". A hedging model (low confidence) executes directly,
    // as ROMA's own tie-breaker does; otherwise uncertainty would plan at every level.
    const atomic = !Object.values(answers.value).some((a) => a.type === "noul" && !a.answer && a.confidence >= minConfidence)
    const criteria = Object.entries(answers.value).flatMap(([name, a]: [string, Answer]) =>
      a.type === "noul" ? [{ name, answer: a.answer, confidence: a.confidence }] : [],
    )
    return { atomic, reason: notes.join(", "), criteria } satisfies Atomized
  })

/** What an agent did in its last turns, counted by the harness for the progress judgment. */
export interface Progress {
  readonly used: number
  readonly extension: number
  readonly max: number
  readonly cells: ReadonlyArray<{ readonly turn: number; readonly code: string; readonly ok: boolean; readonly output: string }>
  readonly typecheckFailed: number
  readonly calls: number
  readonly repeated: number
  readonly asked: number
}

/**
 * At the turn budget: is the agent getting closer to finishing (extend) or going round in circles (wrap up)?
 * Only a confident yes extends; a decision model that cannot answer means wrap up, as before extensions.
 */
export const judgeProgress = (decisions: Decisions["Service"], task: string, p: Progress, minConfidence: number) =>
  Effect.gen(function* () {
    const head = task.length > ATOMIZE_TASK_MAX ? `${task.slice(0, ATOMIZE_TASK_MAX)}\n… (task cut for this judgment)` : task
    const state = [
      `Task: ${head}`,
      `Turns used: ${p.used} (extension ${p.extension + 1} of ${p.max} would be next)`,
      `In the last turns: cells that failed typecheck: ${p.typecheckFailed} of ${p.cells.length}; repeated calls: ${p.repeated} of ${p.calls} (same service, method and params as an earlier call); questions to the operator: ${p.asked}`,
      "Recent cells:",
      ...p.cells.map((c) => `- turn ${c.turn} ${c.ok ? "ok" : "failed"}: ${preview(c.code, 300)}\n  → ${preview(c.output, 300)}`),
    ].join("\n")
    const questions = {
      progressing: {
        type: "noul" as const,
        instructions: "Is this agent making progress toward finishing its task: new information or changes each turn, not repeating the same calls or failing the same way?",
      },
    }
    const answers = yield* decisions.decide({ state, questions }).pipe(Effect.option)
    const a = answers._tag === "Some" ? answers.value.progressing : undefined
    if (a === undefined || a.type !== "noul") return { extend: false, confidence: 0, reason: "decisions unavailable" }
    const reason = `typecheck failed ${p.typecheckFailed}/${p.cells.length}, repeated calls ${p.repeated}/${p.calls}, questions ${p.asked}`
    return { extend: a.answer && a.confidence >= minConfidence, confidence: a.confidence, reason }
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
      ).pipe(Effect.mapError((e) => ({ model: e.message })))
      const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")
      const plan = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => "the plan is not JSON" }).pipe(
        Effect.flatMap((j) => Schema.decodeUnknownEffect(Plan)(j).pipe(Effect.mapError((e) => e.message))),
        Effect.result,
      )
      const problems = plan._tag === "Failure" ? [plan.failure] : planProblems(plan.success, allowed)
      if (plan._tag === "Success" && problems.length === 0) return plan.success
      feedback = `\n\nYour previous plan could not run:\n- ${problems.join("\n- ")}\nFix it.`
    }
    return yield* Effect.fail({ plan: feedback.trim() })
  })

/** At most `max` characters of `text`, marking the cut. */
export const preview = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`)

/** A child's outcome as its parent sees it: the result, or an explicit failure. */
export type ChildResult =
  | { readonly id: string; readonly preset: string; readonly ok: true; readonly value: unknown; readonly unverified?: string }
  | { readonly id: string; readonly preset: string; readonly ok: false; readonly kind: "verify" | "decode" | "budget" | "error"; readonly reason: string }
