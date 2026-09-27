// packages/core/src/rehearse/run.ts
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Semaphore, Stream } from "effect"
import type { Model } from "@zarg/model"
import type { AgendaItem } from "@zarg/plugin/server"
import { makeActivity } from "../activity"
import * as E from "../events"
import { redactValues, type ThreadLog } from "../log"
import type { Thread } from "../thread"
import type { WireEvent } from "../events"
import { consolidate, diagnose, report } from "./findings"
import { personasOf, screenStep, stepHash } from "./screen"
import type { RehearseSettings } from "./settings"
import { triage } from "./triage"
import type { Decide, Kind, Persona, Screened, StepView, Triaged } from "./types"

type RawFinding = { readonly kind: Kind; readonly card: string; readonly edge?: { from: string; to: string }; readonly severity: "high" | "medium" | "low"; readonly note: string; readonly op?: unknown }
export interface RunRecord {
  readonly run: string
  /** When the run started (ISO): orders runs, since run ids do not. */
  readonly startedAt: string
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
  readonly triaged: boolean
  readonly resolved: ReadonlyArray<string>
  /** Graph nodes the driver's fixes for this run touched, across driver items, until its triage commit. */
  readonly touched: ReadonlyArray<string>
}
export interface Started { readonly run: string; readonly stories: number; readonly steps: number; readonly personas: ReadonlyArray<string> }
export interface RehearseDeps {
  readonly dir: string
  readonly log: ThreadLog
  readonly stories: (strategy: "edge-pair" | "teleport", focus?: ReadonlySet<string>) => Effect.Effect<{ readonly stories: ReadonlyArray<ReadonlyArray<string>>; readonly unreachable: number }, unknown>
  readonly step: (card: string, via?: string) => Effect.Effect<Record<string, unknown> | undefined, unknown>
  readonly decide: Decide
  readonly model: Model.Model["Service"]
  readonly settings: RehearseSettings
  /** The intent's text (every `intent/*.md`), for personas. */
  readonly intent: () => string
  /** True when the card has code (an `@card` tag): changing it is the developer's call. */
  readonly built: (card: string) => Effect.Effect<boolean>
  /** A line for the developer on the main thread. */
  readonly announce: (text: string) => Effect.Effect<void>
  /** Wake the main thread's driver so it takes up the findings. */
  readonly wake: Effect.Effect<void>
}

const THREAD = "rehearse"

