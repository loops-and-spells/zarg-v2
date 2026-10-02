import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { ensureWorktree, gcPasses, mergeBranches, removeWorktree, worktreeRoot } from "../src"
import { cleanup, repo, sh, write } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("worktrees", () => {
  test("ensure creates, then resets an existing worktree to its base; the repo never sees it", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const wt = join(worktreeRoot(r), "p1", "main")
    await run(ensureWorktree(r, wt, "zarg/p1/main", base))
    write(wt, "README.md", "changed\n")
    write(wt, "junk.txt", "x")
    await run(ensureWorktree(r, wt, "zarg/p1/main", base))
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("hello\n")
    expect(existsSync(join(wt, "junk.txt"))).toBe(false)
    expect(sh(r, "git status --porcelain")).toBe("")
    await run(removeWorktree(r, wt, "zarg/p1/main"))
    expect(existsSync(wt)).toBe(false)
    expect(sh(r, "git branch --list 'zarg/*'")).toBe("")
  })
})

describe("concurrent worktrees", () => {
  test("many worktrees created at once in one repository all succeed", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    for (let round = 0; round < 3; round++) {
      const names = Array.from({ length: 8 }, (_, i) => `r${round}-${i}`)
      await run(Effect.all(names.map((n) => ensureWorktree(r, join(worktreeRoot(r), "c", n), `zarg/c/${n}`, base)), { concurrency: "unbounded" }))
      for (const n of names) expect(existsSync(join(worktreeRoot(r), "c", n, "README.md"))).toBe(true)
    }
  }, 30_000)
})

describe("gcPasses", () => {
  test("keeps the newest passes' worktrees and removes the rest with their branches", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    for (const p of ["p1", "p2", "p3", "p4"]) {
      await run(ensureWorktree(r, join(worktreeRoot(r), p, "main"), `zarg/${p}/main`, base))
      await Bun.sleep(20)
    }
    await run(gcPasses(r, 3, (p, name) => `zarg/${p}/${name}`))
    expect(existsSync(join(worktreeRoot(r), "p1"))).toBe(false)
    expect(["p2", "p3", "p4"].every((p) => existsSync(join(worktreeRoot(r), p, "main")))).toBe(true)
    expect(sh(r, "git branch --list 'zarg/p1/*'")).toBe("")
  })
})

describe("mergeBranches", () => {
  const setup = () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const make = async (name: string, file: string, text: string) => {
      const wt = join(worktreeRoot(r), "p", name)
      await run(ensureWorktree(r, wt, `zarg/p/${name}`, base))
      write(wt, file, text)
      sh(wt, `git add -A && git commit -qm ${name}`)
    }
    return { r, base, make }
  }

  test("independent branches merge cleanly", async () => {
    const { r, base, make } = setup()
    await make("a", "a.ts", "a\n")
    await make("b", "b.ts", "b\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b"], () => Effect.succeed(false)))
    expect(out).toEqual({ merged: ["zarg/p/a", "zarg/p/b"], failed: [] })
    expect(existsSync(join(main, "a.ts")) && existsSync(join(main, "b.ts"))).toBe(true)
  })

  // @card S-0053 S-0054
  test("a conflict the resolver fixes is committed; one it cannot fix is aborted and reported", async () => {
    const { r, base, make } = setup()
    await make("a", "README.md", "from a\n")
    await make("b", "README.md", "from b\n")
    await make("c", "README.md", "from c\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const seen: Array<string> = []
    const out = await run(
      mergeBranches(main, ["zarg/p/a", "zarg/p/b", "zarg/p/c"], (c) =>
        Effect.sync(() => {
          seen.push(`${c.branch}:${c.files.join(",")}`)
          if (c.branch === "zarg/p/b") writeFileSync(join(main, "README.md"), "from a and b\n")
          return c.branch === "zarg/p/b"
        }),
      ),
    )
    expect(seen).toEqual(["zarg/p/b:README.md", "zarg/p/c:README.md"])
    expect(out.merged).toEqual(["zarg/p/a", "zarg/p/b"])
    expect(out.failed).toEqual([{ branch: "zarg/p/c", files: ["README.md"] }])
    expect(readFileSync(join(main, "README.md"), "utf8")).toBe("from a and b\n")
    expect(sh(main, "git status --porcelain")).toBe("")
  })

  test("a resolver that claims success but leaves conflict markers is treated as a failure", async () => {
    const { r, base, make } = setup()
    await make("a", "README.md", "from a\n")
    await make("b", "README.md", "from b\n")
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b"], () => Effect.succeed(true)))
    expect(out.failed.map((c) => c.branch)).toEqual(["zarg/p/b"])
    expect(readFileSync(join(main, "README.md"), "utf8")).toBe("from a\n")
  })
})
