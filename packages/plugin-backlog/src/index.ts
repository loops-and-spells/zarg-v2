import { Effect, Schema, Semaphore } from "effect"
import { Config, definePlugin, Entities, Files, PluginFailure, Views } from "@zarg/plugin-sdk"
import { Backlog, FiledEntry } from "./contract"
import { parseRef } from "@zarg/entities"
import { ENTRY_ID, type Entry, entryId, stateOf, target, upsert } from "./feedback"
import { FeedbackView } from "./views"

const DIR = ".zarg/feedback"
const STAGES = ["Triage", "Refine", "Re-rehearse", "Plan"] as const
const Notice = Schema.Struct({ notice: Schema.String })
const Act = Schema.Struct({ agent: Schema.String, action: Schema.String, section: Schema.optionalKey(Schema.String), rows: Schema.Array(Schema.String) })
const EntryData = Schema.Struct({
  ...FiledEntry.fields,
  id: Schema.String,
  count: Schema.Number,
  triage: Schema.Struct({ on: Schema.Boolean, why: Schema.String, by: Schema.Literals(["agent", "operator"]) }),
  state: Schema.optionalKey(Schema.Literals(["planned", "closed"])),
  runs: Schema.optionalKey(Schema.Array(Schema.String)),
})
const isEntry = Schema.is(EntryData)
const NO_JOURNEY = "—"
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`
const fail = (e: unknown) => new PluginFailure({ tag: "BacklogError", message: String((e as { message?: unknown })?.message ?? e) })

/** The backlog: feedback per card version (triaged in the Feedback view), later the plans built from it. */
export default definePlugin({
  name: "backlog",
  service: "Backlog",
  archetype: "service",
  implements: Backlog,
  config: Schema.Struct({}),
  scopes: { agents: true, fs: { read: [`${DIR}/**`], write: [`${DIR}/**`] }, entities: { read: ["gherkin/*"] } },
  views: [FeedbackView],
  surfaces: [{ kind: "nav", name: "feedback", view: "feedback", label: "Feedback" }],
  entities: {
    feedback: { doc: "A tester's report on one version of an entity, and its triage.", data: EntryData, tone: "attention", glyph: "◇", open: "feedback", ops: ["get", "label", "version", "query"] },
  },
  methods: {
    file: { doc: "File feedback (the same report on the same version again counts it).", params: Schema.Struct({ entries: Schema.Array(FiledEntry) }), success: Schema.Struct({ ids: Schema.Array(Schema.String) }) },
    status: { doc: "Where feedback stands.", params: Schema.Struct({ ids: Schema.Array(Schema.String) }), success: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.Literals(["open", "stale", "planned", "closed"]), on: Schema.Boolean })) },
    act: { doc: "The Feedback view: open it, show a journey, flip an entry.", params: Act, success: Notice },
    agenda: { doc: "Feedback files the backlog could not read.", params: Schema.Struct({}), success: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, detail: Schema.String, about: Schema.Array(Schema.String), priority: Schema.Number })) },
  },
  make: Effect.gen(function* () {
    const files = yield* Files
    const views = yield* Views
    const entities = yield* Entities
    yield* Config
    // Files that are not entries (a hand edit, a merge, another format): skipped, and named on the agenda.
    let bad: ReadonlyArray<string> = []
    // ponytail: every call reads the folder; an index file when there are thousands of entries.
    const load = Effect.gen(function* () {
      const names = (yield* files.list(DIR).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))).filter((n) => n.endsWith(".json"))
      const read = yield* Effect.forEach(names, (n) =>
        files.read(`${DIR}/${n}`).pipe(
          Effect.map((t) => { try { return JSON.parse(t) as unknown } catch { return undefined } }),
          Effect.orElseSucceed(() => undefined),
          Effect.map((v) => ({ n, v })),
        ))
      // An entry is its own file: its id is its name, so a copy under another name is not a second entry.
      const ok = (x: { n: string; v: unknown }) => isEntry(x.v) && ENTRY_ID.test(x.v.id) && x.n === `${x.v.id}.json`
      bad = read.filter((x) => !ok(x)).map((x) => x.n)
      return read.filter(ok).map((x) => x.v as Entry)
    })
    // One writer at a time: filing and flipping read, change and write the same files.
    const writing = yield* Semaphore.make(1)
    const save = (e: Entry) => files.write(`${DIR}/${e.id}.json`, `${JSON.stringify(e, null, 2)}\n`)
    /** Each entry with its state now: open, or stale once its entity changed (or went). */
    const withStates = (es: ReadonlyArray<Entry>) =>
      Effect.forEach(es, (e) =>
        e.state !== undefined
          ? Effect.succeed({ e, state: e.state })
          : Effect.map(entities.changed(e.ref).pipe(Effect.orElseSucceed(() => true)), (changed) => ({ e, state: stateOf(e, changed) })), { concurrency: 8 })

    let journey: string | undefined
    const refresh = Effect.gen(function* () {
      const all = yield* withStates(yield* load)
      const open = all.filter((x) => x.state === "open").map((x) => x.e)
      const byJourney = new Map<string, Array<Entry>>()
      for (const e of open) for (const j of e.journeys.length > 0 ? e.journeys : [NO_JOURNEY]) byJourney.set(j, [...(byJourney.get(j) ?? []), e])
      const names = [...byJourney.keys()].sort((a, b) => (a === NO_JOURNEY ? 1 : b === NO_JOURNEY ? -1 : a.localeCompare(b)))
      if (journey === undefined || !byJourney.has(journey)) journey = names[0]
      const shown = journey === undefined ? [] : byJourney.get(journey)!
      const on = shown.filter((e) => e.triage.on).length
      const stepper = STAGES.map((s, i) => (i === 0 ? `**● ${s}**` : `○ ${s}`)).join("  ───  ")
      yield* views.set("feedback", FeedbackView, "stage", {
        markdown: journey === undefined ? `${stepper}\n\nNo open feedback. Testers file it when they rehearse.` : `${stepper}\n\n**${journey}** · ${plural(shown.length, "entry")} · ${on} on`,
      })
      yield* views.set("feedback", FeedbackView, "journeys", { rows: names.map((j) => ({ id: j, cells: { journey: j, open: String(byJourney.get(j)!.length), stage: "Triage" } })) })
      const sev = { high: 0, medium: 1, low: 2 } as const
      const sorted = [...shown].sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id))
      yield* views.set("feedback", FeedbackView, "feedback", {
        rows: sorted.map((e) => ({
          id: e.id,
          on: e.triage.on,
          cells: { card: target(e.ref), severity: e.severity, kind: e.kind, feedback: e.note, why: `${e.triage.by === "operator" ? "you" : "agent"}: ${e.triage.why}` },
          search: [e.id, e.ref, e.persona, e.kind, e.severity, e.note, ...e.journeys].join(" "),
        })),
      })
      const contexts = yield* Effect.forEach(sorted, (e) => Effect.map(entities.context(target(e.ref)).pipe(Effect.orElseSucceed(() => "")), (c) => [e.id, c] as const), { concurrency: 8 })
      const detail = (e: Entry, context: string) =>
        [
          `**${e.kind} · ${e.severity}** · ${e.triage.on ? "on" : "off"} (${e.triage.by === "operator" ? "your call" : "the agent's call"}: ${e.triage.why})`,
          "",
          e.note,
          "",
          `by ${e.persona} · in ${e.journeys.join(", ") || NO_JOURNEY} · from ${e.from.agent} ${e.from.run}${e.count > 1 ? ` · reported ${e.count} times` : ""}`,
          ...(context.length > 0 ? ["", "```gherkin", context.trim(), "```"] : []),
        ].join("\n")
      yield* views.set("feedback", FeedbackView, "detail", { markdown: "", rows: Object.fromEntries(contexts.map(([id, c]) => [id, detail(sorted.find((e) => e.id === id)!, c)])) })
      return { journeys: names.length, open: open.length }
    })

    /** Each entry filed, or "" where it was refused (a ref without a version) or could not be saved; the rest are filed. */
    const file = ({ entries }: { entries: ReadonlyArray<FiledEntry> }) =>
      Effect.gen(function* () {
        const had = new Map((yield* load).map((e) => [e.id, e]))
        const ids: Array<string> = []
        for (const f of entries) {
          if (parseRef(f.ref)?.version === undefined) {
            ids.push("")
            continue
          }
          const e = upsert(had.get(entryId(f)), f)
          const saved = yield* Effect.match(save(e), { onFailure: () => false, onSuccess: () => true })
          if (saved) had.set(e.id, e)
          ids.push(saved ? e.id : "")
        }
        return { ids }
      }).pipe(writing.withPermits(1), Effect.mapError(fail))
    const status = ({ ids }: { ids: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const all = yield* withStates((yield* load).filter((e) => ids.includes(e.id)))
        return all.map((x) => ({ id: x.e.id, state: x.state, on: x.e.triage.on }))
      })
    const act = ({ agent, action, rows }: { agent: string; action: string; rows: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        if (agent !== "feedback") return { notice: `backlog has no view ${agent}` }
        if (action === "journey" && rows[0] !== undefined) journey = rows[0]
        if (action === "toggle")
          yield* Effect.gen(function* () {
            const all = yield* load
            for (const id of rows) {
              const e = all.find((x) => x.id === id)
              if (e !== undefined) yield* save({ ...e, triage: { on: !e.triage.on, why: e.triage.why, by: "operator" } })
            }
          }).pipe(writing.withPermits(1))
        const r = yield* refresh
        return { notice: action === "toggle" ? `${plural(rows.length, "entry")} flipped` : r.open === 0 ? "no open feedback" : `${plural(r.open, "open entry")} in ${plural(r.journeys, "journey")}` }
      }).pipe(Effect.mapError(fail))

    const byIds = (ids: ReadonlyArray<string>) => Effect.map(load, (all) => all.filter((e) => ids.includes(e.id)).map((e) => ({ id: e.id, data: e })))
    const agenda = () =>
      Effect.map(load, () =>
        bad.map((n) => ({ id: `backlog:bad-file:${n}`, title: `Feedback file ${DIR}/${n} is not a feedback entry`, detail: "The backlog skips it. Fix or remove the file (an entry's id is its file name).", about: [], priority: 2 })),
      )
    return {
      file,
      status,
      act,
      agenda,
      entities: {
        feedback: {
          get: byIds,
          query: ({ where }: { where?: Readonly<Record<string, unknown>> }) =>
            Effect.map(load, (all) => all.filter((e) => where === undefined || Object.entries(where).every(([k, v]) => JSON.stringify((e as Record<string, unknown>)[k]) === JSON.stringify(v))).map((e) => e.id)),
          label: (x: { id: string; data: Entry }) => `${x.data.kind} on ${target(x.data.ref).split(":")[1] ?? x.data.ref}: ${x.data.note.slice(0, 60)}`,
        },
      },
    }
  }),
})
