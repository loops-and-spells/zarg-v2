import { join } from "node:path"
import { Cause, Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import { baseTree, engineLayer, gcPasses, makeFindings, Pass, type PassResult, passLayer, snapshotAtTree, startReconciler, workingGraphTree } from "@zarg/reconcile"
import { makeActivity } from "./activity"
import { threadViews } from "./views"
import * as E from "./events"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import { type PhaseDeps, type ReconcileSettings, reconcileSpec } from "./phases"
import type { Thread } from "./thread"

export interface ReconcileDeps {
  readonly repo: string
  readonly settings: ReconcileSettings
  readonly log: ThreadLog
  readonly sensitive: PhaseDeps["sensitive"]
  readonly makeRlm: PhaseDeps["makeRlm"]
  readonly extra?: PhaseDeps["extra"]
  readonly withGraphLock?: PhaseDeps["withGraphLock"]
  readonly pluginHost: PhaseDeps["pluginHost"]
  readonly affected: PhaseDeps["affected"]
  /** The workflow store. Under `.zarg/reconcile/`, which keeps itself out of git. */
  readonly dbFile?: string
}

const summary = (r: PassResult) => {
  if (r.status === "nothing") return undefined
  const failed = r.failed.length > 0 ? ` ${r.failed.join(", ")} need your attention (see the driver's agenda).` : ""
  return r.status === "landed" ? `Landed ${r.landed.join(", ")} in ${r.commit?.slice(0, 7)}.${failed}` : `Nothing landed.${failed}`
}

/**
 * Plan and implement for the core: the reconciler watching the graph, passes on a durable engine, the
 * `plan` and `implement` threads showing each pass, and findings as agenda items for the driver.
 */
export const makeReconcile = (deps: ReconcileDeps) =>
  Effect.gen(function* () {
    const findings = makeFindings(deps.repo)
    const activity = { plan: makeActivity(deps.log, "plan", undefined, threadViews(deps.log, "plan")), implement: makeActivity(deps.log, "implement", undefined, threadViews(deps.log, "implement")) }
    const emit = (thread: string, d: E.Draft) => Effect.runSync(deps.log.append(thread, d))
    let active: { readonly payload: typeof Pass.payloadSchema.Type; readonly runId: string } | undefined
    // Stop: a flag the pass checks between steps, and a signal running cards race (reset for each pass).
    let stopRequested = false
    let release = () => {}
    let signal = new Promise<void>(() => {})
    const armStop = () => {
      stopRequested = false
      signal = new Promise<void>((resolve) => (release = resolve))
    }

    const spec = reconcileSpec({
      repo: deps.repo,
      settings: deps.settings,
      sensitive: deps.sensitive,
      findings,
      makeRlm: deps.makeRlm,
      pluginHost: deps.pluginHost,
      affected: deps.affected,
      ...(deps.extra ? { extra: deps.extra } : {}),
      ...(deps.withGraphLock ? { withGraphLock: deps.withGraphLock } : {}),
      observe: (phase, item, e) => (phase === "plan" ? activity.plan : activity.implement).observe(e, `${item}:`),
      stop: { requested: () => stopRequested, wait: Effect.suspend(() => Effect.promise(() => signal)) },
    })
    const engine = passLayer(spec).pipe(Layer.provideMerge(engineLayer(deps.dbFile ?? join(deps.repo, ".zarg", "reconcile", "cluster.db"))))
    const runtime = ManagedRuntime.make(engine as Layer.Layer<Layer.Success<typeof engine>, Layer.Error<typeof engine>, never>)
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))

    // Each pass is one run on both threads: started, the RLM tree per card, a summary, finished.
    const execute = (payload: typeof Pass.payloadSchema.Type) =>
      Effect.gen(function* () {
        const runId = `pass-${crypto.randomUUID().slice(0, 8)}`
        active = { payload, runId }
        armStop()
        // Failed passes keep their worktrees for inspection; only the newest few.
        yield* gcPasses(deps.repo, 3, (pass, name) => `zarg/${pass}/${name}`).pipe(Effect.ignore)
        for (const t of ["plan", "implement"] as const) {
          emit(t, E.runStarted(t, runId))
          emit(t, activity[t].reset())
        }
        return yield* Effect.tryPromise(() => runtime.runPromise(Pass.execute(payload))).pipe(
          // Shutting down: the durable pass is not failed, only interrupted; it resumes on the next start.
          Effect.catch((e) => (closing ? Effect.interrupt : Effect.fail(e))),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              active = undefined
              const text =
                exit._tag === "Success"
                  ? exit.value.status === "failed" && stopRequested
                    ? "The pass stopped."
                    : summary(exit.value)
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "The pass was interrupted; zarg resumes it on its next start."
                    : "The pass failed; see the driver's agenda."
              if (text !== undefined) for (const d of E.textMessage(`implement-${crypto.randomUUID()}`, "assistant", text)) emit("implement", d)
              for (const t of ["plan", "implement"] as const) emit(t, E.runFinished(t, runId))
            }),
          ),
        )
      })

    let closing = false
    const reconciler = startReconciler({ repo: deps.repo, quietMs: deps.settings.quietMs, findings, execute })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true
        reconciler.close()
      }),
    )
    // A pass interrupted by the last shutdown (or changes made while zarg was off) are picked up now.
    reconciler.notify()

    /** Stop the running pass: its cards are cut short, nothing lands, its worktrees stay; the next graph change starts a new pass. */
    const stop = Effect.sync(() => {
      if (active === undefined) return
      stopRequested = true
      release()
    })

    // The reconcile threads only show passes; posting a run to them starts nothing.
    const view = (id: "plan" | "implement"): Thread => ({
      id,
      focus: [],
      run: () => Stream.empty as Stream.Stream<WireEvent>,
      wake: Effect.void,
      stop,
      // Read-only views: questions go to the main thread.
      ask: () => Effect.die(new Error(`the ${id} thread is read-only; ask on main`)),
      status: () => (active !== undefined ? "running" : "idle"),
    })

    /** Findings about the thread's focus (or all, without one), first on the driver's agenda. */
    const agenda = (focus: ReadonlySet<string> | undefined): ReadonlyArray<AgendaItem> =>
      findings
        .list()
        .filter((f) => focus === undefined || f.about.length === 0 || f.about.some((c) => focus.has(c)))
        .map((f) => ({ id: f.id, title: f.title, detail: `${f.kind}: ${f.detail}`, about: f.about, priority: 0 }))

    /** Cards the next pass would take up (the working graph against the last checkpoint). */
    const pending = Effect.gen(function* () {
      const [before, after] = yield* Effect.all([
        Effect.flatMap(baseTree(deps.repo), (t) => snapshotAtTree(deps.repo, t)),
        Effect.flatMap(workingGraphTree(deps.repo), (t) => snapshotAtTree(deps.repo, t)),
      ])
      const a = yield* deps.affected(before, after)
      return a.cards.length + a.removed.length
    }).pipe(Effect.orElseSucceed(() => 0))

    return { threads: [view("plan"), view("implement")], agenda, notify: reconciler.notify, findings, pending }
  })
