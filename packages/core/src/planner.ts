import { Effect, Semaphore } from "effect"
import { parseRef } from "@zarg/entities"

type Failure = { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }
interface Plan {
  readonly id: string
  readonly title: string
  readonly scenarios: ReadonlyArray<{ readonly ref: string }>
  readonly changes: ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
}
export interface PlannerDeps {
  /** The backlog's methods (`next`, `moved`). */
  readonly invoke: (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, Failure>
  /**
   * A plan's tool calls, in order, under one hold of the graph's write lock (the host's `calls`): `before` (what the
   * files were), `failure` (undo) and `after` (check and commit) run under the same hold, so no other write lands between.
   */
  readonly calls: <B, R>(
    list: ReadonlyArray<{ readonly name: string; readonly params: unknown }>,
    hooks: { readonly before: Effect.Effect<B>; readonly failure: (b: B, touched: ReadonlyArray<string>) => Effect.Effect<void, unknown>; readonly after: (b: B, touched: ReadonlyArray<string>) => Effect.Effect<R> },
  ) => Effect.Effect<{ readonly touched: ReadonlyArray<string>; readonly before: B; readonly after: R }, { readonly touched: ReadonlyArray<string>; readonly error: Failure }>
  /** The graph now (to know which scenarios a plan affected). */
  readonly snapshot: Effect.Effect<unknown, unknown>
  /** The scenarios a change between two graphs affects (the plugins' `affected`). */
  readonly affected: (before: unknown, after: unknown) => Effect.Effect<{ readonly scenarios: ReadonlyArray<string> }, unknown>
  /** The graph's node files now: put touched ones back to these bytes; name the touched ones the operator had changed. */
  readonly files: () => Effect.Effect<{ readonly restore: (ids: ReadonlyArray<string>) => Effect.Effect<void, unknown>; readonly dirty: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, unknown> }, unknown>
  /** Whether a scenario is still in the graph (a plan may remove one). */
  readonly exists: (scenario: string) => Effect.Effect<boolean, unknown>
  /** Commit exactly these nodes' files; the commit's sha (undefined: nothing to commit). */
  readonly commit: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<string | undefined, unknown>
  /** Wake the reconcile loop (it implements what changed). */
  readonly notify: () => void
  readonly reconcileOn: () => boolean
  /** Running plans (backlog/item entities). */
  readonly running: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly data: unknown }>, unknown>
}
const why = (e: Failure) => (e.findings !== undefined && e.findings.length > 0 ? e.findings.map((f) => f.message).join("; ") : (e.message ?? e._tag))
const scenarioIds = (p: Plan) => p.scenarios.map((c) => parseRef(c.ref)?.id ?? "")

/**
 * The Planner Agent: takes the next Ready plan off the Backlog, applies its drafted scenario changes through the graph's
 * write pipeline, commits exactly those nodes, and hands them to the reconcile loop; a landed pass moves it to Review.
 */
