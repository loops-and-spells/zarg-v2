import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = join(import.meta.dir, "../src/main.ts")
let dir = ""

const zargIn = (root: string, ...args: Array<string>) => {
  const p = Bun.spawnSync(["bun", main, ...args], { cwd: root, env: { ...process.env, ZARG_ROOT: root } })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const zarg = (...args: Array<string>) => zargIn(dir, ...args)
const json = (...args: Array<string>) => JSON.parse(zarg(...args).out)
const git = (...args: Array<string>) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zarg-cli-"))
  git("init", "-q")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("zarg cli", () => {
  // @card UX-0002
  test("tool call writes the graph and render shows it", () => {
    expect(json("tool", "call", "gherkin/add-state", '{"text":"the home page is shown","entry":true}').added).toEqual(["S-0001"])
    const r = json("tool", "call", "gherkin/add-card", JSON.stringify({ title: "Open pricing", when: "the user clicks Pricing", arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] }))
    expect(r.message).toBe("created UX-0001; new states S-0002")
    expect(zarg("render").out).toContain("Then  the plan picker is shown  # S-0002")
  })

  test("show returns the node, its hash and inbound edges", () => {
    const s = json("show", "S-0002")
    expect(s.node.props.text).toBe("the plan picker is shown")
    expect(s.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(s.inbound).toEqual([{ from: "UX-0001", type: "gherkin/then" }])
  })

  // @card UX-0003
  test("failures are JSON on stderr with exit code 1", () => {
    const r = zarg("tool", "call", "gherkin/add-state", '{"text":"shown if paid"}')
    expect(r.code).toBe(1)
    const e = JSON.parse(r.err)
    expect(e.error).toBe("LintFailed")
    expect(e.findings[0].code).toBe("conditional")
  })

  test("--expect rejects a stale hash", () => {
    const r = zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"plans are listed"}', "--expect", "S-0002@000000000000")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe("StaleNode")
  })

  // @card UX-0005
  test("diff --since compares a git ref with the working tree", () => {
    git("add", ".zarg")
    git("commit", "-qm", "graph")
    zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"the plans are listed"}')
    const d = json("diff", "--since", "HEAD")
    expect(d.changed.map((c: { id: string }) => c.id)).toEqual(["S-0002"])
    expect(d.added).toEqual([])
  })

  // @card UX-0001
  test("agenda and focus", () => {
    const ids = json("agenda").map((i: { id: string }) => i.id)
    expect(ids).toEqual(["gherkin:dead-end:S-0002"])
    expect(json("query", "neighbors", "S-0001", "--k", "1")).toEqual(["S-0001", "UX-0001"])
  })

  test("query code finds @card tags in tracked files", async () => {
    await Bun.write(join(dir, "app.ts"), "// @card UX-0999\n")
    git("add", "app.ts")
    expect(json("query", "code", "UX-0999")).toEqual(["app.ts:1:// @card UX-0999"])
    expect(json("query", "code", "UX-0998")).toEqual([])
  })

  test("a malformed --expect is an error, not ignored", () => {
    const r = zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"x y"}', "--expect", "S-0002")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).message).toContain("id@hash")
  })

  test("diff --since a ref without a graph reports everything as added; a bad ref is an error", () => {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    expect(json("diff", "--since", emptyTree).added.map((n: { id: string }) => n.id)).toEqual(["S-0001", "S-0002", "UX-0001"])
    const r = zarg("diff", "--since", "no-such-ref")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).error).toBe("IoError")
  })

  test("a broken node file shows up on the agenda and other commands keep working", async () => {
    await Bun.write(join(dir, ".zarg/graph/nodes/S-0099.json"), "{ broken")
    const ids = json("agenda").map((i: { id: string }) => i.id)
    expect(ids[0]).toContain("invalid-file:")
    expect(zarg("render").code).toBe(0)
    rmSync(join(dir, ".zarg/graph/nodes/S-0099.json"))
  })

  test("a damaged state that a card uses: render still works and new states get fresh ids", async () => {
    const file = join(dir, ".zarg/graph/nodes/S-0002.json")
    const saved = await Bun.file(file).text()
    await Bun.write(file, "{ broken")
    expect(zarg("render").out).toContain("<missing S-0002>")
    const r = json("tool", "call", "gherkin/add-state", '{"text":"an unrelated state"}')
    expect(r.added).toEqual(["S-0003"])
    expect(await Bun.file(file).text()).toBe("{ broken")
    await Bun.write(file, saved)
    zarg("tool", "call", "gherkin/remove", '{"id":"S-0003"}')
  })

  test("diff --since skips a damaged file at the ref and reports it", async () => {
    const file = join(dir, ".zarg/graph/nodes/S-0002.json")
    const saved = await Bun.file(file).text()
    await Bun.write(file, "{ broken")
    git("add", ".zarg")
    git("commit", "-qm", "damaged")
    await Bun.write(file, saved)
    const d = json("diff", "--since", "HEAD")
    expect(d.added.map((n: { id: string }) => n.id)).toEqual(["S-0002"])
    expect(d.problems.map((p: { file: string }) => p.file)).toEqual([".zarg/graph/nodes/S-0002.json"])
    git("add", ".zarg")
    git("commit", "-qm", "restored")
  })
})

test("diff --since works when ZARG_ROOT is a subdirectory of the git repo", () => {
  const top = mkdtempSync(join(tmpdir(), "zarg-sub-"))
  const sub = join(top, "app")
  const run = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: top })
  run("init", "-q")
  Bun.spawnSync(["mkdir", "-p", sub])
  zargIn(sub, "tool", "call", "gherkin/add-state", '{"text":"start"}')
  run("add", ".")
  run("commit", "-qm", "graph")
  zargIn(sub, "tool", "call", "gherkin/add-state", '{"text":"next"}')
  const r = zargIn(sub, "diff", "--since", "HEAD")
  rmSync(top, { recursive: true, force: true })
  expect(r.err).toBe("")
  expect(JSON.parse(r.out).added.map((n: { id: string }) => n.id)).toEqual(["S-0002"])
})
