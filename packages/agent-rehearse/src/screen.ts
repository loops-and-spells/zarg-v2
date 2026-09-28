import { parse } from "@zarg/frontmatter"
// packages/core/src/rehearse/screen.ts
import { hash } from "./hash"
import { Effect } from "effect"
import type { Decide, Persona, Reason, Screened, StepView } from "./types"
import type { RehearseSettings } from "./settings"

/** The last steps of the story so far: how the tester got here. */
const STORY_STEPS = 3

export const storyText = (prior: ReadonlyArray<StepView>) =>
  prior.slice(-STORY_STEPS).map((p) => `${p.when}; then ${p.thens.join(", and ")}`).join(". ")

export const stepText = (step: StepView) => `Given ${step.given}\nWhen ${step.when}\nThen ${step.thens.join("; and ")}`

/** The card as the testers saw it: a fix is stale once this changes. */
export const stepHash = (step: StepView) => hash(stepText(step)).slice(0, 12)

/**
 * One decision-model request per step (calibrated 2026-09-27: feel, fail, choose and arrive separate good
 * steps from bad; act and expect do not, so the large model diagnoses those on flagged steps).
 */
export const screenStep = (decide: Decide, persona: Persona, prior: ReadonlyArray<StepView>, step: StepView, s: RehearseSettings) =>
  Effect.gen(function* () {
    const state = `You are ${persona.text}\nWhat happened so far: ${storyText(prior) || "you just started"}.\nThe next step in the product, as specified:\n${stepText(step)}`
    const forked = step.fork.length > 1
    const answers = yield* decide({
      state,
      questions: {
        feel: { type: "score", instructions: "How does this step feel to you?", levels: ["blocked", "confusing", "fine", "pleasing"] },
        fail: { type: "noul", instructions: "Could this step go wrong in a way you would need to see and handle (an error, a refusal)?" },
        arrive: { type: "noul", instructions: "Is what the Given says true, given what happened so far?" },
        ...(forked ? { choose: { type: "choice" as const, instructions: "Which would you do next?", criteria: Object.fromEntries(step.fork.slice(0, 16).map((f, i) => [`f${i}`, f.when])) } } : {}),
      },
    })
    const feel = answers.feel?.type === "score" ? answers.feel.score : 2
    const fail = answers.fail?.type === "noul" ? answers.fail.probability : 0
    const arrive = answers.arrive?.type === "noul" ? answers.arrive.probability : 1
    const fork = answers.choose?.type === "choice" ? Math.max(...Object.values(answers.choose.probabilities)) : undefined
    const flags: Array<Reason> = []
    if (feel < s.feelBelow) flags.push("feel")
    if (fail >= s.failAt && !step.hasFailure) flags.push("fail")
    if (fork !== undefined && fork < s.forkBelow) flags.push("fork")
    // The first step has no story yet: a seam needs a step before it.
    if (prior.length > 0 && arrive < s.seamBelow) flags.push("seam")
    return { feel, fail, arrive, ...(fork !== undefined ? { fork } : {}), flags } satisfies Screened
  }).pipe(Effect.orElseSucceed(() => undefined))

/** One tester per persona in the intents' frontmatter (`personas: [{ name, text }]`), in file order; the prose is never read. */
export const personasOf = (intents: ReadonlyArray<string>): ReadonlyArray<Persona> => {
  const listed = intents.flatMap((md) => {
    let data: { readonly [key: string]: unknown }
    try {
      data = parse(md).data
    } catch {
      return []
    }
    const ps = Array.isArray(data.personas) ? (data.personas as ReadonlyArray<unknown>) : []
    return ps.flatMap((p) => {
      const o = (p ?? {}) as { readonly name?: unknown; readonly text?: unknown }
      return typeof o.name === "string" && o.name !== "" && typeof o.text === "string" && o.text !== "" ? [{ name: o.name, text: o.text }] : []
    })
  })
  // Names key each tester's answers: a repeated name gets a number.
  const seen = new Map<string, number>()
  return listed.map((p) => {
    const n = (seen.get(p.name) ?? 0) + 1
    seen.set(p.name, n)
    return { name: n === 1 ? p.name : `${p.name} (${n})`, text: p.text }
  })
}
