import { expect, test } from "bun:test"
import { catalogOf, githubRepo } from "../src/model"
import { reader, reportOf, repo, snap } from "./fixture"

test("the catalog of a small graph: statuses, lines, code links, media, overview, search", () => {
  const root = repo()
  const c = catalogOf({ snap, report: reportOf(root), github: { repo: "o/r", ref: "abc1234" }, readText: reader(root) })
  const s1 = c.scenarios.find((s) => s.id === "S-1")!
  expect(s1.status).toBe("proven")
  expect(s1.by).toEqual([{ id: "P-1", name: "Operator" }])
  expect(s1.journeys).toEqual([{ id: "J-1", name: "Buy" }])
  expect(s1.lines).toEqual([{ keyword: "Given", text: "the home page is shown", ref: "ST-1" }, { keyword: "When", text: "the operator opens pricing" }, { keyword: "Then", text: "the plans are shown", ref: "ST-2" }])
  expect(s1.code).toEqual([{ file: "src/a.ts", line: 3, url: "https://github.com/o/r/blob/abc1234/src/a.ts#L3" }, { file: "src/b.ts", line: 9, url: "https://github.com/o/r/blob/abc1234/src/b.ts#L9" }])
  expect(s1.proof!.media).toEqual([
    { kind: "evidence-terminal/text", label: "terminal text", caption: "after", path: "media/S-1/after.txt", present: true, files: [{ name: "after.txt", url: "media/S-1/after.txt", text: "plans <b>" }] },
    { kind: "evidence-terminal/cast", label: "terminal recording", caption: "cast", path: "media/S-1/step.cast", present: true, files: [{ name: "step.cast", url: "media/S-1/step.cast", text: `{"version":2,"width":120,"height":40}\n[0.1,"o","hi"]\n` }] },
    { kind: "evidence-screen/screenshot", label: "screenshot", caption: "shot", path: "media/S-1/shot.png", present: false, files: [{ name: "shot.png", url: "media/S-1/shot.png" }] },
  ])
  expect(c.scenarios.map((s) => [s.id, s.status])).toEqual([["S-1", "proven"], ["S-2", "planned"], ["S-3", "unproven"]])
  expect(c.journeys[0]).toMatchObject({ id: "J-1", name: "Buy", outcomes: [{ id: "O-1", text: "The operator picks a plan" }], counts: { proven: 1, planned: 1, failing: 0, stale: 0, unproven: 0 } })
  expect(c.journeys[0]!.steps.map((s) => s.id)).toEqual(["S-1", "S-2"])
  expect(c.intents[0]).toMatchObject({ id: "I-1", problem: "People cannot <compare> plans", outcomes: [{ id: "O-1", journeys: ["J-1"] }], constraints: [{ id: "K-1", bounds: ["J-1"] }], questions: [{ id: "Q-1", text: "Annual plans?" }] })
  expect(c.overview).toMatchObject({ runs: ["e2e-1"], commits: ["abc1234"], totals: { proven: 1, planned: 1, unproven: 1, failing: 0, stale: 0 } })
  expect(c.overview.checks.map((x) => x.name)).toEqual(["structure", "lints", "code", "integrity", "completeness", "coverage", "proof"])
  expect(c.search.map((e) => [e.id, e.url])).toEqual([["I-1", "intents/I-1.html"], ["J-1", "journeys/J-1.html"], ["O-1", "intents/I-1.html#O-1"], ["S-1", "scenarios/S-1.html"], ["S-2", "scenarios/S-2.html"], ["S-3", "scenarios/S-3.html"]])
})

test("githubRepo reads ssh and https remotes; others are not linked", () => {
  expect(githubRepo("git@github.com:loops-and-spells/zarg-v2.git")).toBe("loops-and-spells/zarg-v2")
  expect(githubRepo("https://github.com/o/r")).toBe("o/r")
  expect(githubRepo("https://github.com/o/r.git\n")).toBe("o/r")
  expect(githubRepo("https://gitlab.com/o/r.git")).toBeUndefined()
})

