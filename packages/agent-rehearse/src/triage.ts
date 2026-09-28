// packages/core/src/rehearse/triage.ts
import { Effect } from "effect"
import type { RehearseSettings } from "./settings"
import { stepText } from "./screen"
import type { Decide, Finding, StepView, Triaged } from "./types"

/**
 * Is the finding real, and what is it: a local fix the driver applies, a product decision, a removal of
 * something built, or noise? One decision-model request, on the card as it is now.
 */
export const triage = (decide: Decide, finding: Finding, step: StepView | undefined, built: boolean, s: RehearseSettings) =>
  Effect.gen(function* () {
    // The card is gone: nothing to fix.
    if (step === undefined) return { ...finding, real: 0, route: "drop" } satisfies Triaged
    // A liked step is kept, not changed; a wanted feature is the operator's call.
    if (finding.kind === "delight") return { ...finding, real: 1, route: "drop" } satisfies Triaged
    if (finding.kind === "feature") return { ...finding, real: 1, route: "ask" } satisfies Triaged
    const a = yield* decide({
      state: `A product's specified step:\n${stepText(step)}\nA tester reported (${finding.kind}, ${finding.severity}): ${finding.notes.join(" / ")}`,
      questions: {
        real: { type: "noul", instructions: "Does the step as written really have this problem?" },
        route: {
          type: "choice",
          instructions: "What would resolving it take?",
          criteria: { fix: "a small local change to this step's cards", decide: "a product decision the owner must make", removes: "removing or reshaping something that already exists", noise: "nothing; the report is wrong or trivial" },
        },
      },
    }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, never>))
    const real = a.real?.type === "noul" ? a.real.probability : 0.5
    const kind = a.route?.type === "choice" ? a.route.choice : "decide"
    const route: Triaged["route"] =
      real <= s.realDrop || kind === "noise" ? "drop" : real < s.realKeep ? "ask" : kind === "fix" && !built ? "fix" : "ask"
    return { ...finding, real, route } satisfies Triaged
  })
