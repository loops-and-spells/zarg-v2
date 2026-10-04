import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"
import { audit, parseTags, summary, tags } from "../src/index"

// Built from parts, so this file holds no tag of its own.
const TAG = "@" + "scenario"
const scenario = (id: string, props: Record<string, unknown> = {}) => ({ id, type: "gherkin/scenario", props: { title: `scenario ${id}`, when: "w", ...props }, edges: [] })
const snap = Snapshot.make([scenario("S-0001"), scenario("S-0002", { planned: true }), scenario("S-0003"), scenario("S-0004", { planned: true }), { id: "ST-0001", type: "gherkin/state", props: { text: "s" }, edges: [] }])

describe("the scenario audit", () => {
  test("parseTags: file, line and every id a tag names", () => {
    expect(parseTags([`src/a.ts:3:// ${TAG} S-0001`, `src/b.ts:10:  foo() // ${TAG} S-0003 S-0004`, `README.md:1:<!-- ${TAG} S-0003 -->`].join("\n"))).toEqual([
      { id: "S-0001", file: "src/a.ts", line: 3 },
      { id: "S-0003", file: "src/b.ts", line: 10 },
      { id: "S-0004", file: "src/b.ts", line: 10 },
      { id: "S-0003", file: "README.md", line: 1 },
    ])
  })
  test("parseTags: git grep -z output keeps a path with :digits: whole", () => {
    expect(parseTags(`a:1:b.ts\u00007\u0000// ${TAG} S-0001`)).toEqual([{ id: "S-0001", file: "a:1:b.ts", line: 7 }])
  })
  test("parseTags: a line with the mark twice names both scenarios", () => {
    expect(parseTags(`src/live.ts:201:    // ${TAG} S-0058 ${TAG} S-0059`).map((t) => t.id)).toEqual(["S-0058", "S-0059"])
  })
  test("built, planned, and the three problems; a tag on a state or a missing scenario is an orphan", () => {
    const r = audit(snap, [
      { id: "S-0001", file: "src/a.ts", line: 3 },
      { id: "S-0004", file: "src/b.ts", line: 10 },
      { id: "S-0099", file: "src/c.ts", line: 1 },
      { id: "ST-0001", file: "src/d.ts", line: 2 },
    ])
    expect(r.scenarios.map((c) => [c.id, c.status, c.tags.length])).toEqual([["S-0001", "built", 1], ["S-0002", "planned", 0], ["S-0003", "built", 0], ["S-0004", "planned", 1]])
    expect(r.problems).toEqual([
      { kind: "untagged", scenario: "S-0003", title: "scenario S-0003" },
      { kind: "planned-but-tagged", scenario: "S-0004", title: "scenario S-0004", tags: [{ file: "src/b.ts", line: 10 }] },
      { kind: "orphan", id: "S-0099", file: "src/c.ts", line: 1 },
      { kind: "orphan", id: "ST-0001", file: "src/d.ts", line: 2 },
    ])
    expect(summary(r)).toBe(
      [
        "untagged            S-0003 scenario S-0003",
        "planned-but-tagged  S-0004 src/b.ts:10",
        "orphan              S-0099 src/c.ts:1",
        "orphan              ST-0001 src/d.ts:2",
        "1 built · 2 planned · 1 untagged · 1 planned-but-tagged · 2 orphan",
      ].join("\n"),
    )
  })
  test("tags: tracked and untracked files; never ignored ones, docs/ or evidence; tags built from parts are not tags", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-audit-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd: root })
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, "src/tracked.ts"), `// ${TAG} S-0001\n`)
    Bun.spawnSync(["git", "add", "src/tracked.ts"], { cwd: root })
    writeFileSync(join(root, "src/new.ts"), `x() // ${TAG} S-0002\n`)
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n")
    writeFileSync(join(root, "ignored.ts"), `// ${TAG} S-0003\n`)
    writeFileSync(join(root, "docs/plan.md"), `// ${TAG} S-0004\n`)
    // Evidence quotes tags in its transcripts.
    mkdirSync(join(root, ".zarg/evidence/media/S-0081"), { recursive: true })
    writeFileSync(join(root, ".zarg/evidence/media/S-0081/note-1.txt"), `src/a.ts:1:x // ${TAG} S-0006\n`)
    writeFileSync(join(root, "src/test.ts"), 'const TAG = "@" + "scenario"\n')
    writeFileSync(join(root, "src/tab.ts"), `//\t${TAG}\tS-0005\n`)
    const found = await Effect.runPromise(tags(root))
    expect(found.map((t) => `${t.id} ${t.file}:${t.line}`).sort()).toEqual(["S-0001 src/tracked.ts:1", "S-0002 src/new.ts:1", "S-0005 src/tab.ts:1"])
  })
})

