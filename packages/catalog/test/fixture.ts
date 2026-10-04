import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import type { Rendered } from "../src/pages"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fullAudit } from "@zarg/audit"
import { scenarioVersion } from "@zarg/audit/version"
import { Snapshot } from "@zarg/graph/pure"
import { catalogOf } from "../src/model"

const n = (id: string, type: string, props: Record<string, unknown>, edges: ReadonlyArray<[string, string]> = []) => ({ id, type, props, edges: edges.map(([t, to]) => ({ type: `gherkin/${t}`, to })) })
export const snap = Snapshot.make([
  n("I-1", "gherkin/intent", { title: "Pricing", status: "accepted", problem: "People cannot <compare> plans" }, [["has", "O-1"], ["has", "K-1"], ["has", "Q-1"]]),
  n("O-1", "gherkin/outcome", { text: "The operator picks a plan" }),
  n("K-1", "gherkin/constraint", { text: "No dark patterns" }, [["bounds", "J-1"]]),
  n("Q-1", "gherkin/question", { text: "Annual plans?" }),
  n("P-1", "gherkin/persona", { name: "Operator", kind: "human", text: "x" }),
  n("J-1", "gherkin/journey", { name: "Buy" }, [["serves", "O-1"]]),
  n("ST-1", "gherkin/state", { text: "the home page is shown" }),
  n("ST-2", "gherkin/state", { text: "the plans are shown" }),
  n("S-1", "gherkin/scenario", { title: "Operator opens pricing", when: "the operator opens pricing" }, [["arrives", "ST-1"], ["then", "ST-2"], ["by", "P-1"], ["in", "J-1"]]),
  n("S-2", "gherkin/scenario", { title: "Operator buys", when: "the operator buys", planned: true }, [["arrives", "ST-2"], ["then", "ST-1"], ["by", "P-1"], ["in", "J-1"]]),
  n("S-3", "gherkin/scenario", { title: "Lone", when: "w" }, [["arrives", "ST-1"], ["then", "ST-1"]]),
] as never)

/** A repo with S-1's evidence: a buffer, a cast, and a png that was never committed. */
export const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "zt-cat-"))
  const dir = join(root, ".zarg", "evidence")
  mkdirSync(join(dir, "media", "S-1"), { recursive: true })
  writeFileSync(join(dir, "media", "S-1", "after.txt"), "plans <b>")
  writeFileSync(join(dir, "media", "S-1", "step.cast"), `{"version":2,"width":120,"height":40}\n[0.1,"o","hi"]\n`)
  writeFileSync(
    join(dir, "S-1.json"),
    JSON.stringify({
      scenario: "S-1", version: scenarioVersion(snap, "S-1"), commit: "abc1234", run: "e2e-1", journey: "J-1", passed: true, flaky: false, at: "2026-10-04T00:00:00Z", ms: 5, failure: null,
      media: [{ kind: "buffer", path: "media/S-1/after.txt", caption: "after" }, { kind: "cast", path: "media/S-1/step.cast", caption: "cast" }, { kind: "image", path: "media/S-1/shot.png", caption: "shot" }],
    }),
  )
  return root
}
export const reader = (root: string) => (p: string) => {
  try {
    return readFileSync(join(root, ".zarg", "evidence", p), "utf8")
  } catch {
    return undefined
  }
}
export const TAGS = [{ id: "S-1", file: "src/b.ts", line: 9 }, { id: "S-1", file: "src/a.ts", line: 3 }, { id: "S-3", file: "src/c.ts", line: 1 }]
export const reportOf = (root: string) => fullAudit({ snap, tags: TAGS, root, invalid: [], findings: [], agenda: [], changedSince: () => false, hasCommit: () => true })
export const catalog = (root: string = repo()) => catalogOf({ snap, report: reportOf(root), github: { repo: "o/r", ref: "abc1234" }, readText: reader(root) })

/** What the evidence plugins rendered for S-1: its buffer by evidence-terminal (with a stylesheet), its cast not (not installed). */
export const rendered = (): Rendered => {
  const css = join(mkdtempSync(join(tmpdir(), "zt-asset-")), "terminal.css")
  writeFileSync(css, ".t{color:red}\n")
  return new Map([
    ["media/S-1/after.txt", { html: '<pre class="t">plans &lt;b&gt;</pre>', assets: [{ owner: "evidence-terminal", name: "terminal.css", path: css }] }],
    ["media/S-1/step.cast", { fallback: "rendered by evidence-terminal, not installed" }],
  ])
}
