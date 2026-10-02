import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { baseTree, ensureWorktree, land, makeFindings, mergeBranches, rebaseOnto, worktreeRoot } from "../src"
import { scenario, cleanup, repo, sh, state, write, writeNode } from "./repo"

afterAll(cleanup)
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const exit = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(e))
const node = (r: string, id: string) => join(r, ".zarg/graph/nodes", `${id}.json`)

/** A pass worktree on `base` with one squash commit made by `edit`. */
const passOn = async (r: string, base: string, edit: (wt: string) => void) => {
  const wt = join(worktreeRoot(r), "p", "main")
  await run(ensureWorktree(r, wt, "zarg/p/main", base))
  edit(wt)
  sh(wt, "git add -A && git commit -qm 'feat: implement'")
  return { wt, commit: sh(wt, "git rev-parse HEAD") }
}

describe("review: rebasing and branches", () => {
  test("an amended commit during the pass is not brought back by the rebase", async () => {
    const r = repo()
    write(r, "secret.txt", "s\n")
    write(r, "work.txt", "w\n")
    sh(r, "git add -A && git commit -qm work")
    const base = sh(r, "git rev-parse HEAD")
    const { wt, commit } = await passOn(r, base, (wt) => write(wt, "src/a.ts", "a\n"))
    sh(r, "git rm -q secret.txt && git commit -q --amend -m work")
    const moved = await run(land(r, commit, base, "main"))
    expect(moved.status).toBe("moved")
    const head = sh(r, "git rev-parse HEAD")
    expect(await run(rebaseOnto(wt, head, base, () => Effect.succeed(false)))).toEqual({ ok: true })
    expect(await run(land(r, sh(wt, "git rev-parse HEAD"), head, "main"))).toEqual({ status: "landed" })
    expect(existsSync(join(r, "secret.txt"))).toBe(false)
    expect(sh(r, "git show --name-only --format= HEAD")).toBe("src/a.ts")
  })

  test("landing refuses when you switched to another branch", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const { commit } = await passOn(r, base, (wt) => write(wt, "src/a.ts", "a\n"))
    sh(r, "git switch -q -c other")
    const out = await run(land(r, commit, base, "main"))
    expect(out.status).toBe("refused")
    expect(sh(r, "git rev-parse HEAD")).toBe(base)
  })

  test("a rebase conflict in graph files takes your committed version", async () => {
    const r = repo()
    writeNode(r, state("ST-0001", "home"))
    writeNode(r, scenario("S-0001", "ST-0001", "ST-0001", "v0"))
    sh(r, "git add -A && git commit -qm graph")
    const base = sh(r, "git rev-parse HEAD")
    const { wt } = await passOn(r, base, (wt) => {
      writeNode(wt, scenario("S-0001", "ST-0001", "ST-0001", "v1"))
      write(wt, "src/a.ts", "a\n")
    })
    writeNode(r, scenario("S-0001", "ST-0001", "ST-0001", "v2"))
    sh(r, "git add -A && git commit -qm yours")
    const head = sh(r, "git rev-parse HEAD")
    expect(await run(rebaseOnto(wt, head, base, () => Effect.succeed(false)))).toEqual({ ok: true })
    expect(readFileSync(node(wt, "S-0001"), "utf8")).toContain("v2")
    expect(existsSync(join(wt, "src/a.ts"))).toBe(true)
  })
})

describe("review: landing never loses the driver's scenarios", () => {
  test("a renamed file with your edits blocks landing; the driver's newer scenario is untouched", async () => {
    const r = repo()
    write(r, "src/old.ts", "old\n")
    sh(r, "git add -A && git commit -qm old")
    const base = sh(r, "git rev-parse HEAD")
    const { commit } = await passOn(r, base, (wt) => {
      sh(wt, "git mv src/old.ts src/new.ts")
      writeNode(wt, scenario("S-0001", "ST-0001", "ST-0001", "v1"))
    })
    write(r, "src/old.ts", "my edit\n")
    writeNode(r, scenario("S-0001", "ST-0001", "ST-0001", "v2"))
    const out = await run(land(r, commit, base, "main"))
    expect(out).toEqual({ status: "waiting", paths: ["src/old.ts"] })
    expect(readFileSync(node(r, "S-0001"), "utf8")).toContain("v2")
  })

  test("a landing that fails part-way puts the driver's scenarios back", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const { commit } = await passOn(r, base, (wt) => writeNode(wt, scenario("S-0001", "ST-0001", "ST-0001", "v1")))
    writeNode(r, scenario("S-0001", "ST-0001", "ST-0001", "v2"))
    writeFileSync(join(r, ".git/index.lock"), "")
    const out = await exit(land(r, commit, base, "main"))
    rmSync(join(r, ".git/index.lock"))
    expect(out._tag).toBe("Failure")
    expect(readFileSync(node(r, "S-0001"), "utf8")).toContain("v2")
  })

  test("a landing killed after the fast-forward restores the saved scenarios on its re-run", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const { commit } = await passOn(r, base, (wt) => writeNode(wt, scenario("S-0001", "ST-0001", "ST-0001", "v1")))
    const saved = JSON.stringify(scenario("S-0001", "ST-0001", "ST-0001", "v2"))
    sh(r, `git merge -q --ff-only ${commit}`)
    const manifest = join(r, ".zarg/reconcile/landing", `${commit}.json`)
    mkdirSync(join(manifest, ".."), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ ".zarg/graph/nodes/S-0001.json": `${saved}\n` }))
    expect(await run(land(r, commit, base, "main"))).toEqual({ status: "landed" })
    expect(readFileSync(node(r, "S-0001"), "utf8")).toContain("v2")
    expect(existsSync(manifest)).toBe(false)
  })
})

