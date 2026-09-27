import { Deferred, Effect, Fiber, Semaphore } from "effect"
import { consolidate, diagnose, report } from "./findings"
import { personasOf, screenStep, stepHash } from "./screen"
import type { RehearseSettings } from "./settings"
import { triage } from "./triage"
import type { Complete, Decide, Kind, Persona, Screened, StepView, Triaged } from "./types"

type RawFinding = { readonly kind: Kind; readonly card: string; readonly edge?: { from: string; to: string }; readonly severity: "high" | "medium" | "low"; readonly note: string; readonly op?: unknown }
export interface RunRecord {
  readonly run: string
  /** When the run started (ms): orders runs, since run ids do not. */
  readonly startedAt: number
  readonly status: "running" | "done" | "stopped"
  readonly strategy: "edge-pair" | "teleport"
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
  /** Findings the developer chose to apply (the driver takes them up). */
  readonly applying: ReadonlyArray<string>
  /** Findings the driver resolved (applied or dismissed there). */
  readonly resolved: ReadonlyArray<string>
}
export interface Started { readonly run: string; readonly stories: number; readonly steps: number; readonly personas: ReadonlyArray<string> }

/** What a body shows: its history (the core fills it), then findings in Feedback and Likes, with actions. */
export type BodyPart =
  | { readonly kind: "history" }
  | {
      readonly kind: "tabs"
      readonly tabs: ReadonlyArray<{ readonly title: string; readonly columns: ReadonlyArray<string>; readonly rows: ReadonlyArray<{ readonly id: string; readonly cells: ReadonlyArray<string> }> }>
      readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string; readonly key: string }>
    }

/** The plugin's powers, as the run uses them (plain functions, so tests can stub them). */
export interface RunDeps {
  readonly stories: (strategy: "edge-pair" | "teleport", focus?: ReadonlyArray<string>) => Effect.Effect<{ readonly stories: ReadonlyArray<ReadonlyArray<string>>; readonly unreachable: number }, unknown>
  readonly step: (card: string, via?: string) => Effect.Effect<StepView | null, unknown>
  readonly decide: Decide
  readonly complete: Complete
  readonly agents: {
    readonly start: (a: { readonly id: string; readonly parent?: string; readonly title: string; readonly task: string }) => Effect.Effect<void, unknown>
    readonly status: (a: { readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }) => Effect.Effect<void, unknown>
    readonly step: (a: { readonly id: string; readonly text: string }) => Effect.Effect<void, unknown>
    readonly end: (a: { readonly id: string; readonly ok: boolean; readonly message?: string }) => Effect.Effect<void, unknown>
  }
  readonly now: Effect.Effect<number, unknown>
  readonly uuid: Effect.Effect<string, unknown>
  readonly read: (path: string) => Effect.Effect<string, unknown>
  readonly write: (path: string, text: string) => Effect.Effect<void, unknown>
  readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly agendaChanged: Effect.Effect<void, unknown>
  readonly settings: RehearseSettings
}

