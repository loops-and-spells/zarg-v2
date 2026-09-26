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