/** Rehearse runs: one at a time, in the background, recorded step by step so a restart resumes them. */
export const makeRehearse = (deps: RehearseDeps) =>
  Effect.gen(function* () {
    mkdirSync(deps.dir, { recursive: true })
    const activity = makeActivity(deps.log, THREAD)
    const lock = yield* Semaphore.make(1)
    const records = new Map<string, RunRecord>()
    for (const f of readdirSync(deps.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const r = JSON.parse(readFileSync(join(deps.dir, f), "utf8")) as RunRecord
        records.set(r.run, r)
      } catch {}
    }
    const save = (r: RunRecord) => {
      records.set(r.run, r)
      const file = join(deps.dir, `${r.run}.json`)
      // Value by value, like transcripts: a secret with a quote in it is matched as it is, not as escaped JSON.
      writeFileSync(`${file}.tmp`, JSON.stringify(redactValues(r, deps.log.redact), null, 2))
      renameSync(`${file}.tmp`, file)
    }
    let active: { run: string; fiber: Fiber.Fiber<void, unknown> } | undefined
    const emit = (d: E.Draft) => deps.log.append(THREAD, d)

    const walk = (start: RunRecord) =>
      Effect.gen(function* () {
        let rec = start
        const update = (f: (r: RunRecord) => RunRecord) => Effect.sync(() => save((rec = f(rec))))
        const views = new Map<string, StepView | undefined>()
        const viewOf = (card: string, via?: string) =>
          Effect.gen(function* () {
            const key = `${via ?? ""}>${card}`
            if (!views.has(key)) views.set(key, (yield* deps.step(card, via).pipe(Effect.orElseSucceed(() => undefined))) as StepView | undefined)
            return views.get(key)
          })
        yield* emit(E.runStarted(THREAD, rec.run))
        yield* emit(activity.reset())
        activity.observe({ type: "start", id: "rehearse", parent: undefined, preset: "rehearse", task: `run ${rec.run}: ${rec.stories.length} stories × ${rec.personas.length} testers`, scope: {}, depth: 0, budget: { turns: rec.stories.length, tokens: 0, wallMs: 0 } })
        // Screen: every persona walks every story; a prefix already screened (shared, or before a restart) is not asked again.
        const sem = yield* Semaphore.make(deps.settings.inFlight)
        // Stories share prefixes and run at once: the first fiber at a prefix screens it, the others wait for it.
        const inFlight = new Map<string, Deferred.Deferred<void>>()
        yield* Effect.forEach(rec.personas, (persona, pi) =>
          Effect.gen(function* () {
            const id = `tester-${pi + 1}`
            activity.observe({ type: "start", id, parent: "rehearse", preset: "tester", task: persona.text, scope: {}, depth: 1, budget: { turns: rec.stories.length, tokens: 0, wallMs: 0 } })
            yield* Effect.forEach(rec.stories, (story, si) =>
              Effect.gen(function* () {
                const prior: Array<StepView> = []
                for (let i = 0; i < story.length; i++) {
                  const key = `${persona.name}|${story.slice(0, i + 1).join(">")}`
                  const step = yield* viewOf(story[i]!, story[i - 1])
                  if (step === undefined) break
                  const waiting = inFlight.get(key)
                  if (waiting !== undefined) yield* Deferred.await(waiting)
                  else if (!(key in rec.screened)) {
                    const done = yield* Deferred.make<void>()
                    inFlight.set(key, done)
                    const screened = yield* Semaphore.withPermits(sem, 1)(screenStep(deps.decide, persona, prior, step, deps.settings))
                    const d =
                      screened !== undefined && screened.flags.length > 0
                        ? yield* Semaphore.withPermits(sem, 1)(diagnose(deps.model, deps.settings.role, persona, prior, step, screened.flags))
                        : undefined
                    // One write, after the diagnosis: a restart before it screens and diagnoses the step again.
                    yield* update((r) => ({
                      ...r,
                      screened: { ...r.screened, [key]: screened ?? null },
                      ...(d === undefined ? {} : "infra" in d ? { infra: [...r.infra, d.infra] } : { raw: [...r.raw, ...d.findings.map((f) => ({ persona: persona.name, ...f }))] }),
                    }))
                    yield* Deferred.succeed(done, undefined)
                  }
                  prior.push(step)
                }
                activity.observe({ type: "turn", id, turn: si + 1, tokens: 0 })
              }),
            { concurrency: "unbounded" })
            activity.observe({ type: "end", id, ok: true, turns: rec.stories.length, tokens: 0 })
          }),
        { concurrency: "unbounded" })
        // Consolidate, triage and report.
        const found = consolidate(rec.raw)
        const findings = yield* Effect.forEach(found, (f) =>
          Effect.gen(function* () {
            const step = yield* viewOf(f.card)
            const t = yield* triage(deps.decide, f, step, yield* deps.built(f.card), deps.settings)
            return step === undefined ? t : { ...t, hash: stepHash(step) }
          }),
        { concurrency: deps.settings.inFlight })
        const screenedValues = Object.values(rec.screened)
        const text = yield* report(deps.model, deps.settings.role, found, {
          steps: screenedValues.length,
          flagged: screenedValues.filter((s) => s !== null && s.flags.length > 0).length,
          unscreened: screenedValues.filter((s) => s === null).length,
        })
        yield* update((r) => ({ ...r, status: "done", findings, report: text }))
        activity.observe({ type: "end", id: "rehearse", ok: true, turns: rec.stories.length, tokens: 0 })
        for (const d of E.textMessage(`${THREAD}-${crypto.randomUUID()}`, "assistant", text)) yield* emit(d)
        yield* emit(E.runFinished(THREAD, rec.run))
        const open = findings.filter((f) => f.route !== "drop").length
        yield* deps.announce(
          `Rehearse run ${rec.run} finished: ${open} finding${open === 1 ? "" : "s"} for triage, ${screenedValues.filter((s) => s === null).length} steps unscreened` +
            (rec.unreachable > 0 ? `, ${rec.unreachable} cards or steps no journey reaches (no entry state leads there).` : "."),
        )
        if (open > 0) yield* deps.wake
      })

    const launch = (rec: RunRecord) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkDetach(walk(rec).pipe(Effect.ensuring(Effect.sync(() => { if (active?.run === rec.run) active = undefined }))))
        active = { run: rec.run, fiber }
      })

    const start = (opts: { strategy?: "edge-pair" | "teleport"; focus?: ReadonlyArray<string>; personas?: ReadonlyArray<string> }) =>
      Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          if (active !== undefined) return { refused: `run ${active.run} is still going` }
          const strategy = opts.strategy ?? "edge-pair"
          // No focus, or an empty one, is every story.
          const focus = opts.focus !== undefined && opts.focus.length > 0 ? new Set(opts.focus) : undefined
          const planned = yield* deps.stories(strategy, focus).pipe(Effect.orElseSucceed(() => ({ stories: [], unreachable: 0 })))
          const all = yield* personasOf(deps.intent(), deps.decide)
          const personas = opts.personas !== undefined ? all.filter((p) => opts.personas!.includes(p.name)) : all
          if (personas.length === 0) {
            return { refused: "no testers: the intent lists no affected users (a person under \"Affected users\"), or the decision model could not tell" }
          }
          const run = `r-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`
          const rec: RunRecord = { run, startedAt: new Date().toISOString(), touched: [], status: "running", strategy, focus: opts.focus ?? [], personas, stories: planned.stories, unreachable: planned.unreachable, screened: {}, raw: [], infra: [], findings: [], triaged: false, resolved: [] }
          save(rec)
          yield* launch(rec)
          return { run, stories: planned.stories.length, steps: planned.stories.reduce((n, s) => n + s.length, 0), personas: personas.map((p) => p.name) } satisfies Started
        }),
      )

    /** Stop the running run: its record so far is kept, marked stopped (even when it was stopped before its first step). */
    const stop = Effect.gen(function* () {
      if (active === undefined) return
      const { run, fiber } = active
      yield* Fiber.interrupt(fiber)
      const r = records.get(run)
      if (r?.status === "running") {
        save({ ...r, status: "stopped" })
        yield* emit(E.runFinished(THREAD, run))
      }
    })
    /** A run a restart cut short continues where it was. */
    const resume = Effect.suspend(() => {
      const left = [...records.values()].find((r) => r.status === "running")
      return left === undefined || active !== undefined ? Effect.void : launch(left)
    })

    const agenda = (focus?: ReadonlySet<string>): ReadonlyArray<AgendaItem> =>
      [...records.values()]
        .filter((r) => r.status === "done" && !r.triaged)
        .map((r) => ({ r, open: r.findings.filter((f) => f.route !== "drop" && !r.resolved.includes(f.id)) }))
        .filter(({ open }) => open.length > 0 && (focus === undefined || open.some((f) => focus.has(f.card))))
        .map(({ r, open }) => ({
          id: `rehearse:${r.run}`,
          title: `Rehearse run ${r.run}: ${open.length} finding${open.length === 1 ? "" : "s"}`,
          detail: [
            r.report ?? "",
            ...open.map((f) => `- ${f.id} [${f.route}] ${f.kind} (${f.severity}) on ${f.card}: ${f.notes.join(" / ")}`),
            "For each [fix]: yield* Rehearse.fix({ finding }), then change the Gherkin graph to resolve it (split an oversize card, never grow it). For each [ask]: Inquire.confirm the change with the finding as the reason. Finish with yield* Rehearse.resolve({ run, applied, dismissed }).",
          ].join("\n"),
          about: [...new Set(open.map((f) => f.card))],
          priority: 0,
        }))

    const markResolved = (run: string, ids: ReadonlyArray<string>, triaged: boolean) => {
      const r = records.get(run)
      if (r !== undefined) save({ ...r, resolved: [...new Set([...r.resolved, ...ids])], triaged: r.triaged || triaged })
    }

    const thread: Thread = {
      id: THREAD,
      focus: [],
      run: () => Stream.empty as Stream.Stream<WireEvent>,
      wake: Effect.void,
      stop,
      ask: () => Effect.die(new Error("the rehearse thread is read-only; ask on main")),
      status: () => (active !== undefined ? "running" : "idle"),
    }
    /** A finding by id, with its run (ids are stable across runs; the newest run's copy wins). */
    const findingOf = (id: string) =>
      [...records.values()]
        .filter((r) => r.status === "done" && !r.triaged)
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
        .flatMap((r) => r.findings.map((f) => ({ run: r.run, f })))
        .find((x) => x.f.id === id)
    /** Nodes a fix for this run touched: kept on the run, so a triage spread over driver items commits them all. */
    const markTouched = (run: string, ids: ReadonlyArray<string>) => {
      const r = records.get(run)
      if (r !== undefined && ids.some((id) => !(r.touched ?? []).includes(id))) save({ ...r, touched: [...new Set([...(r.touched ?? []), ...ids])] })
    }
    return { start, stop, resume, agenda, record: (run: string) => records.get(run), findingOf, markTouched, markResolved, thread }
  })

export type Rehearse = Effect.Success<ReturnType<typeof makeRehearse>>
