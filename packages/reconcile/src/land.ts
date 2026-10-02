import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { GRAPH } from "./checkpoint"
import { conflictedFiles, git, gitRun, hasConflictMarkers, zPaths } from "./git"
import { ensureIgnored } from "./worktree"

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

/** Where a landing keeps the driver's graph files while it works, so a failure or a kill never loses them. */
const notePath = (repo: string, commit: string) => join(repo, ".zarg", "reconcile", "landing", `${commit}.json`)
type Note = Record<string, string | null>

const restore = (repo: string, note: Note) => {
  for (const [p, content] of Object.entries(note)) {
    if (content === null) rmSync(join(repo, p), { force: true })
    else {
      mkdirSync(dirname(join(repo, p)), { recursive: true })
      writeFileSync(join(repo, p), content)
    }
  }
}

/** A landing note left by an interrupted landing: put those files back, then forget the note. */
const recover = (repo: string, commit: string) =>
  Effect.sync(() => {
    const file = notePath(repo, commit)
    if (!existsSync(file)) return
    restore(repo, JSON.parse(readFileSync(file, "utf8")) as Note)
    rmSync(file, { force: true })
  })

/**
 * Fast-forward `branch` (checked out at `repo`) from `base` to `commit`. Your uncommitted edits in other
 * paths stay. Graph files the commit touches keep their working state: identical ones simply match the
 * commit, newer or removed ones are put back after the fast-forward (the next pass reconciles them). Their
 * working state is written to a landing note first, so a failed or killed landing restores them.
 * Idempotent: a commit already on the branch counts as landed.
 */
// @scenario S-0049
export const land = (repo: string, commit: string, base: string, branch: string) =>
  Effect.gen(function* () {
    yield* recover(repo, commit)
    const problem = yield* checkoutProblem(repo)
    if (problem !== undefined) return { status: "refused", reason: problem } satisfies LandResult
    const current = yield* git(repo, ["symbolic-ref", "-q", "--short", "HEAD"])
    if (current !== branch) return { status: "refused", reason: `you switched to ${current}; this pass lands on ${branch}` } satisfies LandResult
    if ((yield* gitRun(repo, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0) return { status: "landed" } satisfies LandResult
    const head = yield* git(repo, ["rev-parse", "HEAD"])
    if (head !== base) return { status: "moved", head } satisfies LandResult

    // --no-renames: a rename shows both paths, so your edit in a renamed file is seen.
    const touched = new Set(zPaths(yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", base, commit])))
    const dirty = (yield* statusPaths(repo)).filter((p) => touched.has(p))
    const blocked = dirty.filter((p) => !p.startsWith(`${GRAPH}/`))
    // @scenario S-0050
    if (blocked.length > 0) return { status: "waiting", paths: blocked } satisfies LandResult

    const note: Note = {}
    for (const p of [...touched].filter((p) => p.startsWith(`${GRAPH}/`))) {
      const abs = join(repo, p)
      note[p] = existsSync(abs) ? readFileSync(abs, "utf8") : null
    }
    const file = notePath(repo, commit)
    ensureIgnored(repo)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(note))

    yield* Effect.gen(function* () {
      for (const p of dirty) {
        if ((yield* gitRun(repo, ["cat-file", "-e", `HEAD:${p}`])).code === 0) yield* git(repo, ["checkout", "-q", "HEAD", "--", p])
        else rmSync(join(repo, p), { force: true })
      }
      yield* git(repo, ["merge", "--ff-only", "-q", commit])
    }).pipe(Effect.ensuring(recover(repo, commit)))
    return { status: "landed" } satisfies LandResult
  })

/**
 * Rebase the pass commits at `cwd` (those after `upstream`) onto `onto`; nothing else is replayed. Conflicts
 * in graph files take the version from `onto` (it is newer; the next pass reconciles it); other conflicts
 * go to `resolve` (fix the files in place, answer true). An unresolved conflict aborts and is reported.
 */
export const rebaseOnto = <E, R>(cwd: string, onto: string, upstream: string, resolve: (files: ReadonlyArray<string>) => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    yield* gitRun(cwd, ["rebase", "--abort"])
    let r = yield* gitRun(cwd, ["rebase", "-q", "--onto", onto, upstream])
    while (r.code !== 0) {
      const files = yield* conflictedFiles(cwd)
      for (const f of files.filter((f) => f.startsWith(`${GRAPH}/`))) {
        // During a rebase "ours" is the branch being rebased onto: your newer graph.
        if ((yield* gitRun(cwd, ["checkout", "-q", "--ours", "--", f])).code !== 0) yield* git(cwd, ["rm", "-q", "--", f])
      }
      const rest = files.filter((f) => !f.startsWith(`${GRAPH}/`))
      const ok = files.length > 0 && (rest.length === 0 || ((yield* resolve(rest)) && !(yield* hasConflictMarkers(cwd, rest))))
      if (!ok) {
        yield* gitRun(cwd, ["rebase", "--abort"])
        return { ok: false, files } as const
      }
      yield* git(cwd, ["add", "-A"])
      r = yield* gitRun(cwd, ["-c", "core.editor=true", "rebase", "--continue"])
    }
    return { ok: true } as const
  })
