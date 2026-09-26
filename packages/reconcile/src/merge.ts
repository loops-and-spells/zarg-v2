import { Effect } from "effect"
import { git, gitRun } from "./git"

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
export const mergeBranches = <E, R>(cwd: string, branches: ReadonlyArray<string>, resolve: (c: Conflict) => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    const merged: Array<string> = []
    const failed: Array<Conflict> = []
    for (const branch of branches) {
      const r = yield* gitRun(cwd, ["merge", "--no-ff", "--no-edit", "-q", branch])
      if (r.code === 0) {
        merged.push(branch)
        continue
      }
      const files = (yield* git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter((f) => f.length > 0)
      const conflict = { branch, files }
      const ok = files.length > 0 && (yield* resolve(conflict))
      const markers = ok ? (yield* gitRun(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "--", ...files])).stdout.trim() : ""
      if (ok && markers === "") {
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
