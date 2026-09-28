import { parseRef, versionOf } from "@zarg/entities"

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
  /** Born of a re-rehearse finding (skipping it dismisses that finding for this journey). */
  readonly fromFresh?: boolean
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
  /** The feedback that was on when Refine started (what a plan closes). */
  readonly inputs?: ReadonlyArray<string>
  /** Re-rehearse findings the operator skipped: not brought back again. */
  readonly dismissed?: ReadonlyArray<{ readonly card: string; readonly kind: string }>
}

export const fresh = (journey: string): Stage => ({ journey, stage: "triage", proposals: [], draft: [] })
/** A journey's file name: readable, and unique (two names that read the same keep apart). */
export const slug = (journey: string) => `${journey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey"}-${versionOf(journey).slice(0, 6)}`
export const stepperAt = (s: Stage) => STAGE_NAMES.indexOf(s.stage)
/** The proposal the operator decides next: the first not decided. */
export const current = (s: Stage) => s.proposals.find((p) => p.status === "proposed" || p.status === "waiting")

/** Refine the journey's feedback that is on: one proposal (to come) per card. */
type OnLike = { readonly id?: string; readonly ref: string; readonly triage: { readonly on: boolean } }
const cardsOn = (entries: ReadonlyArray<OnLike>) => [...new Set(entries.filter((e) => e.triage.on).map((e) => parseRef(e.ref)?.id ?? e.ref))]
const waiting = (card: string) => ({ card, changes: [], answers: [], summary: "", status: "waiting" as const })
export const startRefine = (s: Stage, entries: ReadonlyArray<OnLike>): Stage | string => {
  const cards = cardsOn(entries)
  if (cards.length === 0) return `nothing on in ${s.journey}: turn feedback on first`
  const { results: _r, plan: _p, item: _i, run: _run, cards: _c, note: _n, dismissed: _d, ...rest } = s
  return { ...rest, stage: "refine", proposals: cards.map(waiting), draft: [], inputs: entries.filter((e) => e.triage.on && e.id !== undefined).map((e) => e.id!) }
}
/** Back from Plan to Refine: what was decided stays; cards with feedback on and no proposal yet get one. */
export const refineMore = (s: Stage, entries: ReadonlyArray<OnLike>): Stage | string => {
  if (s.stage !== "plan") return `${s.journey} is in ${STAGE_TITLES[s.stage]}: nothing to refine more`
  const fresh_ = cardsOn(entries).filter((c) => !s.proposals.some((p) => p.card === c))
  if (fresh_.length === 0) return `nothing new to refine in ${s.journey}: b backlogs the plan`
  const { plan: _p, ...rest } = s
  return { ...rest, stage: "refine", proposals: [...s.proposals, ...fresh_.map(waiting)], inputs: [...new Set([...(s.inputs ?? []), ...entries.filter((e) => e.triage.on && e.id !== undefined).map((e) => e.id!)])] }
}
/** The operator moves on to Plan with what is accepted (a re-rehearse that will not settle, a finding they accept). */
export const planNow = (s: Stage): Stage | string => {
  if (s.stage !== "refine" && s.stage !== "rehearse") return `${s.journey} is in ${STAGE_TITLES[s.stage]}: nothing to plan now`
  if (s.draft.length === 0) return `nothing to plan in ${s.journey}: no change was accepted`
  const { run: _r, note: _n, ...rest } = s
  return { ...rest, stage: "plan", proposals: s.proposals.map((p) => (p.status === "waiting" || p.status === "proposed" ? { ...p, status: "skipped" as const } : p)) }
}
/** The accepted draft fails as a whole: back to Refine, its accepted proposals to decide again, with the problems. */
export const redraft = (s: Stage, problems: ReadonlyArray<string>): Stage => {
  const { run: _r, ...rest } = s
  return { ...rest, stage: "refine", draft: [], proposals: s.proposals.map((p) => (p.status === "accepted" ? { ...p, status: "proposed" as const, problems } : p)), note: `The accepted changes do not fit together: ${problems.join("; ")}` }
}

/** The operator's call on the current proposal; the last one moves the journey to re-rehearse. */
export const decide = (s: Stage, call: "accept" | "skip"): Stage | string => {
  if (s.stage !== "refine") return `${s.journey} is in ${STAGE_TITLES[s.stage]}: nothing to ${call}`
  const p = current(s)
  if (p === undefined) return "no proposal to decide"
  if (p.status === "waiting") return `the Triage Agent is still drafting ${p.card}'s proposal`
  if (call === "accept" && (p.problems ?? []).length > 0) return `${p.card}'s proposal has problems: skip it (or refine again later)`
  const proposals = s.proposals.map((x) => (x === p ? { ...x, status: call === "accept" ? ("accepted" as const) : ("skipped" as const) } : x))
  const draft = call === "accept" ? [...s.draft, ...p.changes] : s.draft
  // A skipped proposal for a re-rehearse finding: that finding is not brought back for this journey.
  const dismissed = call === "skip" && p.fromFresh === true ? [...(s.dismissed ?? []), ...(s.results?.fresh ?? []).filter((f) => f.card === p.card).map((f) => ({ card: f.card, kind: f.kind }))] : s.dismissed
  const next: Stage = { ...s, proposals, draft, ...(dismissed !== undefined ? { dismissed } : {}) }
  return current(next) === undefined ? { ...next, stage: "rehearse" } : next
}
