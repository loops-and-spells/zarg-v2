import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { git, gitRun } from "./git"

/** Commit exactly these graph nodes' files (added, changed or removed); the operator's other edits stay out. */
export const commitGraph = (root: string, ids: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    // Only files there now or known to git: a node that was added and removed again has neither.
    const tracked = new Set((yield* git(root, ["ls-files", "--", ...ids.map((id) => `:(literal).zarg/graph/nodes/${id}.json`)])).split("\n").filter((l) => l.length > 0))
    const paths = ids.map((id) => `.zarg/graph/nodes/${id}.json`).filter((p) => existsSync(join(root, p)) || tracked.has(p)).map((p) => `:(literal)${p}`)
    if (paths.length === 0) return undefined
    yield* git(root, ["add", "-A", "--", ...paths])
    const staged = yield* gitRun(root, ["diff", "--cached", "--quiet", "--", ...paths])
    if (staged.code === 0) return undefined
    yield* git(root, ["commit", "-q", "-m", message, "--", ...paths])
    return yield* git(root, ["rev-parse", "HEAD"])
  })

/**
 * The graph's node files as they are now: `restore` puts touched ones back to exactly these bytes (the operator's
 * uncommitted work kept; a file that was not there removed), `dirty` names the touched ones that differed from HEAD
 * before (committing them would sweep the operator's edits into another commit).
 */
export const graphFiles = (root: string) =>
  Effect.gen(function* () {
    const dir = join(root, ".zarg", "graph", "nodes")
    const before = new Map<string, string>()
    for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []) before.set(f.slice(0, -5), readFileSync(join(dir, f), "utf8"))
    const path = (id: string) => join(dir, `${id}.json`)
    return {
      restore: (ids: ReadonlyArray<string>) =>
        Effect.sync(() => {
          for (const id of ids) {
            const was = before.get(id)
            if (was === undefined) rmSync(path(id), { force: true })
            else writeFileSync(path(id), was)
          }
        }),
      dirty: (ids: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const out: Array<string> = []
          for (const id of ids) {
            const was = before.get(id)
            if (was === undefined) continue
            const head = yield* gitRun(root, ["show", `HEAD:.zarg/graph/nodes/${id}.json`])
            if (head.code !== 0 || head.stdout !== was) out.push(id)
          }
          return out
        }),
    }
  })
