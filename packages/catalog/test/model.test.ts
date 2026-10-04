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
