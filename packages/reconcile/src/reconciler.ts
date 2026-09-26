import { existsSync, mkdirSync, watch } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { baseTree, GRAPH, workingGraphTree } from "./checkpoint"
import type { Findings } from "./findings"
import { git } from "./git"
import { checkoutProblem } from "./land"
import type { PassResult } from "./pass"
import { makeTrigger } from "./trigger"

export interface ReconcilerOptions {
  readonly repo: string
  readonly quietMs: number
  readonly findings: Findings
  /** Run one pass (Pass.execute with the engine provided). */
  readonly execute: (payload: { graph: string; branch: string; base: string }) => Effect.Effect<PassResult, unknown>
  /** Called after each pass (for threads and logs). */
  readonly onResult?: (result: PassResult | { readonly status: "skipped"; readonly reason: string }) => void
}

/**
 * Watches `.zarg/graph` and runs a pass after `quietMs` of quiet. `notify()` also triggers (in-process graph
 * writes). A pass starts only when the working graph differs from the last reconciled one.
 */
export const startReconciler = (opts: ReconcilerOptions) => {
  const once = Effect.gen(function* () {
    const problem = yield* checkoutProblem(opts.repo)
    if (problem !== undefined) {
      opts.findings.raise({ kind: "pass-error", title: "reconcile cannot start", detail: problem, about: [], pass: "" })
      return { status: "skipped", reason: problem } as const
    }
    const graph = yield* workingGraphTree(opts.repo)
    const base = yield* git(opts.repo, ["rev-parse", "HEAD"])
    if ((yield* baseTree(opts.repo, base)) === graph) return { status: "skipped", reason: "already reconciled" } as const
    const branch = yield* git(opts.repo, ["symbolic-ref", "--short", "HEAD"])
    return yield* opts.execute({ graph, branch, base })
  })
  const trigger = makeTrigger(opts.quietMs, () =>
    Effect.runPromise(
      once.pipe(
        Effect.catchCause((cause) => {
          opts.findings.raise({ kind: "pass-error", title: "a reconcile pass failed", detail: String(cause).slice(0, 4000), about: [], pass: "" })
          return Effect.succeed({ status: "skipped", reason: "error" } as const)
        }),
        Effect.tap((r) => Effect.sync(() => opts.onResult?.(r))),
      ),
    ),
  )
  const dir = join(opts.repo, GRAPH)
  mkdirSync(dir, { recursive: true })
  const watcher = existsSync(dir) ? watch(dir, { recursive: true }, () => trigger.notify()) : undefined
  return {
    notify: trigger.notify,
    busy: trigger.busy,
    close: () => {
      watcher?.close()
      trigger.close()
    },
  }
}