const DIR = ".zarg/rehearse"
const INDEX = `${DIR}/index.json`
const DISMISSED = `${DIR}/dismissed.json`
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
    let dismissed = yield* json<Record<string, string>>(DISMISSED, {})
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
            if (!views.has(key)) views.set(key, (yield* deps.step(card, via).pipe(Effect.orElseSucceed(() => null))) ?? undefined)
            return views.get(key)
          })
        yield* quiet(deps.agents.start({ id: "run", title: "rehearse", task: `run ${rec.run}: ${plural(rec.stories.length, "story")} × ${plural(rec.personas.length, "tester")}` }))
        const sem = yield* Semaphore.make(deps.settings.inFlight)
        // Stories share prefixes and run at once: the first fiber at a prefix screens it, the others wait for it.
        const inFlight = new Map<string, Deferred.Deferred<void>>()
        // Progress per tester: distinct steps (story prefixes) checked out of those to check, so it only goes up.
        const toCheck = new Set(rec.stories.flatMap((s) => s.map((_, i) => s.slice(0, i + 1).join(">")))).size
        const all = toCheck * rec.personas.length
        let allChecked = 0
        yield* Effect.forEach(
          rec.personas,
          (persona, pi) =>
            Effect.gen(function* () {
              const id = `tester-${pi + 1}`
              const checked = new Set<string>()
              let flagged = 0
              const progress = (key: string, flags: number) =>
                Effect.gen(function* () {
                  if (checked.has(key)) return
                  checked.add(key)
                  flagged += flags > 0 ? 1 : 0
                  allChecked++
                  yield* quiet(deps.agents.status({ id, progress: { done: checked.size, total: toCheck }, text: `${checked.size}/${toCheck} steps · ${flagged} flagged` }))
                  yield* quiet(deps.agents.status({ id: "run", progress: { done: allChecked, total: all }, text: `${allChecked}/${all} steps` }))
                })
              yield* quiet(deps.agents.start({ id, parent: "run", title: "tester", task: persona.text }))
              yield* Effect.forEach(
                rec.stories,
                (story) =>
                  Effect.gen(function* () {
                    const prior: Array<StepView> = []
                    for (let i = 0; i < story.length; i++) {
                      const key = `${persona.name}|${story.slice(0, i + 1).join(">")}`
                      const step = yield* viewOf(story[i]!, story[i - 1])
                      if (step === undefined) break
                      const waiting = inFlight.get(key)
                      if (waiting !== undefined) {
                        yield* Deferred.await(waiting)
                        yield* progress(key, rec.screened[key]?.flags.length ?? 0)
                      } else if (key in rec.screened) yield* progress(key, rec.screened[key]?.flags.length ?? 0)
                      else {
                        const done = yield* Deferred.make<void>()
                        inFlight.set(key, done)
                        const screened = yield* Semaphore.withPermits(sem, 1)(screenStep(deps.decide, persona, prior, step, deps.settings))
                        const d = screened !== undefined && screened.flags.length > 0 ? yield* Semaphore.withPermits(sem, 1)(diagnose(deps.complete, persona, prior, step, screened.flags)) : undefined
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
                        yield* quiet(deps.agents.step({ id, text: `${step.card}: ${said}` }))
                        yield* progress(key, screened?.flags.length ?? 0)
                        yield* Deferred.succeed(done, undefined)
                      }
                      prior.push(step)
                    }
                  }),
                { concurrency: "unbounded" },
              )
              yield* quiet(deps.agents.end({ id, ok: true }))
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
        yield* update((r) => ({ ...r, status: "done", findings, report: text }))
        const open = findings.filter((f) => f.route !== "drop" && f.kind !== "delight" && !isDismissed(f)).length
        const unreached = rec.unreachable > 0 ? ` · ${rec.unreachable} unreachable` : ""
        yield* quiet(deps.agents.status({ id: "run", progress: { done: all, total: all }, text: `${plural(open, "finding")} ${deps.settings.autoApply ? "to apply" : "to review"}${unreached}` }))
        yield* quiet(deps.agents.step({ id: "run", text }))
        yield* quiet(deps.agents.end({ id: "run", ok: true }))
        // Only auto_apply hands findings to the driver on its own; otherwise the developer picks them.
        if (deps.settings.autoApply && findings.some((f) => f.route === "fix")) yield* quiet(deps.agendaChanged)
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

    const start = (opts: { readonly strategy?: "edge-pair" | "teleport"; readonly focus?: ReadonlyArray<string>; readonly personas?: ReadonlyArray<string> }) =>
      Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          if (active !== undefined) return { refused: `run ${active.run} is still going` }
          const strategy = opts.strategy ?? "edge-pair"
          // No focus, or an empty one, is every story.
          const focus = opts.focus !== undefined && opts.focus.length > 0 ? opts.focus : undefined
          const planned = yield* deps.stories(strategy, focus).pipe(Effect.orElseSucceed(() => ({ stories: [], unreachable: 0 })))
          const names = yield* deps.list("intent").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          const texts = yield* Effect.forEach(names.filter((n) => n.endsWith(".md")), (n) => deps.read(`intent/${n}`).pipe(Effect.orElseSucceed(() => "")))
          const all = yield* personasOf(texts.join("\n\n"), deps.decide)
          const personas = opts.personas !== undefined ? all.filter((p) => opts.personas!.includes(p.name)) : all
          if (personas.length === 0) return { refused: 'no testers: the intent lists no affected users (a person under "Affected users"), or the decision model could not tell' }
          const startedAt = yield* deps.now.pipe(Effect.orElseSucceed(() => 0))
          const run = `r-${(yield* deps.uuid.pipe(Effect.orElseSucceed(() => String(startedAt)))).slice(0, 8)}`
          const rec: RunRecord = { run, startedAt, status: "running", strategy, focus: focus ?? [], personas, stories: planned.stories, unreachable: planned.unreachable, screened: {}, raw: [], infra: [], findings: [], applying: [], resolved: [] }
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
      }
    })
    /** A run a restart cut short continues where it was. */
    const resume = Effect.suspend(() => {
      const left = [...records.values()].find((r) => r.status === "running")
      return left === undefined || active !== undefined ? Effect.void : launch(left)
    })

    const isDismissed = (f: Triaged) => dismissed[f.id] !== undefined && dismissed[f.id] === (f.hash ?? "")
    /** The newest finished run: the one the tables show. */
    const latest = () => [...records.values()].filter((r) => r.status === "done").sort((a, b) => b.startedAt - a.startedAt)[0]
    /** Findings the driver takes up: the ones the developer applied, and with auto_apply the local fixes. */
    const chosen = (r: RunRecord, f: Triaged) => r.applying.includes(f.id) || (deps.settings.autoApply && f.route === "fix")
    const openFindings = (r: RunRecord) => r.findings.filter((f) => chosen(r, f) && !r.resolved.includes(f.id) && !isDismissed(f))

    const agenda = () =>
      [...records.values()]
        .filter((r) => r.status === "done")
        .map((r) => ({ r, open: openFindings(r) }))
        .filter(({ open }) => open.length > 0)
        .map(({ r, open }) => ({
          id: `rehearse:${r.run}`,
          title: `Rehearse run ${r.run}: ${plural(open.length, "finding")} ${deps.settings.autoApply ? "to apply" : "the developer chose to apply"}`,
          detail: [
            r.report ?? "",
            ...open.map((f) => `- ${f.id} ${f.kind} (${f.severity}) on ${f.card}: ${f.notes.join(" / ")}`),
            `For each: yield* Findings.take({ plugin: "rehearse", finding }), then change the Gherkin graph to resolve it (split an oversize card, never grow it); no question needed, the developer chose these. Finish with yield* Findings.resolve({ plugin: "rehearse", run: "${r.run}", applied, dismissed }).`,
          ].join("\n"),
          about: [...new Set(open.map((f) => f.card))],
          priority: 1,
        }))

    const rowsOf = (fs: ReadonlyArray<Triaged>) =>
      fs.map((f) => ({ id: f.id, cells: [f.id, f.kind, f.card, f.severity, `${f.route} ${f.real.toFixed(2)}`, `${chosen(latest()!, f) ? "✓ " : ""}${f.notes.join(" / ")}`] }))
    /** The run's (or one tester's) body: its history, then its findings in Feedback and Likes. */
    const body = (agent: string): { parts: ReadonlyArray<BodyPart> } | null => {
      const r = latest()
      const tester = /^tester-(\d+)$/.exec(agent)
      if (agent !== "run" && tester === null) return null
      const persona = tester !== null && r !== undefined ? r.personas[Number(tester[1]) - 1]?.name : undefined
      const shown = (r?.findings ?? []).filter((f) => !isDismissed(f) && !(r?.resolved ?? []).includes(f.id) && (persona === undefined || f.personas.includes(persona)))
      const columns = ["id", "kind", "card", "severity", "suggested", "note"]
      return {
        parts: [
          { kind: "history" },
          {
            kind: "tabs",
            tabs: [
              { title: "Feedback", columns, rows: rowsOf(shown.filter((f) => f.kind !== "delight")) },
              { title: "Likes", columns, rows: rowsOf(shown.filter((f) => f.kind === "delight")) },
            ],
            actions: [
              { id: "apply", label: "Apply", key: "a" },
              { id: "dismiss", label: "Dismiss", key: "d" },
            ],
          },
        ],
      }
    }
    /** An action on selected rows: apply (to the driver) or dismiss. */
    const act = (action: string, ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const r = latest()
        if (r === undefined) return { notice: "no finished rehearse run" }
        if (action === "apply") {
          yield* save({ ...r, applying: [...new Set([...r.applying, ...ids])] })
          yield* quiet(deps.agendaChanged)
          return { notice: `${plural(ids.length, "finding")} sent to the driver` }
        }
        if (action === "dismiss") {
          for (const id of ids) {
            const f = r.findings.find((x) => x.id === id)
            if (f !== undefined) dismissed = { ...dismissed, [id]: f.hash ?? "" }
          }
          yield* quiet(deps.write(DISMISSED, JSON.stringify(dismissed, null, 2)))
          return { notice: `${ids.length} dismissed` }
        }
        return { notice: `unknown action ${action}` }
      })

    /** For the core's findings gate: which run and card, whether the developer chose it, whether its card changed. */
    const finding = (id: string) =>
      Effect.gen(function* () {
        const hits = [...records.values()]
          .filter((r) => r.status === "done")
          .sort((a, b) => b.startedAt - a.startedAt)
          .flatMap((r) => r.findings.map((f) => ({ r, f })))
          .filter((x) => x.f.id === id)
        // A later run can report a finding again, unchosen: the developer's open choice wins.
        const hit = hits.find((x) => chosen(x.r, x.f) && !x.r.resolved.includes(id)) ?? hits[0]
        if (hit === undefined) return null
        const now = yield* deps.step(hit.f.card).pipe(Effect.orElseSucceed(() => null))
        const stale = now === null || (hit.f.hash !== undefined && stepHash(now) !== hit.f.hash)
        return { run: hit.r.run, card: hit.f.card, chosen: chosen(hit.r, hit.f), stale, notes: [...hit.f.notes] }
      })
    const resolved = (run: string, ids: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        const r = records.get(run)
        return r === undefined ? Effect.void : save({ ...r, resolved: [...new Set([...r.resolved, ...ids])] })
      })

    return { start, stop, resume, agenda, body, act, finding, resolved, record: (run: string) => records.get(run) }
  })

export type Rehearse = Effect.Success<ReturnType<typeof makeRehearse>>
