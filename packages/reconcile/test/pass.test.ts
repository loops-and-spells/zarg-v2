import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { scenario, cleanup, repo, sh, state, write, writeNode } from "./repo"
import { runPass, runPasses, stubSpec } from "./stub-spec"

afterAll(cleanup)
const db = () => join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db")
const graph = (r: string, scenarios: ReadonlyArray<string>) => {
  writeNode(r, state("ST-0001", "home"))
  for (const c of scenarios) writeNode(r, scenario(c, "ST-0001", "ST-0001"))
}

describe("reconcile pass", () => {
  // @scenario S-0022 S-0056
  test("lands one commit with the graph, plans, code and checkpoint; worktrees are removed", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    const spec = stubSpec(r)
    const out = await runPass(spec, db())
    expect(out).toMatchObject({ status: "landed", landed: ["S-0001", "S-0002"], failed: [] })
    expect(sh(r, "git log --format=%s")).toBe("feat: implement S-0001, S-0002\ninit")
    expect(sh(r, "git show --name-only --format= HEAD").split("\n").sort()).toEqual([
      ".zarg/graph/nodes/S-0001.json",
      ".zarg/graph/nodes/S-0002.json",
      ".zarg/graph/nodes/ST-0001.json",
      ".zarg/plans/S-0001.md",
      ".zarg/plans/S-0002.md",
      ".zarg/reconciled.json",
      "src/S-0001.ts",
      "src/S-0002.ts",
    ])
    expect(JSON.parse(readFileSync(join(r, ".zarg/reconciled.json"), "utf8")).graph).toBe(sh(r, "git rev-parse HEAD:.zarg/graph"))
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(sh(r, "git worktree list").split("\n")).toHaveLength(1)
    expect(sh(r, "git branch --list 'zarg/*'")).toBe("")
  })

  test("a graph with nothing new to reconcile makes no commit", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    await runPass(stubSpec(r), db())
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "nothing" })
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
  })

  test("a changed scenario is re-planned and re-implemented; untouched scenarios are not", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    await runPass(stubSpec(r), db())
    writeNode(r, scenario("S-0002", "ST-0001", "ST-0001", "the user taps twice"))
    const spec = stubSpec(r)
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["S-0002"] })
    expect(spec.calls.filter((c) => c !== "verify")).toEqual(["plan S-0002", "implement S-0002"])
  })

  // @scenario S-0024
  test("a blocked scenario becomes a finding; the other scenarios still land; the blocked scenario has no code", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    const spec = stubSpec(r, { blocked: ["S-0002"] })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["S-0001"], failed: ["S-0002"] })
    expect(existsSync(join(r, "src/S-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/graph/nodes/S-0002.json"))).toBe(true)
    expect(spec.findings.list().map((f) => [f.kind, f.about])).toEqual([["blocked-scenario", ["S-0002"]]])
  })

  // @scenario S-0053 S-0054
  test("scenarios that conflict: an obvious conflict is resolved, a major one becomes a finding", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    const code = { "S-0001": { file: "src/shared.ts", text: "a\n" }, "S-0002": { file: "src/shared.ts", text: "b\n" } }
    const major = stubSpec(r, { code })
    expect(await runPass(major, db())).toMatchObject({ status: "landed", landed: ["S-0001"], failed: ["S-0002"] })
    expect(major.findings.list().map((f) => f.kind)).toEqual(["merge-conflict"])

    const r2 = repo()
    graph(r2, ["S-0001", "S-0002"])
    const obvious = stubSpec(r2, { code, resolve: (cwd) => (write(cwd, "src/shared.ts", "a\nb\n"), true) })
    expect(await runPass(obvious, db())).toMatchObject({ status: "landed", landed: ["S-0001", "S-0002"] })
    expect(readFileSync(join(r2, "src/shared.ts"), "utf8")).toBe("a\nb\n")
  })

  // @scenario S-0023 S-0055
  test("verify still failing after two fixes: a finding, nothing lands, the pass worktree is kept", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    const spec = stubSpec(r, { code: { "S-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 2 })
    const head = sh(r, "git rev-parse HEAD")
    expect(await runPass(spec, db())).toMatchObject({ status: "failed", failed: ["S-0001"] })
    expect(spec.calls.filter((c) => c === "fix")).toHaveLength(2)
    expect(sh(r, "git rev-parse HEAD")).toBe(head)
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["verify-failing"])
    expect(sh(r, "git worktree list").split("\n").length).toBeGreaterThan(1)

    const r2 = repo()
    graph(r2, ["S-0001"])
    const fixed = stubSpec(r2, { code: { "S-0001": { file: "src/x.ts", text: "BROKEN\n" } }, brokenFixes: 1 })
    expect(await runPass(fixed, db())).toMatchObject({ status: "landed" })
    expect(readFileSync(join(r2, "src/x.ts"), "utf8")).toBe("fixed\n")
  })

  // @scenario S-0050 S-0051
  test("your uncommitted edits in a file it changes: landing waits, then gives up with a finding", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    write(r, "src/S-0001.ts", "mine\n")
    const waits: Array<[ReadonlyArray<string>, number]> = []
    const spec = { ...stubSpec(r, { landAttempts: 3 }), onLandWait: (paths: ReadonlyArray<string>, attempt: number) => Effect.sync(() => void waits.push([paths, attempt])) }
    expect(await runPass(spec, db())).toMatchObject({ status: "failed" })
    expect(spec.findings.list().map((f) => [f.kind, f.detail])).toEqual([["landing-blocked", "waiting on your uncommitted edits in src/S-0001.ts"]])
    // While it waits, the operator is told which edits hold it, each try.
    expect(waits).toEqual([[["src/S-0001.ts"], 1], [["src/S-0001.ts"], 2]])
    expect(readFileSync(join(r, "src/S-0001.ts"), "utf8")).toBe("mine\n")
  })

  // @scenario S-0052
  test("your branch moved during the pass: the commit is rebased, verified again and lands on top", async () => {
    const r = repo()
    graph(r, ["S-0001"])
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
    expect(sh(r, "git log --format=%s")).toBe("feat: implement S-0001\nyours\ninit")
    expect(spec.calls.filter((c) => c === "verify")).toHaveLength(2)
    expect(sh(r, "git status --porcelain")).toBe("")
  })

  // @scenario S-0052
  test("requirements committed during the pass stay: the landed commit keeps them, the next pass takes them up", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    sh(r, "git add -A && git commit -qm req")
    let committed = false
    const spec = stubSpec(r, {
      during: () => {
        if (committed) return
        committed = true
        writeNode(r, scenario("S-0002", "ST-0001", "ST-0001"))
        sh(r, "git add -A && git commit -qm 'req: S-0002'")
      },
    })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["S-0001"] })
    expect(existsSync(join(r, ".zarg/graph/nodes/S-0002.json"))).toBe(true)
    expect(sh(r, "git show --name-only --format= HEAD")).not.toContain("S-0002")
    expect(sh(r, "git status --porcelain")).toBe("")
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["S-0002"] })
  })

  test("a pass killed mid-way resumes after the last finished step", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    const file = db()
    const log = join(r, "..", `calls-${Date.now()}.log`)
    const script = join(import.meta.dir, "resume-fixture.ts")
    const first = Bun.spawnSync([process.execPath, script, r, file, log], { env: { ...process.env, CRASH_ON: "S-0002" } })
    expect(first.exitCode).toBe(9)
    const second = Bun.spawnSync([process.execPath, script, r, file, log])
    expect(second.stdout.toString()).toContain('"status":"landed"')
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls.filter((c) => c === "plan S-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement S-0001")).toHaveLength(1)
    expect(calls.filter((c) => c === "implement S-0002")).toHaveLength(2)
    expect(sh(r, "git log --format=%s")).toBe("feat: implement S-0001, S-0002\ninit")
  }, 30_000)

  test("a scenario whose phase dies fails alone with a finding; the others land", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    const spec = stubSpec(r, { implementDies: ["S-0002"] })
    expect(await runPass(spec, db())).toMatchObject({ status: "landed", landed: ["S-0001"], failed: ["S-0002"] })
    expect(spec.findings.list().map((f) => [f.kind, f.about])).toEqual([["pass-error", ["S-0002"]]])
  })

  test("a scenario that failed while others landed stays pending: the next pass takes it up with no graph change", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    expect(await runPass(stubSpec(r, { implementDies: ["S-0002"] }), db())).toMatchObject({ status: "landed", landed: ["S-0001"], failed: ["S-0002"] })
    expect(JSON.parse(sh(r, "git show HEAD:.zarg/reconciled.json")).failed).toEqual(["S-0002"])
    // Nothing in the graph changed: S-0002 still lands, and nothing is pending after.
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "landed", landed: ["S-0002"] })
    expect(JSON.parse(sh(r, "git show HEAD:.zarg/reconciled.json")).failed).toBeUndefined()
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "nothing" })
  })

  test("a pass that dies ends as failed with a finding; the next attempt runs it again", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    const file = db()
    const spec = stubSpec(r, { verifyDies: 1 })
    expect(await runPass(spec, file, 0)).toMatchObject({ status: "failed" })
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["pass-error"])
    expect(await runPass(spec, file, 0)).toMatchObject({ status: "failed" })
    expect(await runPass(spec, file, 1)).toMatchObject({ status: "landed" })
  })

  test("a plan that fails after writing a partial file leaves nothing in the commit", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    expect(await runPass(stubSpec(r, { planFails: ["S-0002"] }), db())).toMatchObject({ landed: ["S-0001"], failed: ["S-0002"] })
    expect(existsSync(join(r, ".zarg/plans/S-0002.md"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
  })

  test("two passes on one repository never run at the same time", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    const file = db()
    const spec = stubSpec(r)
    let active = 0
    let max = 0
    const slow = { ...spec, phases: spec.phases.map((p) => ({ ...p, run: (item: string, cwd: string) => Effect.gen(function* () { active++; max = Math.max(max, active); yield* Effect.sleep(100); const out = yield* p.run(item, cwd); active--; return out }) })) }
    const results = await runPasses(slow, file, [0, 1])
    expect(max).toBe(1)
    expect(results.map((x) => x.status).sort()).toEqual(["landed", "nothing"])
  })

  test("stop ends a running pass at once: nothing lands, no findings, and it does not resume", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    const spec = stubSpec(r)
    let requested = false
    let release: () => void = () => {}
    const signal = new Promise<void>((resolve) => (release = resolve))
    const stoppable = {
      ...spec,
      stop: { requested: () => requested, wait: Effect.promise(() => signal) },
      phases: spec.phases.map((p) => (p.name === "implement" ? { ...p, run: (item: string, cwd: string) => Effect.andThen(Effect.sleep("30 seconds"), p.run(item, cwd)) } : p)),
    }
    const file = db()
    const t0 = Date.now()
    const running = runPass(stoppable, file)
    await Bun.sleep(1000)
    requested = true
    release()
    expect(await running).toMatchObject({ status: "failed" })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(sh(r, "git log --format=%s")).toBe("init")
    expect(spec.findings.list()).toEqual([])
    expect(await runPass(stoppable, file)).toMatchObject({ status: "failed" })
  }, 20_000)

  test("a phase that edits and commits requirements or plans cannot change them in the landed commit", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    const original = readFileSync(join(r, ".zarg/graph/nodes/ST-0001.json"), "utf8")
    const spec = stubSpec(r)
    const tamper = {
      ...spec,
      phases: spec.phases.map((p) =>
        p.name === "implement"
          ? {
              ...p,
              protect: [".zarg"],
              run: (item: string, cwd: string) =>
                Effect.andThen(p.run(item, cwd), Effect.sync(() => {
                  write(cwd, ".zarg/graph/nodes/ST-0001.json", "tampered\n")
                  write(cwd, `.zarg/plans/${item}.md`, "tampered\n")
                  write(cwd, ".zarg/graph/nodes/S-9999.json", "new\n")
                  sh(cwd, "git add -A && git commit -qm sneaky")
                  return { ok: true } as const
                })),
            }
          : p,
      ),
    }
    expect(await runPass(tamper, db())).toMatchObject({ status: "landed" })
    expect(sh(r, "git show HEAD:.zarg/graph/nodes/ST-0001.json")).toBe(original.trim())
    expect(sh(r, "git show HEAD:.zarg/plans/S-0001.md")).toBe("# S-0001")
    expect(sh(r, "git ls-tree -r --name-only HEAD -- .zarg/graph")).not.toContain("S-9999")
  })

  test("a stop while landing waits on your edits ends the pass even after your edits go away", async () => {
    const r = repo()
    graph(r, ["S-0001"])
    write(r, "src/S-0001.ts", "mine\n")
    const spec = stubSpec(r, { landAttempts: 50 })
    let requested = false
    let release: () => void = () => {}
    const signal = new Promise<void>((resolve) => (release = resolve))
    const running = runPass({ ...spec, landRetry: "300 millis", stop: { requested: () => requested, wait: Effect.promise(() => signal) } }, db())
    await Bun.sleep(1500)
    requested = true
    release()
    sh(r, "rm src/S-0001.ts")
    expect(await running).toMatchObject({ status: "failed" })
    expect(sh(r, "git log --format=%s")).toBe("init")
  }, 20_000)

  test("a removed scenario's plan and code are deleted in the next pass", async () => {
    const r = repo()
    graph(r, ["S-0001", "S-0002"])
    await runPass(stubSpec(r), db())
    sh(r, "rm .zarg/graph/nodes/S-0002.json")
    expect(await runPass(stubSpec(r), db())).toMatchObject({ status: "landed" })
    expect(existsSync(join(r, "src/S-0002.ts"))).toBe(false)
    expect(existsSync(join(r, ".zarg/plans/S-0002.md"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
  })
})
