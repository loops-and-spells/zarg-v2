import { join } from "node:path"
import { Cause, Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import { baseTree, engineLayer, gcPasses, makeFindings, Pass, type PassResult, passLayer, pendingAt, snapshotAtTree, startReconciler, workingGraphTree } from "@zarg/reconcile"
import type { Layout } from "@zarg/view"
import { makeActivity } from "./activity"
import { threadViews } from "./views"
import * as E from "./events"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import { type PhaseDeps, type ReconcileSettings, reconcileSpec } from "./phases"
import type { Thread } from "@zarg/agent-host"

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
  /** A pass landed these scenarios (the Planner moves their plans to Review). */
  readonly onLanded?: (scenarios: ReadonlyArray<string>) => void
  /** A pass failed on these scenarios (their plans go back to Ready, for the operator). */
  readonly onFailed?: (scenarios: ReadonlyArray<string>) => void
  /** A pass's outcome is known (landed, failed, skipped, errored): the findings may have changed. */
  readonly onPassEnd?: () => void
  /** The findings changed (raised or cleared), in a pass the reconciler started or one resumed after a restart. */
  readonly onFindings?: () => void
  /** Landing waits on the operator's uncommitted edits: what to tell them (the implement thread says it too). */
  readonly onLandWait?: (text: string) => void
}

/** What a pass says when it ends: what landed (or that nothing was built, its plans committed) and what needs the operator. */
export const passSummary = (r: PassResult) => {
  if (r.status === "nothing") return undefined
  const failed = r.failed.length > 0 ? ` ${r.failed.join(", ")} need your attention (see the driver's agenda).` : ""
  if (r.status === "landed" && r.landed.length === 0) return `Nothing built:${failed} ${r.failed.length === 1 ? "Its plan is" : "Their plans are"} in ${r.commit?.slice(0, 7)}.`
  return r.status === "landed" ? `Landed ${r.landed.join(", ")} in ${r.commit?.slice(0, 7)}.${failed}` : `Nothing landed.${failed}`
}
const summary = passSummary

/** The build row's view: what the pass does now, and what it did. */
const BUILD_LAYOUT: Layout = {
  name: "build",
  sections: [
    { id: "now", kind: "text", role: "primary", title: "Now" },
    { id: "history", kind: "log", role: "log", title: "History" },
  ],
}

/** Said with a verify-failing finding: a driver once proposed pointing tests elsewhere because the database was down. */
export const VERIFY_ENV =
  "When it fails for the environment, not the code (a database or service not running, connection refused, a missing variable), it is no requirement: write nothing to the graph and ask nothing. Say in your reply what the operator should start or set, and finish (starting it is theirs; the next pass verifies again). Never change code, tests or fixtures to get around it."

/**
 * Plan and implement for the core: the reconciler watching the graph, passes on a durable engine, the
 * `plan` and `implement` threads showing each pass, and findings as agenda items for the driver.
 */
