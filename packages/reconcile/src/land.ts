import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { GRAPH } from "./checkpoint"
import { git, gitRun } from "./git"

export type LandResult =
  | { readonly status: "landed" }
  /** The branch moved since the pass started: rebase onto `head`, verify again, land again. */
  | { readonly status: "moved"; readonly head: string }
  /** Uncommitted edits in paths the commit changes: try again later. */
  | { readonly status: "waiting"; readonly paths: ReadonlyArray<string> }
  /** The checkout cannot take a commit now (detached HEAD, a merge or rebase in progress). */
  | { readonly status: "refused"; readonly reason: string }

const statusPaths = (repo: string) =>
  Effect.map(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), (out) => {
    const paths: Array<string> = []
    const parts = out.split("\0").filter((p) => p.length > 0)
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!
      paths.push(entry.slice(3))
      if (entry[0] === "R" || entry[0] === "C") i++ // the rename's source path follows
    }
    return paths
  })

/** Why the checkout at `repo` cannot land a commit right now, if it cannot. */
export const checkoutProblem = (repo: string) =>
  Effect.gen(function* () {
    const branch = yield* gitRun(repo, ["symbolic-ref", "-q", "--short", "HEAD"])
    if (branch.code !== 0) return "HEAD is detached; check out a branch"
    const gitDir = yield* git(repo, ["rev-parse", "--absolute-git-dir"])
    for (const [f, what] of [["MERGE_HEAD", "a merge"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["CHERRY_PICK_HEAD", "a cherry-pick"]] as const) {
      if (existsSync(join(gitDir, f))) return `${what} is in progress; finish or abort it`
    }
    return undefined
  })

/**
 * Fast-forward the checked-out branch at `repo` from `base` to `commit`. Your uncommitted edits in other
 * paths stay. Graph files the driver has not committed are moved out of the way and put back: identical
 * ones simply match the commit, newer ones keep their newer content (the next pass reconciles them).
 * Idempotent: a commit already on the branch counts as landed.
 */
export const land = (repo: string, commit: string, base: string) =>
  Effect.gen(function* () {
    const problem = yield* checkoutProblem(repo)
    if (problem !== undefined) return { status: "refused", reason: problem } satisfies LandResult
    if ((yield* gitRun(repo, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0) return { status: "landed" } satisfies LandResult
    const head = yield* git(repo, ["rev-parse", "HEAD"])
    if (head !== base) return { status: "moved", head } satisfies LandResult

    const touched = new Set((yield* git(repo, ["diff", "--name-only", base, commit])).split("\n").filter((p) => p.length > 0))
    const dirty = (yield* statusPaths(repo)).filter((p) => touched.has(p))
    const blocked = dirty.filter((p) => !p.startsWith(`${GRAPH}/`))
    if (blocked.length > 0) return { status: "waiting", paths: blocked } satisfies LandResult

    // Graph files the commit touches: remember their working content (or absence), even when unchanged
    // since HEAD, since the driver may have edited or removed a card after the pass read it. Dirty ones are
    // made to match HEAD so the fast-forward can proceed; afterwards every path gets its working state back.
    const saved = new Map<string, string | undefined>()
    for (const p of [...touched].filter((p) => p.startsWith(`${GRAPH}/`))) {
      const abs = join(repo, p)
      saved.set(p, existsSync(abs) ? readFileSync(abs, "utf8") : undefined)
    }
    for (const p of dirty) {
      if ((yield* gitRun(repo, ["cat-file", "-e", `HEAD:${p}`])).code === 0) yield* git(repo, ["checkout", "-q", "HEAD", "--", p])
      else rmSync(join(repo, p), { force: true })
    }
    yield* git(repo, ["merge", "--ff-only", "-q", commit])
    for (const [p, content] of saved) {
      const landed = yield* gitRun(repo, ["show", `${commit}:${p}`])
      const committed = landed.code === 0 ? landed.stdout : undefined
      if (content === committed) continue
      if (content === undefined) rmSync(join(repo, p), { force: true })
      else writeFileSync(join(repo, p), content)
    }
    return { status: "landed" } satisfies LandResult
  })

/**
 * Rebase the pass branch at `cwd` onto `onto`. Conflicts go to `resolve` (fix the files in place, answer
 * true); an unresolved conflict aborts the rebase and is reported.
 */
export const rebaseOnto = <E, R>(cwd: string, onto: string, resolve: (files: ReadonlyArray<string>) => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    let r = yield* gitRun(cwd, ["rebase", "-q", onto])
    while (r.code !== 0) {
      const files = (yield* git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter((f) => f.length > 0)
      const ok = files.length > 0 && (yield* resolve(files))
      const markers = ok ? (yield* gitRun(cwd, ["grep", "-l", "-e", "^<<<<<<< ", "--", ...files])).stdout.trim() : "x"
      if (markers !== "") {
        yield* gitRun(cwd, ["rebase", "--abort"])
        return { ok: false, files } as const
      }
      yield* git(cwd, ["add", "-A"])
      r = yield* gitRun(cwd, ["-c", "core.editor=true", "rebase", "--continue"])
    }
    return { ok: true } as const
  })
