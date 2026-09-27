import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Bound } from "@zarg/kernel"
import { askFirst } from "../src/driver"
import { stepHash } from "../src/rehearse/screen"
import { commitGraph, rehearseService } from "../src/rehearse/service"

const seen = { card: "UX-1", title: "Pay", given: "before UX-1", when: "do", thens: ["after"], fork: [], hasFailure: false }
const finding = (route: "fix" | "ask" | "drop") => ({ id: "R-0000000a", kind: "gap" as const, card: "UX-1", severity: "high" as const, notes: ["n"], count: 1, personas: ["dev"], real: 0.9, route, hash: stepHash(seen) })
const setup = (route: "fix" | "ask" | "drop", now: Record<string, unknown> | null = seen, touchedBefore: ReadonlyArray<string> = []) => {
  const resolved: Array<[string, ReadonlyArray<string>, boolean]> = []
  const commits: Array<[ReadonlyArray<string>, string]> = []
  const touched = new Set<string>(touchedBefore)
  const guard = askFirst({ ask: () => Effect.succeed({ choice: "a" }) })
  const svc = rehearseService({
    rehearse: {
      start: () => Effect.succeed({ run: "r-1", stories: 1, steps: 2, personas: ["dev"] }),
      findingOf: (id: string) => (id === "R-0000000a" ? { run: "r-1", f: finding(route) } : undefined),
      record: () => ({ touched: [...touched] }) as never,
      markTouched: (_run: string, ids: ReadonlyArray<string>) => void ids.forEach((i) => touched.add(i)),
      markResolved: (run: string, ids: ReadonlyArray<string>, t: boolean) => void resolved.push([run, ids, t]),
    },
    guard,
    stepNow: () => Effect.succeed(now ?? undefined),
    neighbors: () => Effect.succeed(["S-0001", "S-0002"]),
    commit: (ids, message) => Effect.sync(() => (commits.push([ids, message]), "abc123")),
  })
  return { svc, guard, resolved, commits }
}
const fix = (t: ReturnType<typeof setup>) => Effect.runPromise(t.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown>)
const writer = (t: ReturnType<typeof setup>, added: ReadonlyArray<string> = ["UX-0009"]) =>
  t.guard.gate({ def: { name: "Gherkin" } as never, handlers: { editCard: () => Effect.succeed({ message: "ok", added, changed: [], removed: [], warnings: [] }) } } as Bound)!

describe("the driver's Rehearse service", () => {
  test("run starts a rehearsal and answers at once", async () => {
    expect(await Effect.runPromise(setup("fix").svc.handlers.run!({}) as Effect.Effect<unknown>)).toEqual({ run: "r-1", stories: 1, steps: 2, personas: ["dev"] })
  })

  test("fix opens graph writes for a fix finding; an ask or dropped finding is refused", async () => {
    expect(await fix(setup("fix"))).toMatchObject({ id: "R-0000000a", card: "UX-1" })
    const asked = setup("ask")
    expect(await Effect.runPromise(Effect.flip(asked.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown, { _tag: string }>))).toMatchObject({ _tag: "NotAFix" })
  })

  test("a finding whose card is gone, or changed since the run, is stale", async () => {
    for (const now of [null, { ...seen, when: "do it differently" }]) {
      const t = setup("fix", now)
      expect(await Effect.runPromise(Effect.flip(t.svc.handlers.fix!({ finding: "R-0000000a" }) as Effect.Effect<unknown, { _tag: string }>))).toMatchObject({ _tag: "Stale" })
    }
  })

  test("a fix opens writes only for its card, its states and what the fix adds", async () => {
    const t = setup("fix")
    await fix(t)
    const w = writer(t)
    expect(await Effect.runPromise(w.handlers.editCard!({ id: "UX-1", when: "x" }))).toMatchObject({ added: ["UX-0009"] })
    expect(await Effect.runPromise(w.handlers.editCard!({ id: "UX-0009", given: "S-0001" }))).toMatchObject({ message: "ok" })
    expect(await Effect.runPromise(Effect.flip(w.handlers.editCard!({ id: "UX-0050", when: "x" })))).toMatchObject({ _tag: "OutsideFinding" })
  })

  test("resolve commits every node the run's fixes touched, even from an earlier driver item, and marks the run triaged", async () => {
    const t = setup("fix", seen, ["UX-0007"])
    await fix(t)
    await Effect.runPromise(writer(t).handlers.editCard!({ id: "UX-1" }))
    const out = await Effect.runPromise(t.svc.handlers.resolve!({ run: "r-1", applied: ["R-0000000a"], dismissed: [] }) as Effect.Effect<unknown>)
    expect(out).toEqual({ commit: "abc123" })
    expect(t.commits).toEqual([[["UX-0007", "UX-0009"], "req: rehearse r-1: applied R-0000000a"]])
    expect(t.resolved).toEqual([["r-1", ["R-0000000a"], true]])
  })

  test("resolve commits only the files the triage touched, and skips nodes that came and went", async () => {
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
    const sha = await Effect.runPromise(commitGraph(root, ["UX-0001", "UX-0077"], "req: rehearse r-1: applied R-1"))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const files = new TextDecoder().decode(sh("show", "--name-only", "--format=", "HEAD").stdout).trim().split("\n")
    expect(files).toEqual([".zarg/graph/nodes/UX-0001.json"])
    expect(new TextDecoder().decode(sh("status", "--porcelain").stdout)).toContain("S-0099.json")
  })
})
