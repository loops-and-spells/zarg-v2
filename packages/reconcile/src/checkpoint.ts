import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Node, Snapshot } from "@zarg/graph"
import { EMPTY_TREE, git, gitRun } from "./git"

export const GRAPH = ".zarg/graph"
export const CHECKPOINT = ".zarg/reconciled.json"
/** Phase 1's checkpoint: `{ "graph": "<commit sha>" }`. Read once as the base, removed by the first commit. */
export const LEGACY_CHECKPOINT = ".zarg/sync.json"

/**
 * The git tree id of the working `.zarg/graph`, including uncommitted and untracked files. Built in a
 * throwaway index, so the repository's own index is untouched.
 */
export const workingGraphTree = (repo: string) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "zarg-index-"))
    const env = { GIT_INDEX_FILE: join(dir, "index") }
    try {
      yield* git(repo, ["read-tree", "--empty"], env)
      if (!existsSync(join(repo, GRAPH))) return EMPTY_TREE
      yield* git(repo, ["add", "-A", "--", GRAPH], env)
      const listed = yield* git(repo, ["ls-files", "--", GRAPH], env)
      if (listed === "") return EMPTY_TREE
      return yield* git(repo, ["write-tree", `--prefix=${GRAPH}/`], env)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

const readAt = (repo: string, ref: string, path: string) =>
  Effect.map(gitRun(repo, ["show", `${ref}:${path}`]), (r) => (r.code === 0 ? r.stdout : undefined))

/** The graph tree the last landed pass reconciled, from HEAD (or the legacy checkpoint, or nothing yet). */
export const baseTree = (repo: string, ref = "HEAD") =>
  Effect.gen(function* () {
    const current = yield* readAt(repo, ref, CHECKPOINT)
    if (current !== undefined) {
      const tree = (JSON.parse(current) as { graph: string }).graph
      if ((yield* gitRun(repo, ["cat-file", "-e", `${tree}^{tree}`])).code === 0) return tree
      // The recorded tree is gone (a clone, or gc after a rebased landing): take the committed graph as reconciled.
      const committed = yield* gitRun(repo, ["rev-parse", `${ref}:${GRAPH}`])
      return committed.code === 0 ? committed.stdout.trim() : EMPTY_TREE
    }
    const legacy = yield* readAt(repo, ref, LEGACY_CHECKPOINT)
    if (legacy !== undefined) {
      const commit = (JSON.parse(legacy) as { graph: string }).graph
      const tree = yield* gitRun(repo, ["rev-parse", `${commit}:${GRAPH}`])
      if (tree.code === 0) return tree.stdout.trim()
    }
    return EMPTY_TREE
  })

/** Scenarios the last landed pass could not reconcile (they failed while others landed): still pending. */
export const pendingAt = (repo: string, ref = "HEAD") =>
  Effect.map(readAt(repo, ref, CHECKPOINT), (text): ReadonlyArray<string> => {
    if (text === undefined) return []
    const failed = (JSON.parse(text) as { failed?: unknown }).failed
    return Array.isArray(failed) ? failed.filter((x): x is string => typeof x === "string") : []
  })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Node))

/** The graph stored in git as tree `tree` (the contents of `.zarg/graph`). Undecodable nodes are skipped. */
export const snapshotAtTree = (repo: string, tree: string) =>
  Effect.gen(function* () {
    if (tree === EMPTY_TREE) return Snapshot.make([])
    const listing = yield* git(repo, ["ls-tree", "-r", "--name-only", tree, "--", "nodes"])
    const files = listing.split("\n").filter((f) => f.endsWith(".json"))
    const nodes = yield* Effect.forEach(files, (f) =>
      Effect.flatMap(git(repo, ["show", `${tree}:${f}`]), (text) => Effect.option(decode(text))),
    )
    return Snapshot.make(nodes.flatMap((n) => (n._tag === "Some" ? [n.value] : [])))
  })