import { writeFileSync as wf } from "node:fs"
import { join as pj } from "node:path"
import { trackedReader } from "../src/model"
test("only committed media is present: a file on disk that git does not track is not (a gitignored video, an untracked buffer)", () => {
  const root = repo()
  const git = (...a: Array<string>) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root })
  git("init", "-q")
  git("add", ".zarg/evidence/media/S-1/after.txt")
  wf(pj(root, ".zarg/evidence/media/S-1/shot.png"), "png bytes")
  const read = trackedReader(root)
  expect(read("media/S-1/after.txt")).toBe("plans <b>")
  expect(read("media/S-1/shot.png")).toBeUndefined()
  expect(read("media/S-1/step.cast")).toBeUndefined()
  expect(read("../../.env.local")).toBeUndefined()
})

test("a medium's other files are read only from a list of strings (hand-edited evidence never spreads or throws)", () => {
  const root = repo()
  const file = pj(root, ".zarg/evidence/S-1.json")
  const e = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
  for (const bad of ["abc", { a: 1 }, [1, "media/S-1/x.png"]]) {
    wf(file, JSON.stringify({ ...e, media: [{ ...e.media[0], meta: { files: bad } }] }))
    const c = catalogOf({ snap, report: reportOf(root), readText: reader(root) })
    expect(c.scenarios[0]!.proof!.media[0]!.files.map((f) => f.url)).toEqual(Array.isArray(bad) ? ["media/S-1/after.txt", "media/S-1/x.png"] : ["media/S-1/after.txt"])
  }
})

test("a binary kind's text files reach its renderer (a trace's trace.json)", () => {
  const root = repo()
  wf(pj(root, ".zarg/evidence/media/S-1/2-trace.json"), "[]")
  const file = pj(root, ".zarg/evidence/S-1.json")
  const e = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
  wf(file, JSON.stringify({ ...e, media: [{ kind: "evidence-screen/trace", caption: "t", path: "media/S-1/2-trace.json" }] }))
  const c = catalogOf({ snap, report: reportOf(root), readText: reader(root) })
  expect(c.scenarios[0]!.proof!.media[0]!.files).toEqual([{ name: "2-trace.json", url: "media/S-1/2-trace.json", text: "[]" }])
})

test("the catalog carries the project's name", () => {
  const root = repo()
  expect(catalogOf({ snap, report: reportOf(root), readText: reader(root), project: "demo" }).project).toBe("demo")
})

import { Snapshot as Snap } from "@zarg/graph/pure"
import { fullAudit as audit2 } from "@zarg/audit"
import { scenarioVersion as version2 } from "@zarg/audit/version"
import { mkdirSync as mk2, mkdtempSync as mkt2 } from "node:fs"
import { tmpdir as tmp2 } from "node:os"

test("intent summaries, uncovered work: the fixture", () => {
  const root = repo()
  const c = catalogOf({ snap, report: reportOf(root), readText: reader(root) })
  expect(c.intents[0]).toMatchObject({ id: "I-1", journeys: ["J-1"], counts: { proven: 1, planned: 1, failing: 0, stale: 0, unproven: 0 } })
  expect(c.overview.intents).toEqual([{ id: "I-1", title: "Pricing", status: "accepted", outcomes: 1, journeys: 1, counts: { failing: 0, stale: 0, unproven: 0, proven: 1, planned: 1 } }])
  expect(c.overview.uncovered).toEqual({ journeys: [], scenarios: [{ id: "S-3", title: "Lone" }] })
})