export const makePlanner = (d: PlannerDeps) => {
  const lock = Effect.runSync(Semaphore.make(1))
  const moved = (id: string, to: string, by: string, what: string, needs?: string, scenarios?: ReadonlyArray<string>) =>
    d.invoke("backlog", "moved", { id, to, by, what, ...(needs !== undefined ? { needs } : {}), ...(scenarios !== undefined && scenarios.length > 0 ? { scenarios } : {}) })
  const tick = Effect.gen(function* () {
    const plan = (yield* d.invoke("backlog", "next", {}).pipe(Effect.orElseSucceed(() => null))) as Plan | null
    if (plan === null) return
    // Running before anything changes (a restart halfway never applies it twice); a plan that cannot be marked is not applied.
    const marked = yield* Effect.exit(moved(plan.id, "running", "Planner", `applying ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}`))
    if (marked._tag === "Failure") return
    type Files = Effect.Success<ReturnType<PlannerDeps["files"]>>
    const applied = yield* Effect.exit(
      d.calls(
        plan.changes.map((c) => ({ name: `gherkin/${c.tool}`, params: c.params })),
        {
          before: Effect.all({ files: d.files().pipe(Effect.orDie), graph: d.snapshot.pipe(Effect.orElseSucceed(() => undefined)) }),
          failure: (b: { files: Files; graph: unknown }, touched) => b.files.restore(touched),
          // Under the same hold: a node the operator changed and has not committed would be swept into this commit.
          after: (b: { files: Files; graph: unknown }, touched) =>
            Effect.gen(function* () {
              const dirty = yield* b.files.dirty(touched).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              if (dirty.length > 0) {
                yield* Effect.ignore(b.files.restore(touched))
                return { dirty, sha: undefined as string | undefined, graph: undefined as unknown }
              }
              const sha = yield* d.commit(touched, `req: ${plan.title} (${plan.id})`).pipe(Effect.orElseSucceed(() => undefined))
              return { dirty, sha, graph: yield* d.snapshot.pipe(Effect.orElseSucceed(() => undefined)) }
            }),
        },
      ),
    )
    if (applied._tag === "Failure") {
      const e = applied.cause.reasons.find((r) => r._tag === "Fail") as { error?: { touched: ReadonlyArray<string>; error: Failure } } | undefined
      yield* Effect.ignore(moved(plan.id, "ready", "Planner", "apply failed", e?.error !== undefined ? why(e.error.error) : "the apply failed"))
      return
    }
    const { dirty, sha, graph } = applied.value.after
    if (dirty.length > 0) {
      yield* Effect.ignore(moved(plan.id, "ready", "Planner", "waits for your graph edits", `commit your uncommitted changes to ${dirty.join(", ")} first (the plan changes them too)`))
      return
    }
    // The scenarios the plan affected (a reworded state's scenarios, a new scenario): the ones a landed pass must cover.
    const scenarios = applied.value.before.graph === undefined || graph === undefined ? [] : (yield* d.affected(applied.value.before.graph, graph).pipe(Effect.orElseSucceed(() => ({ scenarios: [] as ReadonlyArray<string> })))).scenarios
    const at = sha === undefined ? "applied (nothing to commit)" : `applied in ${sha.slice(0, 7)}`
    if (!d.reconcileOn()) return yield* Effect.ignore(moved(plan.id, "review", "Planner", `${at}; reconcile is off: implement by hand`, undefined, scenarios))
    yield* Effect.ignore(moved(plan.id, "running", "Planner", at, undefined, scenarios))
    d.notify()
  }).pipe(lock.withPermits(1))

  // A code plan is the operator's (no graph changes to apply, no pass of its own): a pass's result never moves it.
  const runningPlans = Effect.map(d.running().pipe(Effect.orElseSucceed(() => [])), (rs) => rs.map((r) => ({ id: r.id, plan: r.data as Plan })).filter((r) => (r.plan as { kind?: string }).kind !== "code"))
  /** A pass landed these scenarios: a Running plan whose scenarios all landed (or were removed by it) is ready for review. */
  const landed = (scenarios: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // Landed scenarios are built now: planned is cleared (affected ignores it, so no pass follows).
      // One call per scenario (one that fails leaves the rest), committed when it changed the scenario.
      for (const id of scenarios)
        yield* Effect.ignore(
          d.calls([{ name: "gherkin/edit-scenario", params: { id, planned: false } }], {
            before: Effect.void,
            failure: () => Effect.void,
            after: (_, touched) => (touched.length > 0 ? Effect.asVoid(Effect.ignore(d.commit(touched, `req: ${id} is built (landed)`))) : Effect.void),
          }),
        )
      const done = new Set(scenarios)
      for (const { id, plan } of yield* runningPlans) {
        const ids = scenarioIds(plan)
        if (ids.length === 0 || !ids.some((c) => done.has(c))) continue
        const all = yield* Effect.forEach(ids, (c) => (done.has(c) ? Effect.succeed(true) : Effect.map(d.exists(c).pipe(Effect.orElseSucceed(() => true)), (e) => !e)))
        if (all.every(Boolean)) yield* Effect.ignore(d.invoke("backlog", "moved", { id, to: "review", by: "reconcile", what: "landed" }))
      }
    })
  /** A pass failed on these scenarios: a Running plan with one of them goes back to Ready, for the operator. */
  const failed = (scenarios: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const bad = new Set(scenarios)
      for (const { id, plan } of yield* runningPlans) {
        const hit = scenarioIds(plan).filter((c) => bad.has(c))
        if (hit.length > 0)
          yield* Effect.ignore(
            d.invoke("backlog", "moved", { id, to: "ready", by: "reconcile", what: `the pass failed on ${hit.join(", ")}`, needs: `the reconcile pass failed on ${hit.join(", ")}: see the driver's agenda, then move it to Ready` }),
          )
      }
    })
  return { tick, landed, failed }
}