describe("intent coverage", () => {
  const o = (id: string) => ({ id, type: "gherkin/outcome", props: { text: `outcome ${id}` }, edges: [] })
  const j = (id: string, serves: ReadonlyArray<string> = []) => ({ id, type: "gherkin/journey", props: { name: `journey ${id}` }, edges: serves.map((to) => ({ type: "gherkin/serves", to })) })
  test("an outcome no journey serves is uncovered, a journey serving none is unserving: warnings, not problems", () => {
    const r = audit(Snapshot.make([o("O-0001"), o("O-0002"), j("J-0001", ["O-0001"]), j("J-0002")] as never), [])
    expect(r.warnings).toEqual([{ kind: "uncovered", outcome: "O-0002", text: "outcome O-0002" }, { kind: "unserving", journey: "J-0002", name: "journey J-0002" }])
    expect(r.problems).toEqual([])
    expect(summary(r)).toContain("uncovered           O-0002 outcome O-0002")
    expect(summary(r).split("\n").at(-1)).toBe("0 built · 0 planned · 0 untagged · 0 planned-but-tagged · 0 orphan · 1 uncovered · 1 unserving")
  })
  test("without outcomes no journey is unserving", () => {
    expect(audit(Snapshot.make([j("J-0001")] as never), []).warnings).toEqual([])
  })
})

import { mkdirSync as mk, mkdtempSync as mkt, writeFileSync as wf } from "node:fs"
import { exitCode, fullAudit, fullSummary as sum, toJunit } from "../src/index"
import { scenarioVersion } from "../src/version"