/** n intents, each an outcome served by a journey of one scenario; I-3 and I-7 fail, I-5 has no journey. */
const many = (n: number) => {
  const nodes: Array<unknown> = []
  const e = (t: string, to: string) => ({ type: `gherkin/${t}`, to })
  nodes.push({ id: "ST-1", type: "gherkin/state", props: { text: "a" }, edges: [] })
  for (let i = 1; i <= n; i++) {
    nodes.push({ id: `I-${i}`, type: "gherkin/intent", props: { title: `Intent ${i} with a title long enough to wrap on a phone`, status: "draft" }, edges: [e("has", `O-${i}`)] })
    nodes.push({ id: `O-${i}`, type: "gherkin/outcome", props: { text: `outcome ${i}` }, edges: [] })
    if (i === 5) continue
    nodes.push({ id: `J-${i}`, type: "gherkin/journey", props: { name: `journey ${i}` }, edges: [e("serves", `O-${i}`)] })
    nodes.push({ id: `S-${i}`, type: "gherkin/scenario", props: { title: `scenario ${i}`, when: "w" }, edges: [e("arrives", "ST-1"), e("then", "ST-1"), e("in", `J-${i}`)] })
  }
  const g = Snap.make(nodes as never)
  const root = mkt2(pj(tmp2(), "zt-many-"))
  mk2(pj(root, ".zarg", "evidence"), { recursive: true })
  for (const i of [3, 7]) wf(pj(root, ".zarg", "evidence", `S-${i}.json`), JSON.stringify({ scenario: `S-${i}`, version: version2(g, `S-${i}`), commit: "c", run: "r", journey: `J-${i}`, passed: false, flaky: false, at: "t", ms: 1, media: [], failure: { expected: "x", saw: "y" } }))
  const report = audit2({ snap: g, tags: [], root, invalid: [], findings: [], agenda: [], changedSince: () => false, hasCommit: () => true })
  return catalogOf({ snap: g, report, readText: reader(root) })
}

test("many intents: red first, then by id; one with no journey says so", () => {
  const c = many(35)
  expect(c.overview.intents.slice(0, 2).map((i) => i.id)).toEqual(["I-3", "I-7"])
  expect(c.overview.intents).toHaveLength(35)
  expect(c.overview.intents.find((i) => i.id === "I-5")).toMatchObject({ journeys: 0, counts: { failing: 0, stale: 0, unproven: 0, proven: 0, planned: 0 } })
})

test("a scenario's thumbnail is its first committed visual medium, the screen after first", () => {
  const root = repo()
  wf(pj(root, ".zarg/evidence/media/S-1/before.json"), "{}")
  wf(pj(root, ".zarg/evidence/media/S-1/after.json"), "{}")
  const file = pj(root, ".zarg/evidence/S-1.json")
  const e = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
  const frame = (caption: string, path: string) => ({ kind: "evidence-terminal/frame", caption, path })
  wf(file, JSON.stringify({ ...e, media: [...e.media, frame("the screen before", "media/S-1/before.json"), frame("the screen after", "media/S-1/after.json"), frame("the screen after", "media/S-1/gone.json")] }))
  const c = catalogOf({ snap, report: reportOf(root), readText: reader(root) })
  expect(c.scenarios.find((s) => s.id === "S-1")!.thumb).toBe("media/S-1/after.json")
  expect(catalogOf({ snap, report: reportOf(repo()), readText: reader(repo()) }).scenarios.find((s) => s.id === "S-1")!.thumb).toBeUndefined()
})

test("a trace is never a thumbnail; 'saw' is only the screen after, never the screen before", () => {
  const root = repo()
  wf(pj(root, ".zarg/evidence/media/S-1/before.json"), "{}")
  wf(pj(root, ".zarg/evidence/media/S-1/t.json"), "[]")
  const file = pj(root, ".zarg/evidence/S-1.json")
  const e = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
  wf(file, JSON.stringify({ ...e, media: [{ kind: "evidence-screen/trace", caption: "trace", path: "media/S-1/t.json" }, { kind: "evidence-terminal/frame", caption: "the screen before", path: "media/S-1/before.json" }] }))
  const s = catalogOf({ snap, report: reportOf(root), readText: reader(root) }).scenarios.find((x) => x.id === "S-1")!
  expect(s.thumb).toBe("media/S-1/before.json")
  expect(s.saw).toBeUndefined()
})
