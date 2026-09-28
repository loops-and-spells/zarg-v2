import { existsSync } from "node:fs"
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
