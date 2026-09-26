import { rmSync } from "node:fs"
import { join } from "node:path"
import { type Duration, Effect, Schema } from "effect"
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

export interface Phase {
  readonly name: string
  /** Each item runs in its own worktree and commits there; the branches are merged afterwards. Otherwise items share the pass worktree. */
  readonly isolated: boolean
  readonly run: (item: string, cwd: string) => Effect.Effect<ItemOutcome>
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
  payload: { graph: Schema.String, branch: Schema.String, base: Schema.String },
  success: PassResult,
  idempotencyKey: (p) => `${p.graph}:${p.branch}@${p.base}`,
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

/** The workflow implementation for `spec`, as a layer. Every side effect is an Activity; the body replays on resume. */
export const passLayer = (spec: ReconcileSpec) =>
  Pass.toLayer((payload, executionId) =>
    Effect.gen(function* () {
      const id = executionId.slice(0, 12)
      const root = join(worktreeRoot(spec.repo), id)
      const main = join(root, "main")
      const branchOf = (name: string) => `zarg/${id}/${name}`
      const act = <A, I>(name: string, success: Schema.Codec<A, I>, execute: Effect.Effect<A, unknown>) =>
        Activity.make({ name, success, execute: Effect.orDie(execute) as Effect.Effect<A> })

      const scope = yield* act(
        "affected",
        Schema.Struct({ items: Strings, removed: Strings }),
        Effect.gen(function* () {
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
        const runItem = (item: string) =>
          act(
            `${phase.name}:${item}`,
            Outcome,
            Effect.gen(function* () {
              if (!phase.isolated) return yield* phase.run(item, main)
              const wt = join(root, item)
              yield* ensureWorktree(spec.repo, wt, branchOf(item), passHead)
              if (spec.setup) yield* spec.setup(wt)
              const out = yield* phase.run(item, wt)
              if (out.ok) yield* commitAll(wt, `${phase.name}: ${item}`)
              return out
            }),
          ).pipe(Effect.map((out) => [item, out as ItemOutcome] as const))
        const outcomes = yield* Effect.all(live.map(runItem), { concurrency: spec.maxParallel })
        for (const [item, out] of outcomes) if (!out.ok) failures.set(item, out)
        live = live.filter((i) => !failures.has(i))
        if (phase.isolated) {
          const conflicts = yield* act(
            `${phase.name}:merge`,
            Strings,
            Effect.map(
              mergeBranches(main, live.map(branchOf), (c) => spec.resolve(main, c.files)),
              (r) => r.failed.map((c) => c.branch),
            ),
          )
          for (const b of conflicts) {
            const item = live.find((i) => branchOf(i) === b)!
            failures.set(item, { ok: false, kind: "merge-conflict", title: `${item} conflicts with other cards in this pass`, detail: `branch ${b} could not be merged` })
          }
          live = live.filter((i) => !failures.has(i))
        } else {
          yield* act(`${phase.name}:commit`, Schema.String, commitAll(main, `${phase.name}: ${live.join(", ")}`))
        }
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
          }),
        )
      const report = (extra: ReadonlyArray<{ kind: FindingKind; title: string; detail: string; about: ReadonlyArray<string> }>) =>
        act(
          `findings:${extra.length}`,
          Schema.Void,
          Effect.sync(() => {
            for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
            for (const f of extra) spec.findings.raise({ ...f, pass: id })
          }),
        )
      const failed = () => [...failures.keys()].sort()

      const verified = yield* gate("verify")
      if (!verified.passed) {
        yield* report([{ kind: "verify-failing", title: "verify still fails after the fix attempts", detail: verified.output.slice(-4000), about: live }])
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
      let commit = yield* act("commit", Schema.String, squash(payload.base, payload.graph))
      let base = payload.base

      for (let attempt = 1; ; attempt++) {
        const lock = spec.withGraphLock ?? (<A, E>(e: Effect.Effect<A, E>) => e)
        const r = yield* act(
          `land:${attempt}`,
          Schema.Struct({ status: Schema.String, head: Schema.optionalKey(Schema.String), paths: Schema.optionalKey(Strings), reason: Schema.optionalKey(Schema.String) }),
          lock(land(spec.repo, commit, base)),
        )
        if (r.status === "landed") break
        if (r.status === "moved") {
          const rebased = yield* act(
            `rebase:${attempt}`,
            Schema.Boolean,
            Effect.map(rebaseOnto(main, r.head!, (files) => spec.resolve(main, files)), (x) => x.ok),
          )
          if (!rebased) {
            yield* report([{ kind: "merge-conflict", title: "this pass conflicts with your new commits", detail: `rebase onto ${r.head} failed`, about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          const again = yield* gate(`verify:${attempt}`)
          if (!again.passed) {
            yield* report([{ kind: "verify-failing", title: "verify fails on top of your new commits", detail: again.output.slice(-4000), about: live }])
            return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
          }
          base = r.head!
          commit = yield* act(`rebased:${attempt}`, Schema.String, squash(base, payload.graph))
          continue
        }
        if (r.status === "refused" || attempt >= spec.landAttempts) {
          const detail = r.status === "refused" ? r.reason! : `waiting on your uncommitted edits in ${(r.paths ?? []).join(", ")}`
          yield* report([{ kind: "landing-blocked", title: "the implementation commit cannot land", detail, about: live }])
          return { status: "failed", commit, landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
        }
        yield* DurableClock.sleep({ name: `land-wait:${attempt}`, duration: spec.landRetry })
      }

      yield* act(
        "cleanup",
        Schema.Void,
        Effect.gen(function* () {
          spec.findings.clearFor(live)
          for (const [item, f] of failures) spec.findings.raise({ kind: f.kind, title: f.title, detail: f.detail, about: [item], pass: id })
          for (const item of scope.items) yield* removeWorktree(spec.repo, join(root, item), branchOf(item))
          yield* removeWorktree(spec.repo, main, branchOf("main"))
          yield* Effect.sync(() => rmSync(root, { recursive: true, force: true }))
        }),
      )
      return { status: "landed", commit, landed: live.sort(), failed: failed() } satisfies PassResult
    }),
  )
