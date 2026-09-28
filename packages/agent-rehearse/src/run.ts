import { Deferred, Effect, Fiber, Semaphore } from "effect"
import { consolidate, diagnose, report } from "./findings"
import { screenStep, stepHash } from "./screen"
import type { RehearseSettings } from "./settings"
import { RunView, StatusView, TesterView } from "./views"
import { triage } from "./triage"
import type { Complete, Decide, Kind, Persona, Screened, StepView, Triaged } from "./types"

/** A report as the backlog takes it (its contract's `FiledEntry`). */
export interface FiledEntry {
  readonly ref: string
  readonly journeys: ReadonlyArray<string>
  readonly persona: string
  readonly kind: string
  readonly severity: "high" | "medium" | "low"
  readonly note: string
  readonly from: { readonly agent: string; readonly run: string }
  readonly triage: { readonly on: boolean; readonly why: string }
}

type RawFinding = { readonly kind: Kind; readonly card: string; readonly edge?: { from: string; to: string }; readonly severity: "high" | "medium" | "low"; readonly note: string; readonly op?: unknown }
export interface RunRecord {
  readonly run: string
  /** When the run started (ms): orders runs, since run ids do not. */
  readonly startedAt: number
  readonly status: "running" | "done" | "stopped"
  readonly strategy: "journey" | "edge-pair" | "teleport"
  readonly focus: ReadonlyArray<string>
  readonly personas: ReadonlyArray<Persona>
  readonly stories: ReadonlyArray<ReadonlyArray<string>>
  readonly unreachable: number
  /** Per persona and story prefix (`name|A>B`); null: the decision model could not screen it. */
  readonly screened: Readonly<Record<string, Screened | null>>
  readonly raw: ReadonlyArray<{ readonly persona: string } & RawFinding>
  readonly infra: ReadonlyArray<string>
  readonly findings: ReadonlyArray<Triaged>
  readonly report?: string
  /** Each finding's feedback entry in the backlog (its id there), once filed. */
  readonly filed?: Readonly<Record<string, string>>
  /** Walked over a draft (gherkin tool calls, never written): the Triage Agent's re-rehearse. */
  readonly draft?: Draft
  /** False: its findings are for the caller (`result`), not filed with the backlog. */
  readonly file?: boolean
}
/** Gherkin tool calls, in order (gherkin's `Draft`). */
export type Draft = ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
export interface Started { readonly run: string; readonly stories: number; readonly steps: number; readonly personas: ReadonlyArray<string> }

/** A tester's own card: one its persona acts in (a record from before personas: every card). */
export const ownCard = (p: Persona, card: string) => p.cards === undefined || p.cards.includes(card)
/** The steps a tester screens: story prefixes that end at its own card. */
const stepsFor = (p: Persona, stories: ReadonlyArray<ReadonlyArray<string>>) =>
  new Set(stories.flatMap((s) => s.flatMap((c, i) => (ownCard(p, c) ? [s.slice(0, i + 1).join(">")] : [])))).size

