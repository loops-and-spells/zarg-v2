import { Effect } from "effect"
import { conflictedFiles, git, gitRun, hasConflictMarkers } from "./git"

export interface Conflict {
  readonly branch: string
  readonly files: ReadonlyArray<string>
}

/**
 * Merge `branches` one by one into the branch checked out at `cwd`. On a conflict, `resolve` gets the
 * conflicted files to fix in place; it answers true when they are resolved (the merge is then committed)
 * or false (the merge is aborted and the branch reported). Returns the merged branches and the conflicts
 * that could not be resolved.
 */
export const mergeBranches = <E, R>(cwd: string, branches: ReadonlyArray<string>, resolve: (c: Conflict) => Effect.Effect<boolean, E, R>, from?: string) =>
  Effect.gen(function* () {
    // Re-run safe: an earlier, interrupted run may have left a merge in progress. Start over from `from`.
    if (from !== undefined) {
      yield* gitRun(cwd, ["merge", "--abort"])
      yield* git(cwd, ["reset", "-q", "--hard", from])
      yield* git(cwd, ["clean", "-q", "-fd"])
    }
    const merged: Array<string> = []
    const failed: Array<Conflict> = []
    for (const branch of branches) {
      const r = yield* gitRun(cwd, ["merge", "--no-ff", "--no-edit", "-q", branch])
      if (r.code === 0) {
        merged.push(branch)
        continue
      }
      const files = yield* conflictedFiles(cwd)
      const conflict = { branch, files }
      // @card C-0053
      const ok = files.length > 0 && (yield* resolve(conflict)) && !(yield* hasConflictMarkers(cwd, files))
      if (ok) {
        yield* git(cwd, ["add", "-A"])
        yield* git(cwd, ["commit", "-q", "--no-edit"])
        merged.push(branch)
      } else {
        yield* gitRun(cwd, ["merge", "--abort"])
        failed.push(conflict)
      }
    }
    return { merged, failed }
  })
