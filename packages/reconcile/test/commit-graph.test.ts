import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { commitGraph, graphFiles } from "../src"

describe("commitGraph", () => {
  test("commitGraph commits only the files the triage touched, and skips nodes that came and went", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-graph-commit-"))
    const sh = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root, env: process.env })
    sh("init", "-q")
    sh("config", "user.name", "zarg-test")
    sh("config", "user.email", "zarg-test@example.invalid")
    mkdirSync(join(root, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(join(root, ".zarg", "graph", "nodes", "C-0001.json"), "{}\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "base")
    writeFileSync(join(root, ".zarg", "graph", "nodes", "C-0001.json"), '{"changed":true}\n')
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0099.json"), "{}\n")
    const sha = await Effect.runPromise(commitGraph(root, ["C-0001", "C-0077"], "req: rehearse r-1: applied R-1"))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(new TextDecoder().decode(sh("show", "--name-only", "--format=", "HEAD").stdout).trim().split("\n")).toEqual([".zarg/graph/nodes/C-0001.json"])
    expect(new TextDecoder().decode(sh("status", "--porcelain").stdout)).toContain("S-0099.json")
  })
  test("graphFiles puts touched nodes back as they were before (the operator's uncommitted edits kept) and says which were dirty", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-graph-restore-"))
    const sh = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root, env: process.env })
    sh("init", "-q")
    sh("config", "user.name", "zarg-test")
    sh("config", "user.email", "zarg-test@example.invalid")
    const node = (id: string) => join(root, ".zarg", "graph", "nodes", `${id}.json`)
    mkdirSync(join(root, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(node("S-0001"), "{}\n")
    writeFileSync(node("S-0003"), "{}\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "base")
    // The operator's uncommitted work: an edit, and a node of their own.
    writeFileSync(node("S-0001"), '{"operator":true}\n')
    writeFileSync(node("C-0005"), '{"operator":true}\n')
    const before = await Effect.runPromise(graphFiles(root))
    // A plan changes those, adds one, and changes a clean one; then fails.
    writeFileSync(node("S-0001"), '{"plan":true}\n')
    writeFileSync(node("C-0005"), '{"plan":true}\n')
    writeFileSync(node("C-0009"), '{"plan":true}\n')
    writeFileSync(node("S-0003"), '{"plan":true}\n')
    expect(await Effect.runPromise(before.dirty(["S-0001", "C-0005", "C-0009", "S-0003"]))).toEqual(["S-0001", "C-0005"])
    await Effect.runPromise(before.restore(["S-0001", "C-0005", "C-0009", "S-0003"]))
    const read = (id: string) => Bun.file(node(id)).text()
    expect([await read("S-0001"), await read("C-0005"), await read("S-0003")]).toEqual(['{"operator":true}\n', '{"operator":true}\n', "{}\n"])
    expect(await Bun.file(node("C-0009")).exists()).toBe(false)
  })
})
