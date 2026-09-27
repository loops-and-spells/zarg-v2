// packages/core/src/rehearse/types.ts
import type { Effect } from "effect"

export interface StepView {
  readonly card: string
  readonly title: string
  readonly given: string
  readonly when: string
  readonly thens: ReadonlyArray<string>
  readonly via?: { readonly card: string; readonly when: string }
  readonly fork: ReadonlyArray<{ readonly card: string; readonly when: string }>
  readonly hasFailure: boolean
}
export interface Persona { readonly name: string; readonly text: string }
export type Reason = "feel" | "fail" | "fork" | "seam"
export interface Screened { readonly feel: number; readonly fail: number; readonly arrive: number; readonly fork?: number; readonly flags: ReadonlyArray<Reason> }
export type Kind = "friction" | "gap" | "contradiction" | "transition" | "feature" | "delight"
export interface Finding {
  readonly id: string
  readonly kind: Kind
  readonly card: string
  readonly edge?: { readonly from: string; readonly to: string }
  readonly severity: "high" | "medium" | "low"
  readonly notes: ReadonlyArray<string>
  readonly op?: unknown
  readonly count: number
  readonly personas: ReadonlyArray<string>
}
/** `hash`: the card's text as triaged (`stepHash`), so a fix can tell the card changed since. */
export type Triaged = Finding & { readonly real: number; readonly route: "fix" | "ask" | "drop"; readonly hash?: string }
export type Decide = (req: DecisionRequest) => Effect.Effect<Readonly<Record<string, Answer>>, unknown>

/** The decision model's answers and requests, as the Decisions power speaks them. */
export type Answer =
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: "noul"; readonly answer: boolean; readonly probability: number; readonly confidence: number }
  | { readonly type: "score"; readonly score: number; readonly level: string; readonly probabilities: ReadonlyArray<number>; readonly confidence: number }
export type Question =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "score"; readonly instructions: string; readonly levels: ReadonlyArray<string> }
export interface DecisionRequest { readonly state: string; readonly questions: Readonly<Record<string, Question>> }
/** One model call: the Models power, on the plugin's role. */
export type Complete = (req: { readonly messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>; readonly outputSchema?: Record<string, unknown>; readonly maxTokens?: number }) => Effect.Effect<{ readonly text: string }, { readonly message: string }>
