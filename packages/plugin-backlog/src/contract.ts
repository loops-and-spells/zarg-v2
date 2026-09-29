import { Schema } from "effect"
import { pluginContract } from "@zarg/plugin-sdk"

export const Severity = Schema.Literals(["high", "medium", "low"])
/** A report as its source files it: what it is about (a ref with the version seen), where, who, what, and the source's first call on it. */
export const FiledEntry = Schema.Struct({
  ref: Schema.String,
  journeys: Schema.Array(Schema.String),
  persona: Schema.String,
  kind: Schema.String,
  severity: Severity,
  note: Schema.String,
  from: Schema.Struct({ agent: Schema.String, run: Schema.String }),
  triage: Schema.Struct({ on: Schema.Boolean, why: Schema.String }),
})
export type FiledEntry = typeof FiledEntry.Type
export const FeedbackState = Schema.Literals(["open", "stale", "planned", "closed"])
export type FeedbackState = typeof FeedbackState.Type

/** A plan: the cards it changes (refs with the version drafted on), the gherkin tool calls that change them, the feedback it closes. */
export const PlanParams = Schema.Struct({
  title: Schema.String,
  journey: Schema.String,
  cards: Schema.Array(Schema.Struct({ ref: Schema.String, to: Schema.optionalKey(Schema.String) })),
  changes: Schema.Array(Schema.Struct({ tool: Schema.String, params: Schema.Unknown })),
  feedback: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.String),
  after: Schema.optionalKey(Schema.Array(Schema.String)),
  persona: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Severity),
})
export type PlanParams = typeof PlanParams.Type
export const Lane = Schema.Literals(["backlog", "ready", "running", "review", "done"])
export const Moved = Schema.Struct({ id: Schema.String, to: Lane, by: Schema.String, what: Schema.optionalKey(Schema.String), needs: Schema.optionalKey(Schema.String), cards: Schema.optionalKey(Schema.Array(Schema.String)) })
export const ItemData = Schema.Struct({
  ...PlanParams.fields,
  id: Schema.String,
  status: Lane,
  agent: Schema.optionalKey(Schema.String),
  dropped: Schema.optionalKey(Schema.Boolean),
  needs: Schema.optionalKey(Schema.String),
  events: Schema.Array(Schema.Struct({ what: Schema.String, by: Schema.String })),
})
const DraftCalls = Schema.Array(Schema.Struct({ tool: Schema.String, params: Schema.Unknown }))
/** One ask of the model for a card. */
export const Try = Schema.Struct({ ms: Schema.Number, tokensIn: Schema.Number, tokensOut: Schema.Number, reasoning: Schema.Number, finish: Schema.optionalKey(Schema.String), problems: Schema.Array(Schema.String) })
export const StageData = Schema.Struct({
  journey: Schema.String,
  stage: Schema.Literals(["triage", "refine", "rehearse", "plan", "planned"]),
  proposals: Schema.Array(Schema.Struct({ card: Schema.String, title: Schema.optionalKey(Schema.String), tries: Schema.optionalKey(Schema.Array(Try)), rounds: Schema.optionalKey(Schema.Number), changes: DraftCalls, answers: Schema.Array(Schema.String), summary: Schema.String, status: Schema.Literals(["waiting", "proposed", "accepted", "skipped"]), problems: Schema.optionalKey(Schema.Array(Schema.String)), fromFresh: Schema.optionalKey(Schema.Boolean) })),
  draft: DraftCalls,
  cards: Schema.optionalKey(Schema.Array(Schema.String)),
  run: Schema.optionalKey(Schema.String),
  results: Schema.optionalKey(Schema.Struct({ resolved: Schema.Array(Schema.String), fresh: Schema.Array(Schema.Struct({ card: Schema.String, kind: Schema.String, severity: Schema.String, note: Schema.String })) })),
  plan: Schema.optionalKey(Schema.Struct({ title: Schema.String, steps: Schema.Array(Schema.String) })),
  item: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  inputs: Schema.optionalKey(Schema.Array(Schema.String)),
  redrafts: Schema.optionalKey(Schema.Number),
  queued: Schema.optionalKey(Schema.Number),
  dropRun: Schema.optionalKey(Schema.String),
  worker: Schema.optionalKey(Schema.String),
  dismissed: Schema.optionalKey(Schema.Array(Schema.Struct({ card: Schema.String, kind: Schema.String }))),
})
export const Propose = Schema.Struct({ journey: Schema.String, card: Schema.String, title: Schema.optionalKey(Schema.String), tries: Schema.optionalKey(Schema.Array(Try)), changes: DraftCalls, answers: Schema.Array(Schema.String), summary: Schema.String, problems: Schema.optionalKey(Schema.Array(Schema.String)) })
export const Rehearsing = Schema.Struct({ journey: Schema.String, run: Schema.optionalKey(Schema.String), cards: Schema.optionalKey(Schema.Array(Schema.String)), note: Schema.optionalKey(Schema.String), clear: Schema.optionalKey(Schema.Boolean), dropped: Schema.optionalKey(Schema.Boolean) })
export const Redraft = Schema.Struct({ journey: Schema.String, problems: Schema.Array(Schema.String) })
export const Rehearsed = Schema.Struct({
  journey: Schema.String,
  resolved: Schema.Array(Schema.String),
  fresh: Schema.Array(Schema.Struct({ card: Schema.String, kind: Schema.String, severity: Schema.String, note: Schema.String })),
  next: Schema.Literals(["plan", "refine"]),
  cards: Schema.optionalKey(Schema.Array(Schema.String)),
})
export const Drafted = Schema.Struct({ journey: Schema.String, title: Schema.String, steps: Schema.Array(Schema.String) })
export const OnEntry = Schema.Struct({ id: Schema.String, ref: Schema.String, kind: Schema.String, severity: Schema.String, note: Schema.String, persona: Schema.String, on: Schema.Boolean, operatorNote: Schema.optionalKey(Schema.String) })
/** The backlog's surface for other plugins: file feedback and ask where it stands; add a plan, take the next, record a move. */
export const Backlog = pluginContract("backlog", {
  file: { params: Schema.Struct({ entries: Schema.Array(FiledEntry) }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
  status: { params: Schema.Struct({ ids: Schema.Array(Schema.String) }), success: Schema.Array(Schema.Struct({ id: Schema.String, state: FeedbackState, on: Schema.Boolean })) },
  plan: { params: PlanParams, success: Schema.Struct({ id: Schema.String }) },
  next: { params: Schema.Struct({}), success: Schema.NullOr(ItemData) },
  moved: { params: Moved, success: Schema.Null },
  stages: { params: Schema.Struct({}), success: Schema.Array(StageData) },
  feedbackOf: { params: Schema.Struct({ journey: Schema.String }), success: Schema.Array(OnEntry) },
  propose: { params: Propose, success: Schema.Null },
  rehearsing: { params: Rehearsing, success: Schema.Null },
  rehearsed: { params: Rehearsed, success: Schema.Null },
  drafted: { params: Drafted, success: Schema.Null },
  redraft: { params: Redraft, success: Schema.Null },
  assign: { params: Schema.Struct({ journey: Schema.String, worker: Schema.optionalKey(Schema.String) }), success: Schema.Null },
  redo: { params: Schema.Struct({ journey: Schema.String, card: Schema.String }), success: Schema.Struct({ notice: Schema.String }) },
})