describe("the full audit", () => {
  const base = { tags: [], invalid: [], findings: [], agenda: [], changedSince: () => false, hasCommit: () => true }
  const root = () => mkt(join(tmpdir(), "zt-full-"))
  const graph = Snapshot.make([
    { id: "ST-1", type: "gherkin/state", props: { text: "a" }, edges: [] },
    { id: "S-1", type: "gherkin/scenario", props: { title: "one", when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-1" }, { type: "gherkin/then", to: "ST-1" }] },
    { id: "S-2", type: "gherkin/scenario", props: { title: "two", when: "w", planned: true }, edges: [{ type: "gherkin/arrives", to: "ST-1" }, { type: "gherkin/then", to: "ST-1" }] },
  ] as never)
  test("a repo without evidence: built scenarios unproven (a warning), planned ones planned; exit 0 when nothing else is wrong", () => {
    const r = fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(r.proofs.map((p) => [p.scenario, p.proof])).toEqual([["S-1", "unproven"], ["S-2", "planned"]])
    expect(r.checks.find((c) => c.name === "proof")).toMatchObject({ level: "warning", items: [{ id: "S-1" }] })
    expect(exitCode(r)).toBe(0)
  })
  // @scenario S-0117
  test("proven and stale come from the evidence at the scenario's current version", () => {
    const dir = root()
    mk(join(dir, ".zarg", "evidence"), { recursive: true })
    const v = scenarioVersion(graph, "S-1")!
    wf(join(dir, ".zarg", "evidence", "S-1.json"), JSON.stringify({ scenario: "S-1", version: v, commit: "c1", run: "r", journey: "J-1", passed: true, flaky: false, at: "t", ms: 1, media: [], failure: null }))
    const proven = fullAudit({ ...base, snap: graph, root: dir, tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(proven.proofs[0]!.proof).toBe("proven")
    const stale = fullAudit({ ...base, snap: graph, root: dir, tags: [{ id: "S-1", file: "a.ts", line: 1 }], changedSince: () => true })
    expect(stale.proofs[0]!.proof).toBe("stale")
  })
  // @scenario S-0113
  test("structure, lints and integrity are problems (exit 1); completeness and coverage are warnings until strict", () => {
    const r = fullAudit({
      ...base,
      snap: graph,
      root: root(),
      tags: [{ id: "S-1", file: "a.ts", line: 1 }],
      invalid: [{ id: "S-9", detail: "S-9.json: not JSON" }],
      findings: [{ severity: "error", code: "conditional", message: "S-1: contains if", about: ["S-1"] }, { severity: "warn", code: "and-chaining", message: "x", about: [] }],
      agenda: [{ id: "gherkin:dead-end:ST-1", title: "What next?", about: ["ST-1"] }, { id: "plugin-grant:backlog", title: "grant", about: [] }],
    })
    expect(r.checks.map((c) => [c.name, c.level, c.items.length])).toEqual([
      ["structure", "problem", 1],
      ["lints", "problem", 1],
      ["completeness", "warning", 1],
      ["coverage", "warning", 0],
      ["code", "problem", 0],
      ["proof", "warning", 1],
      ["integrity", "problem", 0],
    ])
    expect(exitCode(r)).toBe(1)
    expect(fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }], strict: true }).checks.find((c) => c.name === "proof")!.level).toBe("problem")
  })
  // @scenario S-0113
  test("strict: completeness never counts what only planned scenarios reach, or planned scenarios themselves", () => {
    const g = Snapshot.make([
      { id: "ST-1", type: "gherkin/state", props: { text: "a" }, edges: [] },
      { id: "ST-2", type: "gherkin/state", props: { text: "b" }, edges: [] },
      { id: "ST-3", type: "gherkin/state", props: { text: "c" }, edges: [] },
      { id: "S-1", type: "gherkin/scenario", props: { title: "one", when: "w" }, edges: [{ type: "gherkin/arrives", to: "ST-1" }, { type: "gherkin/then", to: "ST-2" }] },
      { id: "S-2", type: "gherkin/scenario", props: { title: "two", when: "w", planned: true }, edges: [{ type: "gherkin/arrives", to: "ST-2" }, { type: "gherkin/then", to: "ST-3" }] },
    ] as never)
    const agenda = [
      { id: "gherkin:dead-end:ST-3", title: "What next after c?", about: ["ST-3"] },
      { id: "gherkin:planned:S-2", title: "S-2 is planned", about: ["S-2"] },
      { id: "gherkin:entry:ST-1", title: "What leads to a?", about: ["ST-1"] },
    ]
    const r = fullAudit({ ...base, snap: g, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }], agenda, strict: true })
    expect(r.checks.find((c) => c.name === "completeness")!.items.map((x) => x.id)).toEqual(["ST-1"])
  })
  test("junit: one test case per scenario; proven passes, the rest fail with their media; planned is skipped", () => {
    const xml = toJunit(fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] }))
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<testsuite name="zarg proof" tests="2" failures="1" skipped="1">')
    expect(xml).toContain('<testcase classname="zarg" name="S-1 one"><failure message="unproven"')
    expect(xml).toContain('<testcase classname="zarg" name="S-2 two"><skipped message="planned"/></testcase>')
  })
  // @scenario S-0113
  test("the summary groups by check, problems first, with a count line", () => {
    const r = fullAudit({ ...base, snap: graph, root: root(), tags: [{ id: "S-1", file: "a.ts", line: 1 }] })
    expect(sum(r).split("\n").at(-1)).toBe("structure 0 · lints 0 · code 0 · integrity 0 (problems) · completeness 0 · coverage 0 · proof 1 (warnings) · 0 proven of 1 built, 1 planned")
  })
})
