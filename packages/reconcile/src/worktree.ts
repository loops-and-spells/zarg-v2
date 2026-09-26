import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { git, gitRun } from "./git"

/** Where passes keep their worktrees. A `*` .gitignore inside keeps them out of the repository. */
export const worktreeRoot = (repo: string) => join(repo, ".zarg", "reconcile", "wt")

const ensureIgnored = (repo: string) => {
  const dir = join(repo, ".zarg", "reconcile")
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n")
}

/**
 * A worktree at `path` on `branch`, reset to `base`. Idempotent: an existing worktree is reset
 * (tracked changes discarded, untracked files removed, ignored files such as node_modules kept).
 */
export const ensureWorktree = (repo: string, path: string, branch: string, base: string) =>
  Effect.gen(function* () {
    ensureIgnored(repo)
    if (existsSync(join(path, ".git"))) {
      yield* git(path, ["checkout", "-q", "-B", branch, base])
      yield* git(path, ["reset", "-q", "--hard", base])
      yield* git(path, ["clean", "-q", "-fd"])
    } else {
      mkdirSync(join(path, ".."), { recursive: true })
      yield* git(repo, ["worktree", "add", "-q", "-B", branch, path, base])
    }
    return path
  })

/** Remove a worktree and its branch; missing ones are fine. */
export const removeWorktree = (repo: string, path: string, branch: string) =>
  Effect.gen(function* () {
    yield* gitRun(repo, ["worktree", "remove", "--force", path])
    yield* gitRun(repo, ["branch", "-q", "-D", branch])
    yield* gitRun(repo, ["worktree", "prune"])
  })

/** Remove all but the newest `keep` pass directories under the worktree root (failed passes kept for inspection). */
export const gcPasses = (repo: string, keep: number, branchOf: (pass: string, name: string) => string) =>
  Effect.gen(function* () {
    const root = worktreeRoot(repo)
    if (!existsSync(root)) return
    const passes = readdirSync(root)
      .map((p) => ({ p, t: statSync(join(root, p)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(keep)
    for (const { p } of passes) {
      for (const name of readdirSync(join(root, p))) yield* removeWorktree(repo, join(root, p, name), branchOf(p, name))
      yield* Effect.sync(() => Bun.spawnSync(["rm", "-rf", join(root, p)]))
    }
  })
