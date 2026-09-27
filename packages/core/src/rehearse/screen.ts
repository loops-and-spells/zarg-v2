// packages/core/src/rehearse/screen.ts
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Decide, Persona, Reason, Screened, StepView } from "./types"
import type { RehearseSettings } from "./settings"

/** The last steps of the story so far: how the tester got here. */
const STORY_STEPS = 3

export const storyText = (prior: ReadonlyArray<StepView>) =>
  prior.slice(-STORY_STEPS).map((p) => `${p.when}; then ${p.thens.join(", and ")}`).join(". ")

export const stepText = (step: StepView) => `Given ${step.given}\nWhen ${step.when}\nThen ${step.thens.join("; and ")}`

/** The card as the testers saw it: a fix is stale once this changes. */
export const stepHash = (step: StepView) => createHash("sha256").update(stepText(step)).digest("hex").slice(0, 12)

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

// jevk5 on zarg's intent (2026-09-27): "The developer, through the zarg TUI" 0.45, "Shoppers, on mobile" 0.69;
// the git repository 0.26, model providers 0.18, a payments API 0.23. People rank above systems, below 0.5.
const PERSON_AT = 0.4

/** One tester per person under "Affected users" in the intent; systems in that list are not testers. */
export const personasOf = (markdown: string, decide: Decide) =>
  Effect.gen(function* () {
    const lines = markdown.split("\n")
    const at = lines.findIndex((l) => /^##\s+Affected users/.test(l))
    if (at < 0) return [] as ReadonlyArray<Persona>
    const bullets: Array<string> = []
    for (const l of lines.slice(at + 1)) {
      if (/^##\s/.test(l)) break
      const b = /^-\s+(.*)$/.exec(l.trim())
      if (b !== null) bullets.push(b[1]!)
    }
    const people = yield* Effect.forEach(bullets, (text) =>
      decide({ state: `An entry in a product's list of affected users and systems: ${text}`, questions: { person: { type: "noul", instructions: "Is this a person who uses the product (not a system or a store)?" } } }).pipe(
        Effect.map((a) => (a.person?.type === "noul" && a.person.probability >= PERSON_AT ? [text] : [])),
        Effect.orElseSucceed(() => [] as Array<string>),
      ),
    )
    // Names key each tester's answers: a repeated name gets a number.
    const seen = new Map<string, number>()
    return people.flat().map((text) => {
      const base = text.split(",")[0]!.replace(/[.:]$/, "")
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { name: n === 1 ? base : `${base} (${n})`, text }
    }) as ReadonlyArray<Persona>
  })
