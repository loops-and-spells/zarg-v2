// packages/core/test/rehearse-service.test.ts
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { askFirst } from "../src/driver"
import { commitGraph, rehearseService } from "../src/rehearse/service"

const finding = (route: "fix" | "ask" | "drop") => ({ id: "R-0000000a", kind: "gap" as const, card: "UX-1", severity: "high" as const, notes: ["n"], count: 1, personas: ["dev"], real: 0.9, route })
const setup = (route: "fix" | "ask" | "drop", now: Record<string, unknown> | null = { card: "UX-1", given: "before UX-1", when: "do", thens: ["after"] }) => {
  const resolved: Array<[string, ReadonlyArray<string>, boolean]> = []
  const commits: Array<[ReadonlyArray<string>, string]> = []
  const guard = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
  const svc = rehearseService({
    rehearse: {
      start: () => Effect.succeed({ run: "r-1", stories: 1, steps: 2, personas: ["dev"] }),
      findingOf: (id: string) => (id === "R-0000000a" ? { run: "r-1", f: finding(route) } : undefined),
      markResolved: (run: string, ids: ReadonlyArray<string>, t: boolean) => void resolved.push([run, ids, t]),
    },
    guard,
    stepNow: () => Effect.succeed(now ?? undefined),
    commit: (ids, message) => Effect.sync(() => (commits.push([ids, message]), "abc123")),
  })
  return { svc, guard, resolved, commits }
}

describe("the driver's Rehearse service", () => {
  test("run starts a rehearsal and answers at once", async () => {
    expect(await Effect.runPromise(setup("fix").svc.handlers.run!({}) as Effect.Effect<unknown>)).toEqual({ run: "r-1", stories: 1, steps: 2, personas: ["dev"] })
  })

  test("fix opens graph writes for a fix finding; an ask or dropped finding is refused", async () => {
    const t = setup("fix")
    expect(await Effect.runPromise(t.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown>)).toMatchObject({ id: "R-0000000a", card: "UX-1" })
    const asked = setup("ask")
    expect(await Effect.runPromise(Effect.flip(asked.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown, { _tag: string }>))).toMatchObject({ _tag: "NotAFix" })
  })

  test("a finding whose card changed since the run is stale", async () => {
    const t = setup("fix", null)
    expect(await Effect.runPromise(Effect.flip(t.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown, { _tag: string }>))).toMatchObject({ _tag: "Stale" })
  })

  test("resolve commits the touched graph files with the finding ids and marks the run triaged", async () => {
    const t = setup("fix")
    const gated = t.guard.gate({ def: { name: "Gherkin" } as never, handlers: { addCard: () => Effect.succeed({ message: "ok", added: ["UX-0009"], changed: [], removed: [], warnings: [] }) } })!
    await Effect.runPromise(t.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown>)
    await Effect.runPromise(gated.handlers.addCard!({}))
    const out = await Effect.runPromise(t.svc.handlers.resolve!({ run: "r-1", applied: ["R-0000000a"], dismissed: [] }) as Effect.Effect<unknown>)
    expect(out).toEqual({ commit: "abc123" })
    expect(t.commits[0]).toEqual([["UX-0009"], "req: rehearse r-1: applied R-0000000a"])
    expect(t.resolved).toEqual([["r-1", ["R-0000000a"], true]])
  })

  test("resolve commits only the files the triage touched", async () => {
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
    writeFileSync(join(root, ".zarg", "graph", "nodes", "S-0099.json"), "{}\n") // the developer's own edit
    const sha = await Effect.runPromise(commitGraph(root, ["UX-0001"], "req: rehearse r-1: applied R-1"))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const files = new TextDecoder().decode(sh("show", "--name-only", "--format=", "HEAD").stdout).trim().split("\n")
    expect(files).toEqual([".zarg/graph/nodes/UX-0001.json"])
    expect(new TextDecoder().decode(sh("status", "--porcelain").stdout)).toContain("S-0099.json")
  })
})
