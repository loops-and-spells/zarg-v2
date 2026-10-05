// packages/core/src/rehearse/screen.ts
import { hash } from "./hash"
import { Effect } from "effect"
import type { Decide, Persona, Reason, Screened, SceneView } from "./types"
import type { RehearseSettings } from "./settings"

/** The last scenes of the story so far: how the tester got here. */
const STORY_STEPS = 3

export const storyText = (prior: ReadonlyArray<SceneView>) =>
  prior.slice(-STORY_STEPS).map((p) => `${p.when}; then ${p.thens.join(", and ")}`).join(". ")

export const sceneText = (scene: SceneView) => `Given ${scene.given}\nWhen ${scene.when}\nThen ${scene.thens.join("; and ")}`

/** The scenario as the testers saw it: a fix is stale once this changes. */
export const sceneHash = (scene: SceneView) => hash(sceneText(scene)).slice(0, 12)

/**
 * One decision-model request per scene (calibrated 2026-09-27: feel, fail, choose and arrive separate good
 * scenes from bad; act and expect do not, so the large model diagnoses those on flagged scenes).
 */
export const screenScene = (decide: Decide, persona: Persona, prior: ReadonlyArray<SceneView>, scene: SceneView, s: RehearseSettings, code?: string) =>
  Effect.gen(function* () {
    const state = `You are ${persona.text}\nWhat happened so far: ${storyText(prior) || "you just started"}.\nThe next step in the product, as specified:\n${sceneText(scene)}`
    const forked = scene.fork.length > 1
    const answers = yield* decide({
      state,
      questions: {
        feel: { type: "score", instructions: "How does this step feel to you?", levels: ["blocked", "confusing", "fine", "pleasing"] },
        fail: { type: "noul", instructions: "Could this step go wrong in a way you would need to see and handle (an error, a refusal)?" },
        arrive: { type: "noul", instructions: "Is what the Given says true, given what happened so far?" },
        // @scenario S-0107
        // The step's code, when it has some: whether it does what the step says (a mismatch is drift, the operator's call).
        ...(code !== undefined && code.trim() !== "" ? { does: { type: "noul" as const, instructions: `This is the code that does this step now:\n${code.slice(0, 4000)}\nDoes it do what the step says (its Then)?` } } : {}),
        ...(forked ? { choose: { type: "choice" as const, instructions: "Which would you do next?", criteria: Object.fromEntries(scene.fork.slice(0, 16).map((f, i) => [`f${i}`, f.when])) } } : {}),
      },
    })
    const feel = answers.feel?.type === "score" ? answers.feel.score : 2
    const fail = answers.fail?.type === "noul" ? answers.fail.probability : 0
    const arrive = answers.arrive?.type === "noul" ? answers.arrive.probability : 1
    const does = answers.does?.type === "noul" ? answers.does.probability : undefined
    const fork = answers.choose?.type === "choice" ? Math.max(...Object.values(answers.choose.probabilities)) : undefined
    const flags: Array<Reason> = []
    if (feel < s.feelBelow) flags.push("feel")
    if (fail >= s.failAt && !scene.hasFailure) flags.push("fail")
    if (fork !== undefined && fork < s.forkBelow) flags.push("fork")
    // The first scene has no story yet: a seam needs a scene before it.
    if (prior.length > 0 && arrive < s.seamBelow) flags.push("seam")
    if (does !== undefined && does < s.driftBelow) flags.push("drift")
    return { feel, fail, arrive, ...(fork !== undefined ? { fork } : {}), flags } satisfies Screened
  }).pipe(Effect.orElseSucceed(() => undefined))