/** The plugin's powers, as the run uses them (plain functions, so tests can stub them). */
export interface RunDeps {
  /** The graph's personas, each with the cards it acts in (gherkin's `personas`). */
  readonly personas: () => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly text: string; readonly cards: ReadonlyArray<string> }>, unknown>
  readonly stories: (strategy: "journey" | "edge-pair" | "teleport", focus?: ReadonlyArray<string>, draft?: Draft) => Effect.Effect<{ readonly stories: ReadonlyArray<ReadonlyArray<string>>; readonly unreachable: number }, unknown>
  readonly step: (card: string, via?: string, draft?: Draft) => Effect.Effect<StepView | null, unknown>
  /** Tell the core a run ended (the Triage Agent waits for its re-rehearse). */
  readonly agendaChanged: Effect.Effect<void, unknown>
  readonly decide: Decide
  readonly complete: Complete
  readonly agents: {
    readonly start: (a: { readonly id: string; readonly parent?: string; readonly title: string; readonly task: string; readonly view?: string }) => Effect.Effect<void, unknown>
    readonly status: (a: { readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }) => Effect.Effect<void, unknown>
    readonly step: (a: { readonly id: string; readonly text: string }) => Effect.Effect<void, unknown>
    readonly end: (a: { readonly id: string; readonly ok: boolean; readonly message?: string }) => Effect.Effect<void, unknown>
  }
  readonly now: Effect.Effect<number, unknown>
  readonly uuid: Effect.Effect<string, unknown>
  readonly read: (path: string) => Effect.Effect<string, unknown>
  readonly write: (path: string, text: string) => Effect.Effect<void, unknown>
  readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, unknown>
  /** A card's version now (`Entities.version`); null when it is gone. */
  readonly version: (card: string) => Effect.Effect<string | null, unknown>
  /** File feedback with the backlog; its ids, in order. */
  readonly file: (entries: ReadonlyArray<FiledEntry>) => Effect.Effect<{ readonly ids: ReadonlyArray<string> }, unknown>
  /** Where filed feedback stands now. */
  readonly status: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly state: string; readonly on: boolean }>, unknown>
  /** The agents' views (the SDK's `Views`): the tester's walk and findings, the run's report and findings. */
  readonly views: {
    readonly set: (agent: string, view: typeof TesterView | typeof RunView | typeof StatusView, path: any, data: any) => Effect.Effect<void, unknown>
    readonly append: (agent: string, view: typeof TesterView | typeof RunView, path: any, lines: ReadonlyArray<{ readonly text: string; readonly tone?: "normal" | "ok" | "warn" | "error" | "dim" | "accent" }>) => Effect.Effect<void, unknown>
  }
  /** Its surfaces (the SDK's `Surfaces`): the run's status panel. */
  readonly surfaces: { readonly open: (surface: string, agent: string) => Effect.Effect<void, unknown> }
  readonly settings: RehearseSettings
}

/** A finding as its row: what the list shows, and every word a search should find. */
const findingRow = (x: { readonly id: string; readonly card: string; readonly kind: string; readonly severity: string; readonly note: string; readonly personas: ReadonlyArray<string> }, step: StepView | undefined) => ({
  id: x.id,
  cells: { card: `gherkin/card:${x.card}`, journey: step?.journeys !== undefined && step.journeys.length > 0 ? step.journeys.join(", ") : "—", kind: x.kind, severity: x.severity },
  search: [x.id, x.card, step?.title ?? "", ...(step?.journeys ?? []), ...x.personas, x.kind, x.severity, x.note].join(" "),
})
/** A finding in full, for the detail beside the list: its card and title, who and where, the note, the card as specified. */
const findingDetail = (x: { readonly id: string; readonly card: string; readonly kind: string; readonly severity: string; readonly note: string; readonly personas: ReadonlyArray<string> }, step: StepView | undefined) =>
  [
    `**${step?.title ?? x.card}**  `,
    `\`${x.card}\`${x.id !== "" ? ` · ${x.id}` : ""}  `,
    `${x.kind} · ${x.severity}`,
    "",
    x.note,
    ...(step !== undefined ? ["", "```gherkin", ...(x.personas.length > 0 ? [`By    ${x.personas.join(", ")}`] : []), ...((step.journeys ?? []).length > 0 ? [`In    ${step.journeys!.join(", ")}`] : []), `Given ${step.given}`, `When  ${step.when}`, ...step.thens.map((t, i) => `${i === 0 ? "Then" : "And "}  ${t}`), "```"] : []),
  ].join("\n")

