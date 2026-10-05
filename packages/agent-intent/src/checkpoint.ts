/** What the intent agent already reconciled: each statement's and journey's version, and where its round ended. */
export type Entry = {
  readonly version: string
  /** planned: plans filed; asked: an inbox topic waits; left: drafts failed (a topic says why); nothing: no change needed. */
  readonly state: "planned" | "asked" | "left" | "nothing"
  readonly plans?: ReadonlyArray<string>
  /** The journeys serving (or bounded by) it when its round ended: another set means its round read other journeys. */
  readonly journeys?: ReadonlyArray<string>
  readonly topic?: string
  /** The operator's answer to the topic: the next round follows it. */
  readonly decision?: string
  /** The answers the topic offered (an answer's label is what the model reads). */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>
}
export type Checkpoint = { readonly statements: Readonly<Record<string, Entry>>; readonly journeys: Readonly<Record<string, Entry>> }
export const EMPTY: Checkpoint = { statements: {}, journeys: {} }

export type Statement = {
  readonly id: string
  readonly kind: "outcome" | "constraint"
  readonly text: string
  readonly version: string
  readonly intent: { readonly id: string; readonly title: string; readonly problem?: string }
  /** The journeys serving it (an outcome) or that it bounds (a constraint). */
  readonly journeys: ReadonlyArray<string>
}
export type JourneyInfo = { readonly id: string; readonly name: string; readonly version: string; readonly scenarios: ReadonlyArray<string>; readonly serves: ReadonlyArray<string> }
export type Due = { readonly kind: "statement"; readonly statement: Statement } | { readonly kind: "journey"; readonly journey: JourneyInfo } | { readonly kind: "removed"; readonly id: string }

/** The journeys serving it changed since its round: what it drafted (or found delivered) was against other journeys. */
export const moved = (e: Entry, s: Statement) => [...(e.journeys ?? [])].sort().join() !== [...s.journeys].sort().join()
/** Planned, but every plan it filed was dropped: nothing will land. Served by nothing, it needs a round again; served, the operator turned the change down. */
const abandoned = (e: Entry, gone: ReadonlySet<string>) => e.state === "planned" && (e.plans ?? []).length > 0 && e.plans!.every((p) => gone.has(p))
/** Planned, with a plan still on its way (not dropped). */
const pending = (e: Entry, gone: ReadonlySet<string>) => e.state === "planned" && (e.plans ?? []).some((p) => !gone.has(p))

/**
 * What needs a round: a removed statement (its plans go), a statement that is new, changed, answered or whose plans were all
 * dropped, and a journey serving nothing (once per version, only while there are outcomes to serve). Journeys wait while any
 * statement is due or has a plan on its way: a statement's round may link that journey itself, and two rounds proposing the same
 * serves link would fail one at the Planner. The same version planned, asked or settled is not due: a tick with nothing due costs nothing.
 */
export const due = (statements: ReadonlyArray<Statement>, journeys: ReadonlyArray<JourneyInfo>, cp: Checkpoint, outcomesExist: boolean, gone: ReadonlySet<string> = new Set()): ReadonlyArray<Due> => {
  const present = new Set(statements.map((s) => s.id))
  const removed: Array<Due> = Object.keys(cp.statements).filter((id) => !present.has(id)).sort().map((id) => ({ kind: "removed", id }))
  const changed: Array<Due> = statements
    .filter((s) => {
      const e = cp.statements[s.id]
      return e === undefined || e.version !== s.version || e.decision !== undefined || (abandoned(e, gone) && s.journeys.length === 0) || moved(e, s)
    })
    .map((statement) => ({ kind: "statement", statement }))
  const waiting = removed.length > 0 || changed.length > 0 || Object.values(cp.statements).some((e) => pending(e, gone))
  const unserving: Array<Due> =
    !outcomesExist || waiting
      ? []
      : journeys
          .filter((j) => {
            const e = cp.journeys[j.id]
            return j.serves.length === 0 && (e === undefined || e.version !== j.version || abandoned(e, gone))
          })
          .map((journey) => ({ kind: "journey", journey }))
  return [...removed, ...changed, ...unserving]
}
