import { parseRef, versionOf } from "@zarg/entities"
import type { FeedbackState, FiledEntry } from "./contract"

/** A feedback entry as the backlog keeps it: the report, how often it came, and the triage (whose call it is). */
export type Entry = Omit<FiledEntry, "triage"> & {
  readonly id: string
  readonly count: number
  readonly triage: { readonly on: boolean; readonly why: string; readonly by: "agent" | "operator" }
  /** Set once a plan takes it (`planned`) or it is resolved (`closed`); otherwise its state follows its ref. */
  readonly state?: "planned" | "closed"
  /** The operator's note for refinement (kept when the report is filed again). */
  readonly operatorNote?: string
  /** The runs that reported it (`agent:run`): one run filing again (after a restart) does not count twice. */
  readonly runs?: ReadonlyArray<string>
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
/** One report on one version of one entity: the same words again are the same entry. */
export const entryId = (f: Pick<FiledEntry, "ref" | "kind" | "note">) => `F-${versionOf({ ref: f.ref, kind: f.kind, note: norm(f.note) }).slice(0, 8)}`

/** File a report: new, or counted again; the operator's call stands, the agent's is replaced by its latest. */
export const upsert = (had: Entry | undefined, f: FiledEntry): Entry => {
  const run = `${f.from.agent}:${f.from.run}`
  if (had === undefined) return { ...f, id: entryId(f), count: 1, runs: [run], triage: { ...f.triage, by: "agent" } }
  const runs = had.runs ?? [`${had.from.agent}:${had.from.run}`]
  return {
    ...had,
    count: runs.includes(run) ? had.count : had.count + 1,
    runs: runs.includes(run) ? runs : [...runs, run],
    journeys: [...new Set([...had.journeys, ...f.journeys])],
    triage: had.triage.by === "operator" ? had.triage : { ...f.triage, by: "agent" },
  }
}

export const stateOf = (e: Entry, changed: boolean): FeedbackState => e.state ?? (changed ? "stale" : "open")

/** The ref without its version (how views name the entity, so its label is found). */
export const target = (ref: string) => {
  const r = parseRef(ref)
  return r === undefined ? ref : `${r.type}:${r.id}`
}
export const ENTRY_ID = /^F-[0-9a-f]{8}$/
