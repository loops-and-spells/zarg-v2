import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { card, cleanup, repo, sh, state, write, writeNode } from "./repo"
import { runPass, stubSpec } from "./stub-spec"

afterAll(cleanup)
const db = () => join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db")
const graph = (r: string, cards: ReadonlyArray<string>) => {
  writeNode(r, state("S-0001", "home"))
  for (const c of cards) writeNode(r, card(c, "S-0001", "S-0001"))
}

describe("reconcile pass", () => {
  test("lands one commit with the graph, plans, code and checkpoint; worktrees are removed", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const spec = stubSpec(r)
    const out = await runPass(spec, db())
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001", "UX-0002"], failed: [] })
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001, UX-0002\ninit")
    expect(sh(r, "git show --name-only --format= HEAD").split("\n").sort()).toEqual([
      ".zarg/graph/nodes/S-0001.json",
      ".zarg/graph/nodes/UX-0001.json",
      ".zarg/graph/nodes/UX-0002.json",
      ".zarg/plans/UX-0001.md",
      ".zarg/plans/UX-0002.md",
      ".zarg/reconciled.json",
      "src/UX-0001.ts",
      "src/UX-0002.ts",
    ])
    expect(JSON.parse(readFileSync(join(r, ".zarg/reconciled.json"), "utf8")).graph).toBe(sh(r, "git rev-parse HEAD:.zarg/graph"))
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(sh(r, "git worktree list").split("\n")).toHaveLength(1)
    expect(sh(r, "git branch --list 'zarg/*'")).toBe("")
  })

  test("a graph with nothing new to reconcile makes no commit", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    await runPass(stubSpec(r), db())
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "nothing" })
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
  })

  test("a changed card is re-planned and re-implemented; untouched cards are not", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    await runPass(stubSpec(r), db())
    writeNode(r, card("UX-0002", "S-0001", "S-0001", "the user taps twice"))
    const spec = stubSpec(r)
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["UX-0002"] })
    expect(spec.calls.filter((c) => c !== "verify")).toEqual(["plan UX-0002", "implement UX-0002"])
  })

  test("a blocked card becomes a finding; the other cards still land; the blocked card has no code", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const spec = stubSpec(r, { blocked: ["UX-0002"] })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(existsSync(join(r, "src/UX-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/graph/nodes/UX-0002.json"))).toBe(true)
    expect(spec.findings.list().map((f) => [f.kind, f.about])).toEqual([["blocked-card", ["UX-0002"]]])
  })

  test("cards that conflict: an obvious conflict is resolved, a major one becomes a finding", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const code = { "UX-0001": { file: "src/shared.ts", text: "a\n" }, "UX-0002": { file: "src/shared.ts", text: "b\n" } }
    const major = stubSpec(r, { code })
    expect(await runPass(major, db())).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(major.findings.list().map((f) => f.kind)).toEqual(["merge-conflict"])

    const r2 = repo()
    graph(r2, ["UX-0001", "UX-0002"])
    const obvious = stubSpec(r2, { code, resolve: (cwd) => (write(cwd, "src/shared.ts", "a\nb\n"), true) })
    expect(await runPass(obvious, db())).toMatchObject({ status: "landed", landed: ["UX-0001", "UX-0002"] })
    expect(readFileSync(join(r2, "src/shared.ts"), "utf8")).toBe("a\nb\n")
  })

  test("verify still failing after two fixes: a finding, nothing lands, the pass worktree is kept", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    const spec = stubSpec(r, { code: { "UX-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 2 })
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(spec, db())).toMatchObject({ status: "failed", failed: ["UX-0001"] })
    expect(spec.calls.filter((c) => c === "fix")).toHaveLength(2)
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["verify-failing"])
    expect(sh(r, "git worktree list").split("\n").length).toBeGreaterThan(1)

    const r2 = repo()
    graph(r2, ["UX-0001"])
    const fixed = stubSpec(r2, { code: { "UX-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 1 })
    expect(await runPass(fixed, db())).toMatchObject({ status: "landed" })
    expect(readFileSync(join(r2, "src/x.ts"), "utf8")).toBe("fixed\n")
  })

  test("your uncommitted edits in a file it changes: landing waits, then gives up with a finding", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    write(r, "src/UX-0001.ts", "mine\n")
    const spec = stubSpec(r, { landAttempts: 3 })
    expect(await runPass(spec, db())).toMatchObject({ status: "failed" })
    expect(spec.findings.list().map((f) => [f.kind, f.detail])).toEqual([["landing-blocked", "waiting on your uncommitted edits in src/UX-0001.ts"]])
    expect(readFileSync(join(r, "src/UX-0001.ts"), "utf8")).toBe("mine\n")
  })

  test("your branch moved during the pass: the commit is rebased, verified again and lands on top", async () => {
    const r = repo()
    graph(r, ["UX-0001"])
    let committed = false
    const spec = stubSpec(r, {
      during: () => {
        if (committed) return
        committed = true
        write(r, "notes.md", "yours\n")
        sh(r, "git add notes.md && git commit -qm yours")
      },
    })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed" })
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001\nyours\ninit")
    expect(spec.calls.filter((c) => c === "verify")).toHaveLength(2)
    expect(sh(r, "git status --porcelain")).toBe("")
  })

  test("a pass killed mid-way resumes after the last finished step", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    const file = db()
    const log = join(r, "..", `calls-${Date.now()}.log`)
    const script = join(import.meta.dir, "resume-fixture.ts")
    const first = Bun.spawnSync([process.execPath, script, r, file, log], { env: { ...process.env, CRASH_ON: "UX-0002" } })
    expect(first.exitCode).toBe(9)
    const second = Bun.spawnSync([process.execPath, script, r, file, log])
    expect(second.stdout.toString()).toContain('"status":"landed"')
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls.filter((c) => c === "plan UX-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement UX-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement UX-0002")).toHaveLength(2)
    expect(sh(r, "git log --format=%s")).toBe("feat: implement UX-0001, UX-0002\ninit")
  }, 30_000)

  test("a removed card's plan and code are deleted in the next pass", async () => {
    const r = repo()
    graph(r, ["UX-0001", "UX-0002"])
    await runPass(stubSpec(r), db())
    sh(r, "rm .zarg/graph/nodes/UX-0002.json")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "landed" })
    expect(existsSync(join(r, "src/UX-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/plans/UX-0002.md"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
  })
})