describe("review: merges", () => {
  const setup = async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const make = async (name: string, file: string, text: string) => {
      const wt = join(worktreeRoot(r), "p", name)
      await run(ensureWorktree(r, wt, `zarg/p/${name}`, base))
      write(wt, file, text)
      sh(wt, `git add -A && git commit -qm ${name}`)
    }
    const main = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, main, "zarg/p/main", base))
    return { r, base, make, main }
  }

  test("non-ASCII conflicted files: the resolver gets the real path, and leftover markers are caught", async () => {
    const { make, main } = await setup()
    await make("a", "src/café.ts", "from a\n")
    await make("b", "src/café.ts", "from b\n")
    const seen: Array<ReadonlyArray<string>> = []
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b"], (c) => Effect.sync(() => (seen.push(c.files), true))))
    expect(seen).toEqual([["src/café.ts"]])
    expect(out.failed.map((c) => c.branch)).toEqual(["zarg/p/b"])
    expect(readFileSync(join(main, "src/café.ts"), "utf8")).toBe("from a\n")
  })

  test("a leftover >>>>>>> line alone still counts as unresolved", async () => {
    const { make, main } = await setup()
    await make("a", "README.md", "from a\n")
    await make("b", "README.md", "from b\n")
    const out = await run(
      mergeBranches(main, ["zarg/p/a", "zarg/p/b"], () => Effect.sync(() => (writeFileSync(join(main, "README.md"), "merged\n>>>>>>> zarg/p/b\n"), true))),
    )
    expect(out.failed.map((c) => c.branch)).toEqual(["zarg/p/b"])
  })

  test("a merge interrupted mid-conflict is redone from the pass head", async () => {
    const { base, make, main } = await setup()
    await make("a", "a.ts", "a\n")
    await make("b", "b.ts", "b\n")
    await make("c", "a.ts", "c\n")
    sh(main, "git merge -q --no-ff --no-edit zarg/p/a")
    Bun.spawnSync(["git", "merge", "--no-ff", "--no-edit", "zarg/p/c"], { cwd: main })
    const out = await run(mergeBranches(main, ["zarg/p/a", "zarg/p/b", "zarg/p/c"], () => Effect.succeed(false), base))
    expect(out.merged).toEqual(["zarg/p/a", "zarg/p/b"])
    expect(out.failed.map((c) => c.branch)).toEqual(["zarg/p/c"])
  })
})

describe("review: repository hygiene", () => {
  test("a checkpoint whose tree git no longer has falls back to the committed graph", async () => {
    const r = repo()
    writeNode(r, state("ST-0001", "home"))
    write(r, ".zarg/reconciled.json", JSON.stringify({ graph: "0123456789abcdef0123456789abcdef01234567" }))
    sh(r, "git add -A && git commit -qm graph")
    expect(await run(baseTree(r))).toBe(sh(r, "git rev-parse HEAD:.zarg/graph"))
  })

  test("findings never show up in your git status, even before any pass ran", () => {
    const r = repo()
    makeFindings(r).raise({ kind: "pass-error", title: "t", detail: "d", about: [], pass: "" })
    expect(sh(r, "git status --porcelain")).toBe("")
  })

  test("a worktree whose directory was deleted (git clean -fdx) is recreated", async () => {
    const r = repo()
    const base = sh(r, "git rev-parse HEAD")
    const wt = join(worktreeRoot(r), "p", "main")
    await run(ensureWorktree(r, wt, "zarg/p/main", base))
    rmSync(join(r, ".zarg/reconcile"), { recursive: true, force: true })
    await run(ensureWorktree(r, wt, "zarg/p/main", base))
    expect(existsSync(join(wt, "README.md"))).toBe(true)
  })
})
