import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { baseTree, EMPTY_TREE, snapshotAtTree, workingGraphTree } from "../src"
import { scenario, cleanup, repo, sh, state, write, writeNode } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("checkpoint", () => {
  test("the working graph tree includes uncommitted files and leaves the real index alone", async () => {
    const r = repo()
    expect(await run(workingGraphTree(r))).toBe(EMPTY_TREE)
    writeNode(r, state("ST-0001", "home"))
    const before = sh(r, "git status --porcelain")
    const tree = await run(workingGraphTree(r))
    expect(tree).not.toBe(EMPTY_TREE)
    expect(sh(r, "git status --porcelain")).toBe(before)
    sh(r, "git add -A && git commit -qm graph")
    expect(sh(r, "git rev-parse HEAD:.zarg/graph")).toBe(tree)
  })

  test("snapshotAtTree reads the nodes stored in a tree", async () => {
    const r = repo()
    writeNode(r, state("ST-0001", "home"))
    writeNode(r, scenario("S-0001", "ST-0001", "ST-0001"))
    const snap = await run(Effect.flatMap(workingGraphTree(r), (t) => snapshotAtTree(r, t)))
    expect([...snap.nodes.keys()].sort()).toEqual(["S-0001", "ST-0001"])
  })

  test("the base is the committed checkpoint, else the legacy sync.json commit, else empty", async () => {
    const r = repo()
    expect(await run(baseTree(r))).toBe(EMPTY_TREE)
    writeNode(r, state("ST-0001", "home"))
    sh(r, "git add -A && git commit -qm graph")
    const graphCommit = sh(r, "git rev-parse HEAD")
    const graphTree = sh(r, "git rev-parse HEAD:.zarg/graph")
    write(r, ".zarg/sync.json", JSON.stringify({ graph: graphCommit }))
    sh(r, "git add -A && git commit -qm legacy")
    expect(await run(baseTree(r))).toBe(graphTree)
    write(r, ".zarg/reconciled.json", JSON.stringify({ graph: EMPTY_TREE }))
    sh(r, "git add -A && git commit -qm checkpoint")
    expect(await run(baseTree(r))).toBe(EMPTY_TREE)
  })
})
