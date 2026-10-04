import { parseRef, versionOf } from "@zarg/entities"

export type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
export const STAGE_NAMES = ["triage", "refine", "rehearse", "plan", "planned"] as const
export type StageName = (typeof STAGE_NAMES)[number]
export const STAGE_TITLES: Readonly<Record<StageName, string>> = { triage: "Triage", refine: "Refine", rehearse: "Re-rehearse", plan: "Plan", planned: "Planned" }

/** One ask of the model for a scenario: how long, its tokens, how it ended, what was wrong with it (none: it went in). */
export interface Try {
  readonly ms: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly reasoning: number
  readonly finish?: string
  readonly problems: ReadonlyArray<string>
}
/** The Triage Agent's proposal for one scenario: gherkin tool calls, the feedback they answer, and the operator's call on it. */
export interface Proposal {
  readonly scenario: string
  /** The scenario's title when it was drafted. */
  readonly title?: string
  /** Each ask of the model for it, in order (across rounds). */
  readonly tries?: ReadonlyArray<Try>
  /** How many rounds of tries failed: it is drafted again on its own until ROUNDS, then left out. */
  readonly rounds?: number
  readonly changes: Draft
  readonly answers: ReadonlyArray<string>
  readonly summary: string
  readonly status: "waiting" | "proposed" | "accepted" | "skipped"
  /** What the dry-run found wrong with it (it cannot be accepted as it is). */
  readonly problems?: ReadonlyArray<string>
  /** Born of a re-rehearse finding (skipping it dismisses that finding for this journey). */
  readonly fromFresh?: boolean
  /** The operator kept it left out (the inbox's Leave it out): not raised again this round. */
  readonly leftOut?: boolean
}
/** Where a journey's triage stands: the stage, the proposals and the draft they built, the re-rehearse, the plan. */
export interface Stage {
  readonly journey: string
  readonly stage: StageName
  readonly proposals: ReadonlyArray<Proposal>
  /** The accepted changes, in order: never written until a plan runs. */
  readonly draft: Draft
  /** The scenarios the draft touches (from its dry-run). */
  readonly scenarios?: ReadonlyArray<string>
  readonly run?: string
  readonly results?: { readonly resolved: ReadonlyArray<string>; readonly fresh: ReadonlyArray<{ readonly scenario: string; readonly kind: string; readonly severity: string; readonly note: string }> }
  readonly plan?: { readonly title: string; readonly steps: ReadonlyArray<string> }
  readonly item?: string
  /** A folded round's plans, in order. */
  readonly items?: ReadonlyArray<string>
  /** The agent's last word on it (waiting for a run, a model that did not answer). */
  readonly note?: string
  /** The feedback that was on when Refine started (what a plan closes). */
  readonly inputs?: ReadonlyArray<string>
  /** A re-rehearse run the round left behind (d, Refine again): the Triage Agent stops it. */
  readonly dropRun?: string
  /** Its place in the triage queue (lower goes first). */
  readonly queued?: number
  /** The triage worker on it (triage-1…N), once one took it. */
  readonly worker?: string
  /** How often the whole draft failed its checks and was drafted again. */
  readonly redrafts?: number
  /** Re-rehearse findings the operator skipped: not brought back again. */
  readonly dismissed?: ReadonlyArray<{ readonly scenario: string; readonly kind: string }>
}

export const fresh = (journey: string): Stage => ({ journey, stage: "triage", proposals: [], draft: [] })
/** A journey's file name: readable, and unique (two names that read the same keep apart). */
export const slug = (journey: string) => `${journey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey"}-${versionOf(journey).slice(0, 6)}`
/** Where the stepper (Triage ─ Refine ─ Backlog) stands: a round in flight is in Refine until its plan is on the Backlog. */
export const stepperAt = (s: Stage) => (s.stage === "triage" ? 0 : s.stage === "planned" ? 2 : 1)
/** The proposal the operator decides next: the first not decided. */
export const current = (s: Stage) => s.proposals.find((p) => p.status === "proposed" || p.status === "waiting")

/** Refine the journey's feedback that is on: one proposal (to come) per scenario. */
type OnLike = { readonly id?: string; readonly ref: string; readonly triage: { readonly on: boolean } }
const scenariosOn = (entries: ReadonlyArray<OnLike>) => [...new Set(entries.filter((e) => e.triage.on).map((e) => parseRef(e.ref)?.id ?? e.ref))]
const waiting = (scenario: string) => ({ scenario, changes: [], answers: [], summary: "", status: "waiting" as const })
// @scenario S-0108 S-0109
export const startRefine = (s: Stage, entries: ReadonlyArray<OnLike>): Stage | string => {
  const scenarios = scenariosOn(entries)
  if (scenarios.length === 0) return `nothing on in ${s.journey}: turn feedback on first`
  const { results: _r, plan: _p, item: _i, items: _is, run: _run, scenarios: _c, note: _n, dismissed: _d, redrafts: _rd, ...rest } = s
  return { ...rest, stage: "refine", proposals: scenarios.map(waiting), draft: [], inputs: entries.filter((e) => e.triage.on && e.id !== undefined).map((e) => e.id!) }
}
/** Refine again, from Plan (or out of a re-rehearse that hangs): the scenarios whose feedback is on and not resolved, over the draft so far. */
export const refineAgain = (s: Stage, entries: ReadonlyArray<OnLike>): Stage | string => {
  if (s.stage !== "plan" && s.stage !== "rehearse") return `${s.journey} is being refined already`
  const resolved = s.results?.resolved ?? []
  const left = entries.filter((e) => e.id === undefined || !resolved.includes(e.id))
  const scenarios = scenariosOn(left)
  if (scenarios.length === 0) return `nothing left to refine in ${s.journey}: a accepts the plan`
  const { plan: _p, results: _r, run: _run, note: _n, ...rest } = s
  return { ...rest, ...(s.run !== undefined ? { dropRun: s.run } : {}), stage: "refine", proposals: [...s.proposals, ...scenarios.map(waiting)], inputs: [...new Set([...(s.inputs ?? []), ...left.filter((e) => e.triage.on && e.id !== undefined).map((e) => e.id!)])] }
}
/** The accepted draft fails as a whole: its proposals are drafted again, once; a second failure leaves them out and goes to Plan. */
export const redraft = (s: Stage, problems: ReadonlyArray<string>): Stage => {
  const { run: _r, ...rest } = s
  if ((s.redrafts ?? 0) >= 1)
    return { ...rest, stage: "plan", draft: [], proposals: s.proposals.map((p) => (p.status === "accepted" ? { ...p, status: "skipped" as const, problems } : p)), note: `The changes still do not fit together: ${problems.join("; ")}` }
  return { ...rest, stage: "refine", draft: [], redrafts: (s.redrafts ?? 0) + 1, proposals: s.proposals.map((p) => (p.status === "accepted" ? { ...p, status: "waiting" as const } : p)), note: `The changes did not fit together, drafting them again: ${problems.join("; ")}` }
}

