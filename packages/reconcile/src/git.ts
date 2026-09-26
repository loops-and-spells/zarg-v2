import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Data, Effect } from "effect"

export class GitError extends Data.TaggedError("GitError")<{ readonly args: ReadonlyArray<string>; readonly message: string }> {}

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run git in `cwd`; never fails on a non-zero exit (callers that expect conflicts read the code). */
export const gitRun = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): Effect.Effect<GitResult> =>
  Effect.promise(async () => {
    const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, stdout, stderr }
  })

/** Run git in `cwd`; a non-zero exit is a GitError. Returns stdout without the trailing newline. */
export const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): Effect.Effect<string, GitError> =>
  Effect.flatMap(gitRun(cwd, args, env), (r) =>
    r.code === 0 ? Effect.succeed(r.stdout.replace(/\n$/, "")) : Effect.fail(new GitError({ args, message: (r.stderr || r.stdout).trim() })),
  )

/** git's well-known empty tree. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** Paths from a `-z` listing (no C-quoting, so non-ASCII names come through as they are). */
export const zPaths = (out: string) => out.split("\0").filter((p) => p.length > 0)

/** Files git reports as conflicted in `cwd`. */
export const conflictedFiles = (cwd: string) => Effect.map(git(cwd, ["diff", "--name-only", "-z", "--diff-filter=U"]), zPaths)

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m

/** True when any of `files` (relative to `cwd`) still contains a conflict marker line. */
export const hasConflictMarkers = (cwd: string, files: ReadonlyArray<string>) =>
  Effect.sync(() => files.some((f) => existsSync(join(cwd, f)) && MARKER.test(readFileSync(join(cwd, f), "utf8"))))
