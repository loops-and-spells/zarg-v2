import { rmSync } from "node:fs"
import { join } from "node:path"
import { type Duration, Effect, Schema, Semaphore } from "effect"
import type { Snapshot } from "@zarg/graph"
import { Activity, DurableClock, Workflow } from "effect/unstable/workflow"
import { baseTree, CHECKPOINT, GRAPH, LEGACY_CHECKPOINT, snapshotAtTree } from "./checkpoint"
import type { FindingKind, Findings } from "./findings"
import { git, gitRun } from "./git"
import { land, rebaseOnto } from "./land"
import { mergeBranches } from "./merge"
import { ensureWorktree, removeWorktree, worktreeRoot } from "./worktree"

/** What one phase did for one item. A failure becomes a finding and drops the item from later phases. */
export type ItemOutcome = { readonly ok: true } | { readonly ok: false; readonly kind: FindingKind; readonly title: string; readonly detail: string }

/**
 * One phase. Each item runs in its own worktree and commits there; the item branches are then merged into
 * the pass worktree, so a failed item leaves nothing behind.
 */
export interface Phase {
  readonly name: string
  /** Run the spec's `setup` in each item worktree first (e.g. implement needs dependencies; plan does not). */
  readonly setup: boolean
  /** A failure or defect here fails this item only. */
  readonly run: (item: string, cwd: string) => Effect.Effect<ItemOutcome, unknown>
}

export interface ReconcileSpec {
  /** The repository (your main checkout). */
  readonly repo: string
  readonly phases: ReadonlyArray<Phase>
  /** Items (cards) to reconcile between the base graph and the new one, and items that were removed. */
  readonly affected: (base: Snapshot.Snapshot, current: Snapshot.Snapshot) => { readonly items: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }
  /** Runs in every new worktree before phases use it (e.g. `bun install`). */
  readonly setup?: (cwd: string) => Effect.Effect<void>
  /** Runs once in the pass worktree for removed items (e.g. delete their plan files). */
  readonly onRemoved?: (items: ReadonlyArray<string>, cwd: string) => Effect.Effect<void>
  readonly verify: (cwd: string) => Effect.Effect<{ readonly passed: boolean; readonly output: string }>
  /** Try to make verify pass (attempt 1, 2, …) by editing files in `cwd`. */
  readonly fix: (cwd: string, output: string, attempt: number) => Effect.Effect<void>
  /** Resolve conflicted files in place; true when resolved. */
  readonly resolve: (cwd: string, files: ReadonlyArray<string>) => Effect.Effect<boolean>
  readonly findings: Findings
  readonly maxParallel: number
  readonly fixAttempts: number
  /** Wait between landing attempts while your edits block it. */
  readonly landRetry: Duration.Input
  /** Landing attempts before a landing-blocked finding (spec: 10, one a minute). */
  readonly landAttempts: number
  readonly message: (items: ReadonlyArray<string>) => string
  /**
   * The developer's stop: `wait` completes when a stop is requested (running cards race it and are cut
   * short); `requested` is checked between steps. A stopped pass ends as failed, without findings.
   */
  readonly stop?: { readonly requested: () => boolean; readonly wait: Effect.Effect<void> }
  /** Hold the graph write lock while landing, so no graph write lands halfway. */
  readonly withGraphLock?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
}

export const PassResult = Schema.Struct({
  status: Schema.Literals(["nothing", "landed", "failed"]),
  commit: Schema.optionalKey(Schema.String),
  landed: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
})
export type PassResult = typeof PassResult.Type

/** One reconcile pass over one graph state, onto one branch at one base commit. Durable: it resumes after a restart. */
export const Pass = Workflow.make("zarg/ReconcilePass", {
  /** `attempt` changes the key: a pass that failed for the same graph and base can be tried again. */
  payload: { graph: Schema.String, branch: Schema.String, base: Schema.String, attempt: Schema.Number },
  success: PassResult,
  idempotencyKey: (p) => `${p.graph}:${p.branch}@${p.base}#${p.attempt}`,
})

const Outcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), kind: Schema.String, title: Schema.String, detail: Schema.String }),
])
const Strings = Schema.Array(Schema.String)

const commitAll = (cwd: string, message: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["add", "-A"])
    const staged = yield* gitRun(cwd, ["diff", "--cached", "--quiet"])
    if (staged.code !== 0) yield* git(cwd, ["commit", "-q", "-m", message])
    return yield* git(cwd, ["rev-parse", "HEAD"])
  })

/** One pass at a time per repository, including passes the engine resumes on start. */
const passLocks = new Map<string, Semaphore.Semaphore>()
const passLock = (repo: string) => {
  let s = passLocks.get(repo)
  if (s === undefined) {
    s = Semaphore.makeUnsafe(1)
    passLocks.set(repo, s)
  }
  return s
}

/** The workflow implementation for `spec`, as a layer. Every side effect is an Activity; the body replays on resume. */
export const passLayer = (spec: ReconcileSpec) =>
  Pass.toLayer((payload, executionId) => {
    const id = executionId.slice(0, 12)
    const act = <A, I>(name: string, success: Schema.Codec<A, I>, execute: Effect.Effect<A, unknown>) =>
      Activity.make({ name, success, execute: Effect.orDie(execute) as Effect.Effect<A> })
    // Anything unexpected ends the pass as failed with a finding (recorded, so a resume does not repeat it).
    const died = (cause: unknown) =>
      act(
        "findings:died",
        Schema.Void,
        Effect.sync(() => void spec.findings.raise({ kind: "pass-error", title: "a reconcile pass failed", detail: String(cause).slice(0, 4000), about: [], pass: id })),
      ).pipe(Effect.as({ status: "failed", landed: [], failed: [] } satisfies PassResult))
    return Semaphore.withPermits(passLock(spec.repo), 1)(body(spec, payload, id, act)).pipe(Effect.catchCause(died))
  })

