// packages/core/src/rehearse/types.ts
import type { Effect } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"

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
export type Triaged = Finding & { readonly real: number; readonly route: "fix" | "ask" | "drop" }
export type Decide = (req: DecisionRequest) => Effect.Effect<Readonly<Record<string, Answer>>, unknown>