const DIR = ".zarg/rehearse"
const INDEX = `${DIR}/index.json`
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`

/** Rehearse runs: one at a time, in the background, recorded step by step so a restart resumes them. */
export const makeRehearse = (deps: RunDeps) =>
  Effect.gen(function* () {
    const quiet = <A>(e: Effect.Effect<A, unknown>) => Effect.ignore(e)
    const json = <A>(path: string, fallback: A) =>
      deps.read(path).pipe(
        Effect.map((t) => JSON.parse(t) as A),
        Effect.orElseSucceed(() => fallback),
      )
    const records = new Map<string, RunRecord>()
    for (const id of yield* json<ReadonlyArray<string>>(INDEX, [])) {
      const r = yield* json<RunRecord | undefined>(`${DIR}/${id}.json`, undefined)
      if (r !== undefined) records.set(r.run, r)
    }
    // One write at a time: overlapping writes of one file could leave it half old, half new.
    const writing = yield* Semaphore.make(1)
    const save = (r: RunRecord) =>
      Effect.gen(function* () {
        const isNew = !records.has(r.run)
        records.set(r.run, r)
        yield* quiet(deps.write(`${DIR}/${r.run}.json`, JSON.stringify(r, null, 2)))
        if (isNew) yield* quiet(deps.write(INDEX, JSON.stringify([...records.keys()])))
      }).pipe(writing.withPermits(1))
    const lock = yield* Semaphore.make(1)
    let active: { run: string; fiber: Fiber.Fiber<void, unknown> } | undefined

    const walk = (start: RunRecord) =>
      Effect.gen(function* () {
        let rec = start
        const update = (f: (r: RunRecord) => RunRecord) => Effect.suspend(() => save((rec = f(rec))))
        const views = new Map<string, StepView | undefined>()
        const viewOf = (card: string, via?: string) =>
          Effect.gen(function* () {
            const key = `${via ?? ""}>${card}`
            if (!views.has(key)) views.set(key, (yield* deps.step(card, via, rec.draft).pipe(Effect.orElseSucceed(() => null))) ?? undefined)
            return views.get(key)
          })
        yield* quiet(deps.agents.start({ id: "run", title: "rehearse", view: "run", task: `run ${rec.run}: ${plural(rec.stories.length, "story")} × ${plural(rec.personas.length, "tester")}` }))
        // The run's status line shows whatever is open; it closes with the run agent.
        yield* quiet(deps.surfaces.open("status", "run"))
        const sem = yield* Semaphore.make(deps.settings.inFlight)
        // Stories share prefixes and run at once: the first fiber at a prefix screens it, the others wait for it.
        const inFlight = new Map<string, Deferred.Deferred<void>>()
        // Progress per tester: distinct steps (story prefixes) checked out of those to check, so it only goes up.
        const all = rec.personas.reduce((n, p) => n + stepsFor(p, rec.stories), 0)
        let allChecked = 0
        // Model calls holding one of the `in_flight` slots right now (across testers).
        let busySlots = 0
        // The run's Testers list: one line per tester, its progress and what it found.
        const testers = new Map<string, { readonly text: string; detail: string; state: "busy" | "done" }>()
        const showTesters = quiet(
          Effect.suspend(() => deps.views.set("run", RunView, "testers", { items: [...testers.entries()].map(([id, t]) => ({ id, text: t.text, detail: t.detail, state: t.state })) })),
        )
        yield* Effect.forEach(
          rec.personas,
          (persona, pi) =>
            Effect.gen(function* () {
              const id = `tester-${pi + 1}`
              const toCheck = stepsFor(persona, rec.stories)
              const checked = new Set<string>()
              let flagged = 0
              const showProgress = quiet(
                Effect.suspend(() =>
                  deps.views.set(id, TesterView, "progress", {
                    items: [
                      { label: "steps", value: `${checked.size}/${toCheck}` },
                      { label: "flagged", value: String(flagged) },
                      { label: "unreachable", value: String(rec.unreachable) },
                      { label: "busy", value: `${busySlots}/${deps.settings.inFlight}` },
                    ],
                    progress: { done: checked.size, total: toCheck },
                  }),
                ),
              )
              testers.set(id, { text: `${id}  ${persona.text.split("\n")[0]!.slice(0, 40)}`, detail: `0/${toCheck} steps · 0 found`, state: "busy" })
              yield* showTesters
              const progress = (key: string, flags: number) =>
                Effect.gen(function* () {
                  if (checked.has(key)) return
                  checked.add(key)
                  flagged += flags > 0 ? 1 : 0
                  allChecked++
                  testers.get(id)!.detail = `${checked.size}/${toCheck} steps · ${found.filter((r) => r.cells.kind !== "delight").length} found`
                  yield* showTesters
                  yield* quiet(deps.agents.status({ id, progress: { done: checked.size, total: toCheck }, text: `${checked.size}/${toCheck} steps · ${flagged} flagged` }))
                  yield* quiet(deps.agents.status({ id: "run", progress: { done: allChecked, total: all }, text: `${allChecked}/${all} steps` }))
                  yield* showProgress
                  yield* quiet(deps.views.set("run", StatusView, "line", { items: [{ label: "rehearse", value: `${allChecked}/${all} steps` }, { label: "testers", value: String(rec.personas.length) }] }))
                  yield* quiet(deps.views.set("run", RunView, "progress", { items: [{ label: "steps", value: `${allChecked}/${all}` }, { label: "testers", value: String(rec.personas.length) }, { label: "unreachable", value: String(rec.unreachable) }], progress: { done: allChecked, total: all } }))
                })
              yield* quiet(deps.agents.start({ id, parent: "run", title: "tester", task: persona.text, view: "tester" }))
              // The stories this tester walks right now, for its Workers list.
              const walking = new Map<number, { readonly path: string; readonly state: "busy" | "waiting"; readonly detail: string }>()
              const showWorkers = quiet(
                Effect.suspend(() =>
                  deps.views.set(id, TesterView, "workers", { items: [...walking.entries()].map(([n, w]) => ({ id: `s${n}`, text: `story ${n}  ${w.path}`, detail: w.detail, state: w.state })) }),
                ),
              )
              const found: Array<{ readonly id: string; readonly cells: Record<string, string>; readonly search: string; readonly detail: string }> = []
              yield* Effect.forEach(
                // Only stories this persona acts in; each keeps its number in the run.
                rec.stories.map((story, si) => ({ story, n: si + 1 })).filter(({ story }) => story.some((c) => ownCard(persona, c))),
                ({ story, n }) =>
                  Effect.gen(function* () {
                    const prior: Array<StepView> = []
                    const pathAt = (i: number) => story.slice(0, i + 1).map((c, ci) => (ci === i ? `[${c}]` : c)).join(" ▸ ")
                    for (let i = 0; i < story.length; i++) {
                      const key = `${persona.name}|${story.slice(0, i + 1).join(">")}`
                      walking.set(n, { path: pathAt(i), state: "waiting", detail: "queued" })
                      yield* showWorkers
                      const step = yield* viewOf(story[i]!, story[i - 1])
                      if (step === undefined) break
                      // Another persona's step: context for what follows, never screened or counted.
                      if (!ownCard(persona, step.card)) {
                        prior.push(step)
                        continue
                      }
                      const waiting = inFlight.get(key)
                      if (waiting !== undefined) {
                        walking.set(n, { path: pathAt(i), state: "waiting", detail: `waits at ${step.card}` })
                        yield* showWorkers
                        yield* Deferred.await(waiting)
                        yield* progress(key, rec.screened[key]?.flags.length ?? 0)
                      } else if (key in rec.screened) yield* progress(key, rec.screened[key]?.flags.length ?? 0)
                      else {
                        const done = yield* Deferred.make<void>()
                        inFlight.set(key, done)
                        // Busy only while holding a slot: until then the story is queued.
                        const inSlot = <A, E>(detail: string, work: Effect.Effect<A, E>) =>
                          Semaphore.withPermits(sem, 1)(
                            Effect.gen(function* () {
                              busySlots++
                              walking.set(n, { path: pathAt(i), state: "busy", detail })
                              yield* showWorkers
                              yield* showProgress
                              return yield* work
                            }).pipe(
                              Effect.ensuring(
                                Effect.sync(() => {
                                  busySlots--
                                  walking.set(n, { path: pathAt(i), state: "waiting", detail: "queued" })
                                }),
                              ),
                            ),
                          )
                        const screened = yield* inSlot("screening", screenStep(deps.decide, persona, prior, step, deps.settings))
                        if (screened !== undefined && screened.flags.length > 0) {
                          walking.set(n, { path: pathAt(i), state: "waiting", detail: "queued" })
                          yield* showWorkers
                        }
                        const d = screened !== undefined && screened.flags.length > 0 ? yield* inSlot(`diagnosing ${screened.flags.join(", ")}`, diagnose(deps.complete, persona, prior, step, screened.flags)) : undefined
                        // One write, after the diagnosis: a restart before it screens and diagnoses the step again.
                        yield* update((r) => ({
                          ...r,
                          screened: { ...r.screened, [key]: screened ?? null },
                          ...(d === undefined ? {} : "infra" in d ? { infra: [...r.infra, d.infra] } : { raw: [...r.raw, ...d.findings.map((f) => ({ persona: persona.name, ...f }))] }),
                        }))
                        // The tester's history: what it made of this step.
                        const said =
                          screened === undefined
                            ? "unscreened (the decision model did not answer)"
                            : `feel ${screened.feel.toFixed(2)}, fail ${screened.fail.toFixed(2)}` +
                              (screened.flags.length === 0
                                ? ""
                                : ` → flagged ${screened.flags.join(", ")} → ${d === undefined ? "" : "infra" in d ? "diagnosis failed" : plural(d.findings.length, "finding")}`)
                        yield* quiet(deps.views.append(id, TesterView, "steps", [{ text: `${step.card}: ${said}`, ...(screened !== undefined && screened.flags.length > 0 ? { tone: "warn" as const } : {}) }]))
                        // This tester's findings, as it diagnoses them (the consolidated ones replace them when the run is done).
                        if (d !== undefined && !("infra" in d) && d.findings.length > 0) {
                          for (const f of d.findings) {
                            const x = { id: `${key}#${found.length}`, card: f.card, kind: f.kind, severity: f.severity, note: f.note, personas: [persona.name] }
                            const at = f.card === step.card ? step : yield* viewOf(f.card)
                            found.push({ ...findingRow(x, at), detail: findingDetail({ ...x, id: "" }, at) })
                          }
                          const strip = (r: (typeof found)[number]) => ({ id: r.id, cells: r.cells, search: r.search })
                          yield* quiet(deps.views.set(id, TesterView, "review.feedback", { rows: found.filter((r) => r.cells.kind !== "delight").map(strip) }))
                          yield* quiet(deps.views.set(id, TesterView, "review.likes", { rows: found.filter((r) => r.cells.kind === "delight").map(strip) }))
                          yield* quiet(deps.views.set(id, TesterView, "detail", { markdown: "", rows: Object.fromEntries(found.map((r) => [r.id, r.detail])) }))
                        }
                        yield* progress(key, screened?.flags.length ?? 0)
                        yield* Deferred.succeed(done, undefined)
                      }
                      prior.push(step)
                    }
                    walking.delete(n)
                    yield* showWorkers
                  }),
                { concurrency: "unbounded" },
              )
              yield* quiet(deps.agents.end({ id, ok: true }))
              testers.get(id)!.state = "done"
              yield* showTesters
            }),
          { concurrency: "unbounded" },
        )
        // Consolidate, triage (the decision model's suggestion) and report.
        const found = consolidate(rec.raw)
        const findings = yield* Effect.forEach(
          found,
          (f) =>
            Effect.gen(function* () {
              const step = yield* viewOf(f.card)
              const t = yield* triage(deps.decide, f, step, false, deps.settings)
              return step === undefined ? t : { ...t, hash: stepHash(step) }
            }),
          { concurrency: deps.settings.inFlight },
        )
        const screenedValues = Object.values(rec.screened)
        const text = yield* report(deps.complete, found, {
          steps: screenedValues.length,
          flagged: screenedValues.filter((s) => s !== null && s.flags.length > 0).length,
          unscreened: screenedValues.filter((s) => s === null).length,
        })
        // Every finding but a like goes to the backlog, on the card version the testers saw, with this run's first call on it.
        const filing = yield* Effect.forEach(
          findings.filter((f) => f.kind !== "delight"),
          (f) =>
            Effect.gen(function* () {
              const version = yield* deps.version(f.card).pipe(Effect.orElseSucceed(() => null))
              if (version === null) return undefined
              const step = yield* viewOf(f.card)
              const entry: FiledEntry = {
                ref: `gherkin/card:${f.card}@${version}`,
                journeys: [...(step?.journeys ?? [])],
                persona: f.personas.join(", "),
                kind: f.kind,
                severity: f.severity,
                note: f.notes.join(" / "),
                from: { agent: "rehearse", run: rec.run },
                triage: { on: f.route !== "drop", why: `${f.route} · real ${f.real.toFixed(2)}` },
              }
              return { id: f.id, entry }
            }),
          { concurrency: deps.settings.inFlight },
        )
        // A run over a draft keeps its findings for the caller: the drafted versions are nobody's yet.
        const toFile = rec.file === false ? [] : filing.filter((x) => x !== undefined)
        const filed = toFile.length === 0 ? { ids: [] as ReadonlyArray<string> } : yield* deps.file(toFile.map((x) => x.entry)).pipe(Effect.orElseSucceed(() => ({ ids: [] as ReadonlyArray<string> })))
        yield* update((r) => ({ ...r, status: "done", findings, report: text, filed: Object.fromEntries(toFile.flatMap((x, i) => (filed.ids[i] !== undefined && filed.ids[i] !== "" ? [[x.id, filed.ids[i]!]] : []))) }))
        const unreached = rec.unreachable > 0 ? ` · ${rec.unreachable} unreachable` : ""
        yield* quiet(deps.agents.status({ id: "run", progress: { done: all, total: all }, text: `${plural(filed.ids.filter((x) => x !== "").length, "feedback entry")} filed · triage in Feedback${unreached}` }))
        yield* quiet(deps.views.set("run", RunView, "report", { markdown: text }))
        yield* refresh
        yield* quiet(deps.agents.end({ id: "run", ok: true }))
        yield* quiet(deps.agendaChanged)
      })

    const launch = (rec: RunRecord) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkDetach(
          walk(rec).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (active?.run === rec.run) active = undefined
              }),
            ),
          ),
        )
        active = { run: rec.run, fiber }
      })

    const start = (opts: { readonly strategy?: "journey" | "edge-pair" | "teleport"; readonly focus?: ReadonlyArray<string>; readonly personas?: ReadonlyArray<string>; readonly draft?: Draft; readonly file?: boolean }) =>
      Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          if (active !== undefined) return { refused: `run ${active.run} is still going` }
          const strategy = opts.strategy ?? "journey"
          // No focus, or an empty one, is every story.
          const focus = opts.focus !== undefined && opts.focus.length > 0 ? opts.focus : undefined
          const planned = yield* deps.stories(strategy, focus, opts.draft).pipe(Effect.orElseSucceed(() => ({ stories: [], unreachable: 0 })))
          const graph = yield* deps.personas().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly name: string; readonly text: string; readonly cards: ReadonlyArray<string> }>))
          if (graph.length === 0) return { refused: "no personas yet: the Driver Agent asks about them" }
          const acting = graph.filter((p) => p.cards.length > 0)
          if (acting.length === 0) return { refused: "no persona acts in any card" }
          const personas = opts.personas !== undefined ? acting.filter((p) => opts.personas!.includes(p.name)) : acting
          if (personas.length === 0) return { refused: `no such personas: ${opts.personas!.join(", ")}` }
          const startedAt = yield* deps.now.pipe(Effect.orElseSucceed(() => 0))
          const run = `r-${(yield* deps.uuid.pipe(Effect.orElseSucceed(() => String(startedAt)))).slice(0, 8)}`
          const rec: RunRecord = { run, startedAt, status: "running", strategy, focus: focus ?? [], personas, stories: planned.stories, unreachable: planned.unreachable, screened: {}, raw: [], infra: [], findings: [], ...(opts.draft !== undefined && opts.draft.length > 0 ? { draft: opts.draft } : {}), ...(opts.file === false ? { file: false } : {}) }
          yield* save(rec)
          yield* launch(rec)
          return { run, stories: planned.stories.length, steps: planned.stories.reduce((n, s) => n + s.length, 0), personas: personas.map((p) => p.name) } satisfies Started
        }),
      )

    /** Stop the running run: its record so far is kept, marked stopped. */
    const stop = Effect.gen(function* () {
      if (active === undefined) return
      const { run, fiber } = active
      yield* Fiber.interrupt(fiber)
      const r = records.get(run)
      if (r?.status === "running") {
        yield* save({ ...r, status: "stopped" })
        yield* quiet(deps.agents.end({ id: "run", ok: false, message: "stopped" }))
        yield* quiet(deps.agendaChanged)
      }
    })
    /** A run a restart cut short continues where it was. */
    const resume = Effect.suspend(() => {
      const left = [...records.values()].find((r) => r.status === "running")
      // The views live in the core; after a restart the tables are set again from the records.
      return Effect.andThen(refresh, left === undefined || active !== undefined ? Effect.void : launch(left))
    })

    /** The run still walking (its record not done yet), if any. */
    const going = () => (active !== undefined && records.get(active.run)?.status === "running" ? active.run : undefined)
    /** The newest finished run: the one the tables show. */
    const latest = () => [...records.values()].filter((r) => r.status === "done").sort((a, b) => b.startedAt - a.startedAt)[0]
    const shape = (f: Triaged) => ({ id: f.id, card: f.card, kind: f.kind, severity: f.severity, note: f.notes.join(" / "), personas: f.personas })
    /** The tables of the newest finished run: what each tester filed (and where it is now), the run's feedback by journey. */
    const refresh = Effect.suspend(() => {
      const r = latest()
      // A run going owns the agents' tables (its raw findings); the last run's would replace them.
      if (r === undefined || going() !== undefined) return Effect.void
      return Effect.gen(function* () {
        const views = new Map<string, StepView | undefined>()
        yield* Effect.forEach([...new Set(r.findings.map((f) => f.card))], (c) => Effect.map(deps.step(c, undefined, r.draft).pipe(Effect.orElseSucceed(() => null)), (v) => void views.set(c, v ?? undefined)), { discard: true })
        const filed = r.filed ?? {}
        // Unknown when the backlog does not answer: never guessed to be open.
        const answer = yield* deps.status(Object.values(filed)).pipe(Effect.orElseSucceed(() => undefined))
        const states = new Map((answer ?? []).map((x) => [x.id, x.state === "open" && !x.on ? "off" : x.state]))
        const now = (f: Triaged) => (filed[f.id] === undefined ? "not filed" : answer === undefined ? "unknown" : states.get(filed[f.id]!) ?? "unknown")
        const tables = (fs: ReadonlyArray<Triaged>) => ({
          feedback: { rows: fs.filter((f) => f.kind !== "delight").map((f) => { const row = findingRow(shape(f), views.get(f.card)); return { ...row, cells: { ...row.cells, now: now(f) } } }) },
          likes: { rows: fs.filter((f) => f.kind === "delight").map((f) => findingRow(shape(f), views.get(f.card))) },
          detail: { markdown: "", rows: Object.fromEntries(fs.map((f) => [f.id, findingDetail(shape(f), views.get(f.card))])) },
        })
        for (const [i, p] of r.personas.entries()) {
          const t = tables(r.findings.filter((f) => f.personas.includes(p.name)))
          const id = `tester-${i + 1}`
          yield* quiet(deps.views.set(id, TesterView, "review.feedback", t.feedback))
          yield* quiet(deps.views.set(id, TesterView, "review.likes", t.likes))
          yield* quiet(deps.views.set(id, TesterView, "detail", t.detail))
        }
        // Feedback by journey: how much each journey got, by severity.
        const byJourney = new Map<string, { n: number; high: number; medium: number; low: number }>()
        for (const f of r.findings.filter((x) => x.kind !== "delight")) {
          for (const j of views.get(f.card)?.journeys?.length ? views.get(f.card)!.journeys! : ["—"]) {
            const c = byJourney.get(j) ?? { n: 0, high: 0, medium: 0, low: 0 }
            byJourney.set(j, { ...c, n: c.n + 1, [f.severity]: c[f.severity] + 1 })
          }
        }
        yield* quiet(deps.views.set("run", RunView, "journeys", { rows: [...byJourney.entries()].map(([j, c]) => ({ id: j, cells: { journey: j, feedback: String(c.n), high: String(c.high), medium: String(c.medium), low: String(c.low) } })) }))
        if (r.report !== undefined) yield* quiet(deps.views.set("run", RunView, "report", { markdown: r.report }))
      })
    })

    /** A run's findings for its caller (a re-rehearse over a draft): likes left out; `on` is its own triage's call. */
    const result = (run: string) => {
      const r = records.get(run)
      if (r === undefined) return { status: "unknown" as const, findings: [] }
      return { status: r.status, findings: r.findings.filter((f) => f.kind !== "delight").map((f) => ({ card: f.card, kind: f.kind, severity: f.severity, note: f.notes.join(" / "), on: f.route !== "drop" })) }
    }
    return { start, stop, resume, refresh, result, record: (run: string) => records.get(run) }
  })

export type Rehearse = Effect.Success<ReturnType<typeof makeRehearse>>
