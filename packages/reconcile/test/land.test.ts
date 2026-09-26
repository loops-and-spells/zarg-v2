import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { ensureWorktree, land, rebaseOnto, worktreeRoot } from "../src"
import { card, cleanup, repo, sh, state, write, writeNode } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

/** A repo whose driver wrote S-0001 and UX-0001 (uncommitted), and a pass commit with those cards plus code. */
const passCommit = async () => {
  const r = repo()
  const base = sh(r, "git rev-parse HEAD")
  writeNode(r, state("S-0001", "home"))
  writeNode(r, card("UX-0001", "S-0001", "S-0001"))
  const wt = join(worktreeRoot(r), "p", "main")
  await run(ensureWorktree(r, wt, "zarg/p/main", base))
  writeNode(wt, state("S-0001", "home"))
  writeNode(wt, card("UX-0001", "S-0001", "S-0001"))
  write(wt, "src/home.ts", "export const home = 1\n")
  sh(wt, "git add -A && git commit -qm 'feat: implement UX-0001'")
  return { r, base, wt, commit: sh(wt, "git rev-parse HEAD") }
}

describe("land", () => {
  test("fast-forwards; the driver's identical uncommitted cards end up clean; landing again is a no-op", async () => {
    const { r, base, commit } = await passCommit()
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(sh(r, "git rev-parse HEAD")).toBe(commit)
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
  })

  test("your edits in other files stay; edits in a file the commit changes make it wait", async () => {
    const { r, base, commit } = await passCommit()
    write(r, "README.md", "mine\n")
    write(r, "src/home.ts", "my version\n")
    expect(await run(land(r, commit, base))).toEqual({ status: "waiting", paths: ["src/home.ts"] })
    expect(sh(r, "git rev-parse HEAD")).toBe(base)
    sh(r, "rm src/home.ts")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, "README.md"), "utf8")).toBe("mine\n")
  })

  test("a card the driver edited again keeps its newer content after landing", async () => {
    const { r, base, commit } = await passCommit()
    writeNode(r, card("UX-0001", "S-0001", "S-0001", "the user taps twice"))
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, ".zarg/graph/nodes/UX-0001.json"), "utf8")).toContain("taps twice")
    expect(sh(r, "git status --porcelain")).toBe("M .zarg/graph/nodes/UX-0001.json")
  })

  test("a card the driver removed during the pass stays removed", async () => {
    const { r, base, commit } = await passCommit()
    sh(r, "rm .zarg/graph/nodes/UX-0001.json")
    expect(await run(land(r, commit, base))).toEqual({ status: "landed" })
    expect(existsSync(join(r, ".zarg/graph/nodes/UX-0001.json"))).toBe(false)
  })

  test("a moved branch is reported; after a rebase the commit lands", async () => {
    const { r, base, wt } = await passCommit()
    sh(r, "rm -rf .zarg/graph")
    write(r, "notes.md", "yours\n")
    sh(r, "git add -A && git commit -qm yours")
    const head = sh(r, "git rev-parse HEAD")
    const moved = await run(land(r, sh(wt, "git rev-parse HEAD"), base))
    expect(moved).toEqual({ status: "moved", head })
    expect(await run(rebaseOnto(wt, head, () => Effect.succeed(false)))).toEqual({ ok: true })
    expect(await run(land(r, sh(wt, "git rev-parse HEAD"), head))).toEqual({ status: "landed" })
    expect(readFileSync(join(r, "notes.md"), "utf8")).toBe("yours\n")
    expect(existsSync(join(r, "src/home.ts"))).toBe(true)
  })

  test("a detached HEAD or a merge in progress refuses to land", async () => {
    const { r, base, commit } = await passCommit()
    sh(r, "git checkout -q --detach")
    expect((await run(land(r, commit, base))).status).toBe("refused")
  })
})
