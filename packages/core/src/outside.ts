import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Semaphore } from "effect"
import type { ServiceFailure } from "@zarg/kernel"
import { deniedPath, type Grants } from "@zarg/plugin/runtime"
import type { Answer, Question } from "@zarg/rlm"

/** Agents' grants sit with the plugins' in grants.json, under a name no plugin can have. */
const AGENTS = "zarg:agents"

const notAllowed = (message: string): ServiceFailure => ({ _tag: "NotAllowed", message })

/** The folder an "always" answer covers: the repository the path is in, or its own folder. */
const folderOf = (path: string) => {
  for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return dir
  return existsSync(path) && statSync(path).isDirectory() ? path : dirname(path)
}

const covers = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/** The root, a top-level folder (/home, /etc), the home folder or anything above it: never offered. */
const tooBroad = (path: string) => {
  const home = process.env.HOME
  return path.split("/").filter((p) => p.length > 0).length <= 1 || (home !== undefined && (path === home || home.startsWith(`${path}/`)))
}

/**
 * Whether an agent may read a real path outside the repository: never for zarg's own state, git internals,
 * keys and env files; yes under a folder the developer always allowed; otherwise the developer is asked
 * (once, always for the path's repository, or deny). One question at a time: reads that arrive together
 * wait for it, and an "always" answer lets them through.
 */
export const outsideReads = (opts: {
  readonly grants: Grants
  readonly userDir: string
  readonly ask: (q: Question) => Effect.Effect<Answer, ServiceFailure>
  /** YOLO: reads pass without a question and nothing is saved (never-readable and too-broad paths still refused). */
  readonly yolo?: () => boolean
}) => {
  const asking = Semaphore.makeUnsafe(1)
  const allowed = (path: string) =>
    Effect.map(opts.grants.of(AGENTS, ""), (g) => g.extra.some((x) => x.kind === "fs-read" && covers(x.glob.replace(/\/\*\*$/, ""), path)))
  return (path: string): Effect.Effect<void, ServiceFailure> =>
    Effect.gen(function* () {
      if (deniedPath(path, opts.userDir)) return yield* Effect.fail(notAllowed(`${path} is never readable by agents`))
      if (tooBroad(path)) return yield* Effect.fail(notAllowed(`${path} is too broad: read a file or a project folder inside it`))
      if (yield* allowed(path)) return
      if (opts.yolo?.() === true) return
      yield* Semaphore.withPermits(asking, 1)(
        Effect.gen(function* () {
          // Asked and answered "always" while this read waited.
          if (yield* allowed(path)) return
          const folder = folderOf(path)
          // A folder too broad to allow for good (a file straight in /tmp or the home folder) is only offered once.
          const always = tooBroad(folder) ? [] : [{ id: "always", label: `Always allow ${folder}`, recommended: true, why: "reads in that folder stop asking" }]
          const a = yield* opts.ask({
            question: `An agent wants to read ${path}, outside this repository.`,
            options: [{ id: "once", label: "Allow once" }, ...always, { id: "deny", label: "Deny" }],
            allowOther: false,
          })
          if (a.choice === "always") return yield* opts.grants.add(AGENTS, { kind: "fs-read", glob: `${folder}/**` })
          if (a.choice !== "once") return yield* Effect.fail(notAllowed(`the developer did not allow reading ${path}`))
        }),
      )
    })
}