export const makeReconcile = (deps: ReconcileDeps) =>
  Effect.gen(function* () {
    const findings = makeFindings(deps.repo, () => deps.onFindings?.())
    const activity = { plan: makeActivity(deps.log, "plan", undefined, threadViews(deps.log, "plan")), implement: makeActivity(deps.log, "implement", undefined, threadViews(deps.log, "implement")) }
    const emit = (thread: string, d: E.Draft) => Effect.runSync(deps.log.append(thread, d))
    // @scenario S-0122
    // The pass among the operator's agents (zarg's main thread): one build row, naming what it plans or implements now.
    const board = makeActivity(deps.log, "main", "main-build")
    const working = new Map<string, string>()
    const tops = new Map<string, string>()
    // Its progress: scenarios implemented out of those the pass works on (a kept plan starts no plan agent).
    const planned = new Set<string>()
    const built = new Set<string>()
    // Opened, the build row shows what the pass does now and what it did (it opened to "no view yet").
    const views = threadViews(deps.log, "main")
    let said = ""
    const build = (status: string, text: string) => {
      if (!views.has("build")) views.start("build", BUILD_LAYOUT)
      views.set("build", "now", { markdown: `**${status}** · ${text}` })
      if (text !== said) views.append("build", "history", [{ text: `${new Date().toISOString().slice(11, 19)}  ${text}`, ...(status === "failed" ? { tone: "error" as const } : {}) }])
      said = text
      board.row("build", { id: "build", parent: null, preset: "build", task: "the reconcile pass", depth: 0, turns: built.size, budget: planned.size, status, decisions: [], row: { progress: { done: built.size, total: Math.max(planned.size, built.size) }, text } })
    }
    const doing = () => [...working].map(([item, phase]) => `${phase} ${item}`).join(" · ") || (planned.size > 0 ? "merging and verifying" : "starting")
    let active: { readonly payload: typeof Pass.payloadSchema.Type; readonly runId: string } | undefined
    // Stop: a flag the pass checks between steps, and a signal running scenarios race (reset for each pass).
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
      observe: (phase, item, e) => {
        (phase === "plan" ? activity.plan : activity.implement).observe(e, `${item}:`)
        // A scenario's own RLM (not its children) starting or ending moves the build row.
        const key = `${phase} ${item}`
        if (e.type === "start" && e.parent === undefined) {
          tops.set(key, e.id)
          working.set(item, phase)
          planned.add(item)
        } else if (e.type === "end" && tops.get(key) === e.id) {
          tops.delete(key)
          if (working.get(item) === phase) working.delete(item)
          if (phase === "implement" && e.ok && planned.has(item)) built.add(item)
        } else return
        build("running", doing())
      },
      stop: { requested: () => stopRequested, wait: Effect.suspend(() => Effect.promise(() => signal)) },
      // @scenario S-0050
      onLandWait: (paths, attempt) =>
        Effect.sync(() => {
          const text = `Landing waits on your uncommitted edits in ${paths.join(", ")}: commit or stash them (try ${attempt} of ${deps.settings.landAttempts}, again in ${Math.max(1, Math.round(deps.settings.landRetryMs / 1000))}s).`
          for (const d of E.textMessage(`implement-${crypto.randomUUID()}`, "assistant", text)) emit("implement", d)
          deps.onLandWait?.(text)
        }),
    })
    const engine = passLayer(spec).pipe(Layer.provideMerge(engineLayer(deps.dbFile ?? join(deps.repo, ".zarg", "reconcile", "cluster.db"))))
    const runtime = ManagedRuntime.make(engine as Layer.Layer<Layer.Success<typeof engine>, Layer.Error<typeof engine>, never>)
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))

    // Each pass is one run on both threads: started, the RLM tree per scenario, a summary, finished.
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
        working.clear()
        tops.clear()
        planned.clear()
        built.clear()
        build("running", "starting")
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
              // The build row says how the pass ended: what landed, or that it did not.
              const landed = exit._tag === "Success" ? exit.value.landed : []
              const failed = exit._tag === "Success" ? exit.value.failed : []
              // A pass that only committed plans built nothing: that is no ✓.
              const end = exit._tag === "Failure" ? (Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed") : exit.value.status === "failed" || (landed.length === 0 && failed.length > 0) ? "failed" : "done"
              build(end, landed.length > 0 ? `landed ${landed.join(", ")}` : failed.length > 0 ? `not built: ${failed.join(", ")}` : exit._tag === "Success" && exit.value.status === "nothing" ? "nothing to do" : end === "done" ? "nothing landed" : end)
              if (exit._tag === "Success" && exit.value.status === "landed" && exit.value.landed.length > 0) deps.onLanded?.(exit.value.landed)
              if (exit._tag === "Success" && exit.value.failed.length > 0 && !stopRequested) deps.onFailed?.(exit.value.failed)
              for (const t of ["plan", "implement"] as const) emit(t, E.runFinished(t, runId))
            }),
          ),
        )
      })

    let closing = false
    // Every outcome (a pass, a skip, an error), after the findings changed: the inbox follows them.
    const reconciler = startReconciler({ repo: deps.repo, quietMs: deps.settings.quietMs, findings, execute, onResult: () => deps.onPassEnd?.() })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true
        reconciler.close()
      }),
    )
    // A pass interrupted by the last shutdown (or changes made while zarg was off) are picked up now.
    reconciler.notify()

    /** Stop the running pass: its scenarios are cut short, nothing lands, its worktrees stay; the next graph change starts a new pass. */
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
      status: () => (active !== undefined ? "running" : "idle"),
    })

    /** Findings about the thread's focus (or all, without one), first on the driver's agenda. */
    // @scenario S-0025
    const agenda = (focus: ReadonlySet<string> | undefined): ReadonlyArray<AgendaItem> =>
      findings
        .list()
        .filter((f) => focus === undefined || f.about.length === 0 || f.about.some((c) => focus.has(c)))
        .map((f) => ({ id: f.id, title: f.title, detail: `${f.kind}: ${f.detail}${f.kind === "verify-failing" ? `\n\n${VERIFY_ENV}` : ""}`, about: f.about, priority: 0 }))

    /** Scenarios the next pass would take up (the working graph against the last checkpoint). */
    const pending = Effect.gen(function* () {
      const [before, after] = yield* Effect.all([
        Effect.flatMap(baseTree(deps.repo), (t) => snapshotAtTree(deps.repo, t)),
        Effect.flatMap(workingGraphTree(deps.repo), (t) => snapshotAtTree(deps.repo, t)),
      ])
      const a = yield* deps.affected(before, after)
      // Scenarios the last pass could not reconcile are taken up again too.
      const failed = (yield* pendingAt(deps.repo)).filter((id) => after.nodes.has(id) && !a.scenarios.includes(id) && !a.removed.includes(id))
      return a.scenarios.length + a.removed.length + failed.length
    }).pipe(Effect.orElseSucceed(() => 0))

    return { threads: [view("plan"), view("implement")], agenda, notify: reconciler.notify, findings, pending }
  })
