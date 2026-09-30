import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = join(import.meta.dir, "../src/main.ts")
let dir = ""

const zargIn = (root: string, ...args: Array<string>) => {
  const p = Bun.spawnSync([process.execPath, main, ...args], { cwd: root, env: { ...process.env, ZARG_ROOT: root } })
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
    json("tool", "call", "gherkin/add-persona", JSON.stringify({ name: "User", kind: "human", text: "Someone using the product." }))
    const r = json("tool", "call", "gherkin/add-card", JSON.stringify({ title: "Open pricing", when: "the user clicks Pricing", by: [{ name: "User" }], arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] }))
    expect(r.message).toBe("created UX-0001; new states S-0002")
    expect(zarg("render").out).toContain("Then  the plan picker is shown  # S-0002")
  })

  // @card UX-0082
  test("audit: JSON with exit 1 while a card has no tag; --summary; a new file's tag counts", () => {
    const TAG = "@" + "card"
    const before = zarg("audit")
    expect(before.code).toBe(1)
    expect(JSON.parse(before.out).problems).toContainEqual({ kind: "untagged", card: "UX-0001", title: "Open pricing" })
    expect(zarg("audit", "--summary").out).toContain("untagged            UX-0001 Open pricing")
    // A new, untracked file's tag counts, and query code finds it.
    require("node:fs").writeFileSync(join(dir, "pricing.ts"), `export const open = () => 1 // ${TAG} UX-0001\n`)
    const mine = (JSON.parse(zarg("audit").out).problems as Array<{ card?: string }>).filter((p) => p.card === "UX-0001")
    expect(mine).toEqual([])
    expect(json("query", "code", "UX-0001")).toEqual([`pricing.ts:1:export const open = () => 1 // ${TAG} UX-0001`])
    expect(json("audit", "--card", "UX-0001")).toMatchObject({ id: "UX-0001", status: "built", tags: [{ file: "pricing.ts", line: 1 }] })
    require("node:fs").rmSync(join(dir, "pricing.ts"))
    // An unknown card: exit 1.
    const unknown = zarg("audit", "--card", "UX-9999")
    expect([unknown.code, JSON.parse(unknown.out)]).toEqual([1, { id: "UX-9999", missing: true }])
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
    // First-party plugins that read files or code wait for their grant (triage reads the code tagged with cards).
    expect(ids).toEqual(["plugin-grant:backlog", "plugin-grant:rehearse", "plugin-grant:triage", "gherkin:dead-end:S-0002"])
    expect(json("query", "neighbors", "S-0001", "--k", "1")).toEqual(["S-0001", "UX-0001"])
  })

  // @card UX-0081
  test("query code finds @card tags in tracked files", async () => {
    // Built from parts: this file holds no tag of its own.
    const tag = `// ${"@" + "card"} UX-0999`
    await Bun.write(join(dir, "app.ts"), `${tag}\n`)
    git("add", "app.ts")
    expect(json("query", "code", "UX-0999")).toEqual([`app.ts:1:${tag}`])
    expect(json("query", "code", "UX-0998")).toEqual([])
    // The second id on a tag line is found too.
    await Bun.write(join(dir, "two.ts"), `// ${"@" + "card"} UX-0997 UX-0996\n`)
    expect(json("query", "code", "UX-0996")).toEqual([`two.ts:1:// ${"@" + "card"} UX-0997 UX-0996`])
    require("node:fs").rmSync(join(dir, "two.ts"))
  })

  test("a malformed --expect is an error, not ignored", () => {
    const r = zarg("tool", "call", "gherkin/edit-state", '{"id":"S-0002","text":"x y"}', "--expect", "S-0002")
    expect(r.code).toBe(1)
    expect(JSON.parse(r.err).message).toContain("id@hash")
  })

  test("diff --since a ref without a graph reports everything as added; a bad ref is an error", () => {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    expect(json("diff", "--since", emptyTree).added.map((n: { id: string }) => n.id)).toEqual(["P-0001", "S-0001", "S-0002", "UX-0001"])
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

describe("zarg core", () => {
  test("start --headless runs a core until stop; status reports it", () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-core-cmd-"))
    Bun.spawnSync(["sh", "-c", `printf '# @defaultSensitive=false\\n# ---\\n' > .env.schema`], { cwd: root })
    try {
      expect(JSON.parse(zargIn(root, "core", "status").out)).toEqual({ running: false })
      const refused = zargIn(root, "core", "start")
      expect(refused.code).toBe(1)
      expect(refused.err).toContain("--headless")
      const started = zargIn(root, "core", "start", "--headless")
      expect(started.err).toBe("")
      const { pid, mode } = JSON.parse(started.out)
      expect(mode).toBe("headless")
      expect(JSON.parse(zargIn(root, "core", "status").out)).toMatchObject({ running: true, pid, mode: "headless", ready: true })
      expect(JSON.parse(zargIn(root, "core", "stop").out)).toEqual({ stopped: true })
      expect(JSON.parse(zargIn(root, "core", "status").out)).toEqual({ running: false })
    } finally {
      zargIn(root, "core", "stop")
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("zarg affected and checkpoint", () => {
  // @card UX-0080
  test("affected lists the cards to reconcile; checkpoint records the graph so nothing is left", () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-affected-"))
    const g = (...args: Array<string>) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root })
    g("init", "-q")
    try {
      zargIn(root, "tool", "call", "gherkin/add-state", '{"text":"the home page is shown","entry":true}')
      zargIn(root, "tool", "call", "gherkin/add-persona", JSON.stringify({ name: "User", kind: "human", text: "Someone using the product." }))
      zargIn(root, "tool", "call", "gherkin/add-card", JSON.stringify({ title: "Open pricing", when: "the user clicks Pricing", by: [{ name: "User" }], arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] }))
      const a = JSON.parse(zargIn(root, "affected").out)
      expect(a).toMatchObject({ cards: ["UX-0001"], removed: [] })
      const c = JSON.parse(zargIn(root, "checkpoint").out)
      expect(c.graph).toBe(a.graph)
      g("add", "-A")
      g("commit", "-qm", "feat: implement UX-0001")
      expect(JSON.parse(zargIn(root, "affected").out)).toMatchObject({ cards: [], removed: [] })
      // checkpoint stages what it wrote, and retires a legacy sync.json in the index too.
      Bun.write(join(root, ".zarg/sync.json"), "{}")
      g("add", "-A")
      g("commit", "-qm", "legacy")
      zargIn(root, "checkpoint")
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString()
      expect(status).toContain("D  .zarg/sync.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("zarg plugin", () => {
  test("grant --fs-read adds a folder grant for the plugin in this project, in the user's grants file", () => {
    const r = zarg("plugin", "grant", "gherkin", "--fs-read", "/mnt/zt-data")
    expect(r.code).toBe(0)
    const grants = JSON.parse(readFileSync(join(process.env.ZARG_USER_DIR!, "grants.json"), "utf8"))
    expect(grants[dir].gherkin.extra).toEqual([{ kind: "fs-read", glob: "/mnt/zt-data/**" }])
  })
  test("grant without flags shows the scopes and approves on y", () => {
    const p = Bun.spawnSync([process.execPath, main, "plugin", "grant", "gherkin"], { cwd: dir, env: { ...process.env, ZARG_ROOT: dir }, stdin: new TextEncoder().encode("y\n") })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain("Plugin gherkin asks for: change your graph")
    const grants = JSON.parse(readFileSync(join(process.env.ZARG_USER_DIR!, "grants.json"), "utf8"))
    expect(grants[dir].gherkin.digests.length).toBeGreaterThan(0)
  })
  test("grant for an unknown plugin fails", () => {
    const r = zarg("plugin", "grant", "zt-nope", "--net", "a.test")
    expect(r.code).toBe(1)
    expect(r.err).toContain("zt-nope")
  })
})