/** How many rounds of tries a scenario gets before it is left out. */
export const ROUNDS = 3
/** The Triage Agent's proposal for a scenario: into the draft when it passed its checks, else left out with its problems; the last moves on. */
export const settle = (s: Stage, p: { readonly scenario: string; readonly title?: string; readonly changes: Draft; readonly answers: ReadonlyArray<string>; readonly summary: string; readonly problems?: ReadonlyArray<string>; readonly tries?: ReadonlyArray<Try> }): Stage => {
  if (s.stage !== "refine") return s
  const failed = (p.problems ?? []).length > 0
  let taken = false
  let left = false
  const proposals = s.proposals.map((x) => {
    if (taken || x.scenario !== p.scenario || x.status !== "waiting") return x
    taken = true
    // Failed: drafted again on its own (the model often gets it the next time), until ROUNDS; then left out.
    const rounds = (x.rounds ?? 0) + (failed ? 1 : 0)
    left = failed && rounds >= ROUNDS
    const status = !failed ? ("accepted" as const) : left ? ("skipped" as const) : ("waiting" as const)
    const tries = [...(x.tries ?? []), ...(p.tries ?? [])]
    return { scenario: p.scenario, changes: p.changes, answers: p.answers, summary: p.summary, status, ...(failed ? { problems: p.problems! } : {}), ...(p.title !== undefined ? { title: p.title } : {}), ...(tries.length > 0 ? { tries } : {}), ...(rounds > 0 ? { rounds } : {}) }
  })
  if (!taken) return s
  const draft = failed ? s.draft : [...s.draft, ...p.changes]
  const next: Stage = { ...s, proposals, draft }
  if (current(next) !== undefined) return next
  const { note: _n, ...rest } = next
  // Every scenario decided: the plan is drafted and goes to the Backlog; nothing drafted: back to Triage.
  return draft.length > 0 ? { ...rest, stage: "plan" } : { ...rest, stage: "triage", note: "Nothing drafted: every scenario was left out. Refine to try again." }
}

/** The buttons a stage offers (a note is always there). */
export const stageActions = (s: Stage): ReadonlyArray<string> => (s.stage === "triage" || s.stage === "planned" ? ["refine"] : [])

/** Draft one scenario again: it waits again (keeping what failed, for the model), its changes leave the draft, the round goes back to Refine. */
export const redo = (s: Stage, scenario: string): Stage | string => {
  if (s.stage === "triage" || s.stage === "planned") return `${s.journey} has no round to draft again`
  if (!s.proposals.some((p) => p.scenario === scenario)) return `${scenario} is not in ${s.journey}'s round`
  const proposals = s.proposals.map((p) => (p.scenario === scenario ? { scenario, answers: [], summary: "", changes: [], status: "waiting" as const, ...(p.title !== undefined ? { title: p.title } : {}), ...(p.problems !== undefined ? { problems: p.problems } : {}) } : p))
  const { plan: _p, results: _r, run: _run, note: _n, ...rest } = s
  return { ...rest, ...(s.run !== undefined ? { dropRun: s.run } : {}), stage: "refine", proposals, draft: proposals.filter((p) => p.status === "accepted").flatMap((p) => p.changes) }
}

/** In triage (queued or worked): its feedback is read-only until Plan. */
export const inTriage = (s: Stage) => s.stage === "refine" || s.stage === "rehearse" || s.stage === "plan"
/** The next place in the triage queue. */
export const nextQueued = (all: ReadonlyArray<Stage>) => Math.max(0, ...all.map((s) => s.queued ?? 0)) + 1
/** How the Feedback view names a journey's stage: its place in line, or the worker on it and how far it is. */
export const stageLabel = (s: Stage, all: ReadonlyArray<Stage>): string => {
  if (!inTriage(s)) return STAGE_TITLES[s.stage]
  if (s.worker === undefined) {
    const line = all.filter((x) => inTriage(x) && x.worker === undefined).sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0))
    return `queued #${line.findIndex((x) => x.journey === s.journey) + 1}`
  }
  const done = s.proposals.filter((p) => p.status === "accepted" || p.status === "skipped").length
  return s.stage === "refine" ? `${s.worker} · Refine ${done}/${s.proposals.length} scenarios` : `${s.worker} · Re-rehearse`
}
