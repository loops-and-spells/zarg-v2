import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { commitGraph, restoreGraph } from "../src"

describe("commitGraph", () => {
  test("commitGraph commits only the files the triage touched, and skips nodes that came and went", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-graph-commit-"))
    const sh = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root, env: process.env })
    sh("init", "-q")
    sh("config", "user.name", "zarg-test")
    sh("config", "user.email", "zarg-test@example.invalid")
    mkdirSync(join(root, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(join(root, ".zarg", "graph", "nodes", "UX-0001.json"), "{}\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "base")
    writeFileSync(join(root, ".zarg", "graph", "nodes", "UX-0001.json"), '{"changed":true}\n')
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0099.json"), "{}\n")
    const sha = await Effect.runPromise(commitGraph(root, ["UX-0001", "UX-0077"], "req: rehearse r-1: applied R-1"))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(new TextDecoder().decode(sh("show", "--name-only", "--format=", "HEAD").stdout).trim().split("\n")).toEqual([".zarg/graph/nodes/UX-0001.json"])
    expect(new TextDecoder().decode(sh("status", "--porcelain").stdout)).toContain("S-0099.json")
  })
  test("restoreGraph puts tracked nodes back and removes new ones; other files stay", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-graph-restore-"))
    const sh = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root, env: process.env })
    sh("init", "-q")
    sh("config", "user.name", "zarg-test")
    sh("config", "user.email", "zarg-test@example.invalid")
    mkdirSync(join(root, ".zarg", "graph", "nodes"), { recursive: true })
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0001.json"), "{}\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "base")
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0001.json"), '{"changed":true}\n')
    writeFileSync(join(root, ".zarg", "graph", "nodes", "UX-0009.json"), "{}\n")
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0002.json"), "{}\n")
    await Effect.runPromise(restoreGraph(root, ["S-0001", "UX-0009"]))
    expect(new TextDecoder().decode(sh("status", "--porcelain").stdout).trim()).toBe("?? .zarg/graph/nodes/S-0002.json")
  })
})