const body = (
  spec: ReconcileSpec,
  payload: typeof Pass.payloadSchema.Type,
  id: string,
  act: <A, I>(name: string, success: Schema.Codec<A, I>, execute: Effect.Effect<A, unknown>) => Effect.Effect<A, never, any>,
) =>
    Effect.gen(function* () {
      const root = join(worktreeRoot(spec.repo), id)
      const main = join(root, "main")
      // A stop is an outside event: record whether it was requested, so a resumed pass replays the same answer.
      const isStopped = (site: string) => act(site, Schema.Boolean, Effect.sync(() => spec.stop?.requested() ?? false))
      const stoppedResult = { status: "failed", landed: [], failed: [] } satisfies PassResult
      const branchOf = (name: string) => `zarg/${id}/${name}`

      const scope = yield* act(
        "affected",
        Schema.Struct({ items: Strings, removed: Strings }),
        Effect.gen(function* () {
          // A pass that waited for another (or resumed after a restart) may find its graph already reconciled.
          const tip = yield* gitRun(spec.repo, ["rev-parse", "-q", "--verify", `refs/heads/${payload.branch}`])
          if (tip.code === 0 && (yield* baseTree(spec.repo, tip.stdout.trim())) === payload.graph) return { items: [], removed: [] }
          const baseGraph = yield* baseTree(spec.repo, payload.base)
          const [before, after] = yield* Effect.all([snapshotAtTree(spec.repo, baseGraph), snapshotAtTree(spec.repo, payload.graph)])
          const affected = spec.affected(before, after)
          // Findings about cards that changed are stale: this pass takes them up again.
          spec.findings.clearFor([...affected.items, ...affected.removed])
          return affected
        }),
      )
      if (scope.items.length === 0 && scope.removed.length === 0) return { status: "nothing", landed: [], failed: [] } satisfies PassResult

      // The pass worktree holds exactly the graph tree this pass reconciles (read from git, so later edits cannot leak in).
      yield* act(
        "worktree",
        Schema.String,
        Effect.gen(function* () {
          yield* ensureWorktree(spec.repo, main, branchOf("main"), payload.base)
          yield* gitRun(main, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", GRAPH])
          rmSync(join(main, GRAPH), { recursive: true, force: true })
          yield* git(main, ["read-tree", `--prefix=${GRAPH}/`, "-u", payload.graph])
          if (spec.setup) yield* spec.setup(main)
          if (spec.onRemoved && scope.removed.length > 0) yield* spec.onRemoved(scope.removed, main)
          return yield* commitAll(main, "wip: graph")
        }),
      )

      const failures = new Map<string, Extract<ItemOutcome, { ok: false }>>()
      let live = [...scope.items]
      for (const phase of spec.phases) {
        const passHead = yield* act(`${phase.name}:head`, Schema.String, git(main, ["rev-parse", "HEAD"]))
        const name = (item: string) => `${phase.name}-${item}`
        const runItem = (item: string) =>
          act(
            `${phase.name}:${item}`,
            Outcome,
            Effect.gen(function* () {
              const wt = join(root, name(item))
              yield* ensureWorktree(spec.repo, wt, branchOf(name(item)), passHead)
              if (phase.setup && spec.setup) yield* spec.setup(wt)
              const stopped = { ok: false, kind: "pass-error", title: "stopped", detail: "stopped by the developer" } as ItemOutcome
              const out = yield* phase.run(item, wt).pipe(
                Effect.raceFirst(spec.stop ? Effect.as(spec.stop.wait, stopped) : Effect.never),
                Effect.catchCause((cause) =>
                  Effect.succeed({ ok: false, kind: "pass-error", title: `${phase.name} failed for ${item}`, detail: String(cause).slice(0, 4000) } as ItemOutcome),
                ),
              )
              if (out.ok) yield* commitAll(wt, `${phase.name}: ${item}`)
              return out
            }),
          ).pipe(Effect.map((out) => [item, out as ItemOutcome] as const))
        const outcomes = yield* Effect.all(live.map(runItem), { concurrency: spec.maxParallel })
        if (yield* isStopped(`stopped:${phase.name}`)) return stoppedResult
        for (const [item, out] of outcomes) if (!out.ok) failures.set(item, out)
        live = live.filter((i) => !failures.has(i))
        const conflicts = yield* act(
          `${phase.name}:merge`,
          Strings,
          Effect.map(
            mergeBranches(main, live.map((i) => branchOf(name(i))), (c) => spec.resolve(main, c.files), passHead),
            (r) => r.failed.map((c) => c.branch),
          ),
        )
        for (const b of conflicts) {
          const item = live.find((i) => branchOf(name(i)) === b)!
          failures.set(item, { ok: false, kind: "merge-conflict", title: `${item} conflicts with other cards in this pass`, detail: `branch ${b} could not be merged` })
        }
        live = live.filter((i) => !failures.has(i))
      }

      const gate = (label: string) =>
        act(
          label,
          Schema.Struct({ passed: Schema.Boolean, output: Schema.String }),
          Effect.gen(function* () {
            let v = yield* spec.verify(main)
            for (let attempt = 1; !v.passed && attempt <= spec.fixAttempts; attempt++) {
              yield* spec.fix(main, v.output, attempt)
              yield* commitAll(main, `fix: attempt ${attempt}`)
              v = yield* spec.verify(main)
            }
            return v
          }).pipe(Effect.raceFirst(spec.stop ? Effect.as(spec.stop.wait, { passed: false, output: "stopped" }) : Effect.never)),
        )
      const report = (site: string, extra: ReadonlyArray<{ kind: FindingKind; title: string; detail: string; about: ReadonlyArray<string> }>) =>
        act(
          `findings:${site}`,
          Schema.Void,
          Effect.sync(() => {
            for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
            for (const f of extra) spec.findings.raise({ ...f, pass: id })
          }),
        )
      const failed = () => [...failures.keys()].sort()

      if (yield* isStopped("stopped:verify")) return stoppedResult
      const verified = yield* gate("verify")
      if (yield* isStopped("stopped:verified")) return stoppedResult
      if (!verified.passed) {
        yield* report("verify", [{ kind: "verify-failing", title: "verify still fails after the fix attempts", detail: verified.output.slice(-4000), about: live }])
        return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
      }

      // One commit on top of the base: the whole graph tree, plans and code, and the checkpoint.
      const squash = (base: string, graph: string) =>
        Effect.gen(function* () {
          yield* git(main, ["reset", "-q", "--soft", base])
          yield* Effect.sync(() => Bun.write(join(main, CHECKPOINT), `${JSON.stringify({ graph }, null, 2)}\n`))
          yield* gitRun(main, ["rm", "-q", "--cached", "--ignore-unmatch", LEGACY_CHECKPOINT])
          rmSync(join(main, LEGACY_CHECKPOINT), { force: true })
          return yield* commitAll(main, spec.message(live))
        })
      if (yield* isStopped("stopped:commit")) return stoppedResult
      let commit = yield* act("commit", Schema.String, squash(payload.base, payload.graph))
      let base = payload.base

      for (let attempt = 1; ; attempt++) {
        const lock = spec.withGraphLock ?? (<A, E>(e: Effect.Effect<A, E>) => e)
        const r = yield* act(
          `land:${attempt}`,
          Schema.Struct({ status: Schema.String, head: Schema.optionalKey(Schema.String), paths: Schema.optionalKey(Strings), reason: Schema.optionalKey(Schema.String) }),
          lock(land(spec.repo, commit, base, payload.branch)),
        )
        if (r.status === "landed") break
        if (r.status === "moved") {
          const rebased = yield* act(
            `rebase:${attempt}`,
            Schema.Boolean,
            Effect.gen(function* () {
              // Re-run safe: start from the pass commit; replay only it (not your old base) onto your new HEAD.
              yield* gitRun(main, ["rebase", "--abort"])
              yield* git(main, ["reset", "-q", "--hard", commit])
              return (yield* rebaseOnto(main, r.head!, base, (files) => spec.resolve(main, files))).ok
            }),
          )
          if (!rebased) {
            yield* report(`rebase:${attempt}`, [{ kind: "merge-conflict", title: "this pass conflicts with your new commits", detail: `rebase onto ${r.head} failed`, about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          const again = yield* gate(`verify:${attempt}`)
          if (!again.passed) {
            yield* report(`verify:${attempt}`, [{ kind: "verify-failing", title: "verify fails on top of your new commits", detail: again.output.slice(-4000), about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          base = r.head!
          commit = yield* act(`rebased:${attempt}`, Schema.String, squash(base, payload.graph))
          continue
        }
        if (r.status === "refused" || attempt >= spec.landAttempts) {
          const detail = r.status === "refused" ? r.reason! : `waiting on your uncommitted edits in ${(r.paths ?? []).join(", ")}`
          yield* report(`land:${attempt}`, [{ kind: "landing-blocked", title: "the implementation commit cannot land", detail, about: live }])
          return { status: "failed", commit, landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
        }
        if (yield* isStopped(`stopped:land:${attempt}`)) return stoppedResult
        yield* DurableClock.sleep({ name: `land-wait:${attempt}`, duration: spec.landRetry })
      }

      yield* act(
        "cleanup",
        Schema.Void,
        Effect.gen(function* () {
          spec.findings.clearFor(live)
          for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
          for (const phase of spec.phases) for (const item of scope.items) yield* removeWorktree(spec.repo, join(root, `${phase.name}-${item}`), branchOf(`${phase.name}-${item}`))
          yield* removeWorktree(spec.repo, main, branchOf("main"))
          yield* Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        }),
      )
      return { status: "landed", commit, landed: live.sort(), failed: failed() } satisfies PassResult
    })
