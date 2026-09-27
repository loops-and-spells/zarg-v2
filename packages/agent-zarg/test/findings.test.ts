import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Bound } from "@zarg/kernel"
import { askFirst } from "../src/driver"
import { chosenFindings } from "@zarg/core"
import { commitGraph, findingsService } from "../src/findings"

const answer = (over: Partial<{ chosen: boolean; stale: boolean }> = {}) => ({ run: "r-1", card: "UX-1", chosen: true, stale: false, notes: ["n"], ...over })
const setup = (found: ReturnType<typeof answer> | null = answer(), dir = mkdtempSync(join(tmpdir(), "zarg-findings-")), trusted = true) => {
  const calls: Array<[string, string, unknown]> = []
  const commits: Array<[ReadonlyArray<string>, string]> = []
  const guard = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
  const svc = findingsService({
    dir,
    invoke: (plugin, method, params) => Effect.sync(() => (calls.push([plugin, method, params]), method === "finding" ? found : null)),
    guard,
    chosen: chosenFindings(dir),
    trusted: () => trusted,
    neighbors: () => Effect.succeed(["S-0001", "S-0002"]),
    commit: (ids, message) => Effect.sync(() => (commits.push([ids, message]), "abc123")),
  })
  return { svc, guard, calls, commits, dir }
}
const take = (t: ReturnType<typeof setup>) => Effect.runPromise(t.svc.handlers.take!({ plugin: "rehearse", finding: "R-1" }) as Effect.Effect<unknown>)
const refused = (t: ReturnType<typeof setup>) => Effect.runPromise(Effect.flip(t.svc.handlers.take!({ plugin: "rehearse", finding: "R-1" }) as Effect.Effect<unknown, { _tag: string }>))
const writer = (t: ReturnType<typeof setup>, added: ReadonlyArray<string> = ["UX-0009"]) =>
  t.guard.gate({ def: { name: "Gherkin" } as never, handlers: { editCard: () => Effect.succeed({ message: "ok", added, changed: [], removed: [], warnings: [] }) } } as Bound)!

describe("the findings gate", () => {
  test("take opens graph writes for a finding the developer chose", async () => {
    const t = setup()
    expect(await take(t)).toMatchObject({ id: "R-1", card: "UX-1" })
    expect(t.calls[0]).toEqual(["rehearse", "finding", { id: "R-1" }])
  })

  test("a finding not chosen, stale, or unknown is refused", async () => {
    expect(await refused(setup(answer({ chosen: false })))).toMatchObject({ _tag: "NotChosen" })
    expect(await refused(setup(answer({ stale: true })))).toMatchObject({ _tag: "Stale" })
    expect(await refused(setup(null))).toMatchObject({ _tag: "NotFound" })
  })

  test("a plugin zarg does not ship cannot open writes by saying chosen: only the developer's recorded apply counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-findings-"))
    expect(await refused(setup(answer(), dir, false))).toMatchObject({ _tag: "NotChosen" })
    chosenFindings(dir).add("rehearse", ["R-1"])
    expect(await take(setup(answer(), dir, false))).toMatchObject({ id: "R-1" })
  })

  test("writes open only for the finding's card, its states and what the fix adds", async () => {
    const t = setup()
    await take(t)
    const w = writer(t)
    expect(await Effect.runPromise(w.handlers.editCard!({ id: "UX-1" }))).toMatchObject({ added: ["UX-0009"] })
    expect(await Effect.runPromise(w.handlers.editCard!({ id: "UX-0009", given: "S-0001" }))).toMatchObject({ message: "ok" })
    expect(await Effect.runPromise(Effect.flip(w.handlers.editCard!({ id: "UX-0050" })))).toMatchObject({ _tag: "OutsideFinding" })
  })

  test("resolve commits every node touched for the run, across driver items, and tells the plugin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zarg-findings-"))
    const first = setup(answer(), dir)
    await take(first)
    await Effect.runPromise(writer(first, ["UX-0007"]).handlers.editCard!({ id: "UX-1" }))
    const second = setup(answer(), dir)
    await take(second)
    await Effect.runPromise(writer(second).handlers.editCard!({ id: "UX-1" }))
    const out = await Effect.runPromise(second.svc.handlers.resolve!({ plugin: "rehearse", run: "r-1", applied: ["R-1"], dismissed: [] }) as Effect.Effect<unknown>)
    expect(out).toEqual({ commit: "abc123" })
    expect(second.commits).toEqual([[["UX-0007", "UX-0009"], "req: rehearse r-1: applied R-1"]])
    expect(second.calls.at(-1)).toEqual(["rehearse", "resolved", { run: "r-1", ids: ["R-1"] }])
  })

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
})
