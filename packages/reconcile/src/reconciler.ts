import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, Effect } from "effect"
import { baseTree, GRAPH, workingGraphTree } from "./checkpoint"
import type { Findings } from "./findings"
import { git } from "./git"
import { checkoutProblem } from "./land"
import type { PassResult } from "./pass"
import { makeTrigger } from "./trigger"
import { ensureIgnored } from "./worktree"

export interface ReconcilerOptions {
  readonly repo: string
  readonly quietMs: number
  readonly findings: Findings
  /** Run one pass (Pass.execute with the engine provided). */
  readonly execute: (payload: { graph: string; branch: string; base: string; attempt: number }) => Effect.Effect<PassResult, unknown>
  /** Called after each pass (for threads and logs). */
  readonly onResult?: (result: PassResult | { readonly status: "skipped"; readonly reason: string }) => void
}

/**
 * Watches `.zarg/graph` and runs a pass after `quietMs` of quiet. `notify()` also triggers (in-process graph
 * writes). A pass starts only when the working graph differs from the last reconciled one.
 */
export const startReconciler = (opts: ReconcilerOptions) => {
  // A pass that failed for a state is tried again (under a new key) the next time the trigger fires. Kept on disk:
  // after a restart the old key would only replay the failed pass from the engine.
  // ponytail: every failed state's count is kept; prune when the file grows.
  const file = join(opts.repo, ".zarg", "reconcile", "attempts.json")
  const attempts = new Map<string, number>(
    (() => {
      try {
        return Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, number>)
      } catch {
        return []
      }
    })(),
  )
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
    const key = `${graph}:${branch}@${base}`
    const attempt = attempts.get(key) ?? 0
    const result = yield* opts.execute({ graph, branch, base, attempt })
    if (result.status === "failed") {
      attempts.set(key, attempt + 1)
      ensureIgnored(opts.repo)
      writeFileSync(file, JSON.stringify(Object.fromEntries(attempts)))
    }
    return result
  })
  // @scenario S-0020
  const trigger = makeTrigger(opts.quietMs, () =>
    Effect.runPromise(
      once.pipe(
        Effect.catchCause((cause) => {
          // Interrupted (the core is shutting down): the durable pass resumes on the next start.
          if (Cause.hasInterruptsOnly(cause)) return Effect.succeed({ status: "skipped" as const, reason: "interrupted" })
          opts.findings.raise({ kind: "pass-error", title: "a reconcile pass failed", detail: String(cause).slice(0, 4000), about: [], pass: "" })
          return Effect.succeed({ status: "skipped" as const, reason: "error" })
        }),
        Effect.tap((r) =>
          Effect.sync(() => {
            if (r.status === "landed" || r.status === "nothing" || (r.status === "skipped" && r.reason === "already reconciled")) opts.findings.clearGeneral()
            opts.onResult?.(r)
          }),
        ),
      ),
    ),
  )
  const dir = join(opts.repo, GRAPH)
  mkdirSync(dir, { recursive: true })
  // @scenario S-0020
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
