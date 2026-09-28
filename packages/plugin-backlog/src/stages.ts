import { parseRef } from "@zarg/entities"

export type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
export const STAGE_NAMES = ["triage", "refine", "rehearse", "plan", "planned"] as const
export type StageName = (typeof STAGE_NAMES)[number]
export const STAGE_TITLES: Readonly<Record<StageName, string>> = { triage: "Triage", refine: "Refine", rehearse: "Re-rehearse", plan: "Plan", planned: "Planned" }

/** The Triage Agent's proposal for one card: gherkin tool calls, the feedback they answer, and the operator's call on it. */
export interface Proposal {
  readonly card: string
  readonly changes: Draft
  readonly answers: ReadonlyArray<string>
  readonly summary: string
  readonly status: "waiting" | "proposed" | "accepted" | "skipped"
  /** What the dry-run found wrong with it (it cannot be accepted as it is). */
  readonly problems?: ReadonlyArray<string>
}
/** Where a journey's triage stands: the stage, the proposals and the draft they built, the re-rehearse, the plan. */
export interface Stage {
  readonly journey: string
  readonly stage: StageName
  readonly proposals: ReadonlyArray<Proposal>
  /** The accepted changes, in order: never written until a plan runs. */
  readonly draft: Draft
  /** The cards the draft touches (from its dry-run). */
  readonly cards?: ReadonlyArray<string>
  readonly run?: string
  readonly results?: { readonly resolved: ReadonlyArray<string>; readonly fresh: ReadonlyArray<{ readonly card: string; readonly kind: string; readonly severity: string; readonly note: string }> }
  readonly plan?: { readonly title: string; readonly steps: ReadonlyArray<string> }
  readonly item?: string
  /** The agent's last word on it (waiting for a run, a model that did not answer). */
  readonly note?: string
}

export const fresh = (journey: string): Stage => ({ journey, stage: "triage", proposals: [], draft: [] })
export const slug = (journey: string) => journey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey"
export const stepperAt = (s: Stage) => STAGE_NAMES.indexOf(s.stage)
/** The proposal the operator decides next: the first not decided. */
export const current = (s: Stage) => s.proposals.find((p) => p.status === "proposed" || p.status === "waiting")

/** Refine the journey's feedback that is on: one proposal (to come) per card. */
export const startRefine = (s: Stage, entries: ReadonlyArray<{ readonly ref: string; readonly triage: { readonly on: boolean } }>): Stage | string => {
  const cards = [...new Set(entries.filter((e) => e.triage.on).map((e) => parseRef(e.ref)?.id ?? e.ref))]
  if (cards.length === 0) return `nothing on in ${s.journey}: turn feedback on first`
  const { results: _r, plan: _p, item: _i, run: _run, cards: _c, note: _n, ...rest } = s
  return { ...rest, stage: "refine", proposals: cards.map((card) => ({ card, changes: [], answers: [], summary: "", status: "waiting" as const })), draft: [] }
}

/** The operator's call on the current proposal; the last one moves the journey to re-rehearse. */
export const decide = (s: Stage, call: "accept" | "skip"): Stage | string => {
  if (s.stage !== "refine") return `${s.journey} is in ${STAGE_TITLES[s.stage]}: nothing to ${call}`
  const p = current(s)
  if (p === undefined) return "no proposal to decide"
  if (p.status === "waiting") return `the Triage Agent is still drafting ${p.card}'s proposal`
  if (call === "accept" && (p.problems ?? []).length > 0) return `${p.card}'s proposal has problems: skip it, or wait for a new one`
  const proposals = s.proposals.map((x) => (x === p ? { ...x, status: call === "accept" ? ("accepted" as const) : ("skipped" as const) } : x))
  const draft = call === "accept" ? [...s.draft, ...p.changes] : s.draft
  const next: Stage = { ...s, proposals, draft }
  return current(next) === undefined ? { ...next, stage: "rehearse" } : next
}
