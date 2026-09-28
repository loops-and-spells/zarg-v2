import { Effect, Exit, Semaphore } from "effect"
import { parseRef } from "@zarg/entities"

type Failure = { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }
interface Plan {
  readonly id: string
  readonly title: string
  readonly cards: ReadonlyArray<{ readonly ref: string }>
  readonly changes: ReadonlyArray<{ readonly tool: string; readonly params: unknown }>
}
export interface PlannerDeps {
  /** The backlog's methods (`next`, `moved`). */
  readonly invoke: (plugin: string, method: string, params: unknown) => Effect.Effect<unknown, Failure>
  /** A graph plugin's tool through the write pipeline (validate, lints, commit to the store). */
  readonly call: (name: string, params: unknown) => Effect.Effect<{ readonly added: ReadonlyArray<string>; readonly changed: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }, Failure>
  /** No other graph write lands while a plan applies. */
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Commit exactly these nodes' files; the commit's sha (undefined: nothing to commit). */
  readonly commit: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<string | undefined, unknown>
  /** Put these nodes' files back as the last commit has them (a half-applied plan). */
  readonly restore: (ids: ReadonlyArray<string>) => Effect.Effect<void, unknown>
  /** Wake the reconcile loop (it implements what changed). */
  readonly notify: () => void
  readonly reconcileOn: () => boolean
  /** Running plans (backlog/item entities). */
  readonly running: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly data: unknown }>, unknown>
}
const why = (e: Failure) => (e.findings !== undefined && e.findings.length > 0 ? e.findings.map((f) => f.message).join("; ") : (e.message ?? e._tag))

/**
 * The Planner Agent: takes the next Ready plan off the Backlog, applies its drafted card changes through the graph's
 * write pipeline, commits exactly those nodes, and hands them to the reconcile loop; a landed pass moves it to Review.
 */
export const makePlanner = (d: PlannerDeps) => {
  const lock = Effect.runSync(Semaphore.make(1))
  const moved = (id: string, to: string, what: string, needs?: string) => Effect.ignore(d.invoke("backlog", "moved", { id, to, by: "Planner", what, ...(needs !== undefined ? { needs } : {}) }))
  const tick = Effect.gen(function* () {
    const plan = (yield* d.invoke("backlog", "next", {}).pipe(Effect.orElseSucceed(() => null))) as Plan | null
    if (plan === null) return
    // Running before anything changes: a restart halfway never applies the same plan twice.
    yield* moved(plan.id, "running", `applying ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}`)
    const touched: Array<string> = []
    const applied = yield* Effect.exit(
      d.exclusive(
        Effect.forEach(plan.changes, (c) =>
          d.call(`gherkin/${c.tool}`, c.params).pipe(
            Effect.tap((r) => Effect.sync(() => touched.push(...r.added, ...r.changed, ...r.removed))),
            Effect.mapError((e) => ({ ...e, message: `gherkin/${c.tool}: ${why(e)}` })),
          ),
          { discard: true },
        ),
      ),
    )
    if (Exit.isFailure(applied)) {
      yield* Effect.ignore(d.restore([...new Set(touched)]))
      const e = applied.cause.reasons.find((r) => r._tag === "Fail") as { error?: Failure } | undefined
      yield* moved(plan.id, "ready", "apply failed", e?.error?.message ?? "the apply failed")
      return
    }
    const sha = yield* d.commit([...new Set(touched)], `req: ${plan.title} (${plan.id})`).pipe(Effect.orElseSucceed(() => undefined))
    const at = sha === undefined ? "applied (nothing to commit)" : `applied in ${sha.slice(0, 7)}`
    if (!d.reconcileOn()) return yield* moved(plan.id, "review", `${at}; reconcile is off: implement by hand`)
    yield* moved(plan.id, "running", at)
    d.notify()
  }).pipe(lock.withPermits(1))

  /** A pass landed these cards: every Running plan whose cards all landed is ready for review. */
  const landed = (cards: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const done = new Set(cards)
      for (const r of yield* d.running().pipe(Effect.orElseSucceed(() => []))) {
        const plan = r.data as Plan
        if (plan.cards.length > 0 && plan.cards.every((c) => done.has(parseRef(c.ref)?.id ?? ""))) yield* Effect.ignore(d.invoke("backlog", "moved", { id: r.id, to: "review", by: "reconcile", what: "landed" }))
      }
    })
  return { tick, landed }
}
