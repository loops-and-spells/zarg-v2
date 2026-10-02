import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Snapshot } from "@zarg/graph/pure"
import { audit, parseTags, summary, tags } from "../src/index"

// Built from parts, so this file holds no tag of its own.
const TAG = "@" + "card"
const card = (id: string, props: Record<string, unknown> = {}) => ({ id, type: "gherkin/card", props: { title: `card ${id}`, when: "w", ...props }, edges: [] })
const snap = Snapshot.make([card("C-0001"), card("C-0002", { planned: true }), card("C-0003"), card("C-0004", { planned: true }), { id: "S-0001", type: "gherkin/state", props: { text: "s" }, edges: [] }])

describe("the card audit", () => {
  test("parseTags: file, line and every id a tag names", () => {
    expect(parseTags([`src/a.ts:3:// ${TAG} C-0001`, `src/b.ts:10:  foo() // ${TAG} C-0003 C-0004`, `README.md:1:<!-- ${TAG} C-0003 -->`].join("\n"))).toEqual([
      { id: "C-0001", file: "src/a.ts", line: 3 },
      { id: "C-0003", file: "src/b.ts", line: 10 },
      { id: "C-0004", file: "src/b.ts", line: 10 },
      { id: "C-0003", file: "README.md", line: 1 },
    ])
  })
  test("parseTags: git grep -z output keeps a path with :digits: whole", () => {
    expect(parseTags(`a:1:b.ts\u00007\u0000// ${TAG} C-0001`)).toEqual([{ id: "C-0001", file: "a:1:b.ts", line: 7 }])
  })
  test("parseTags: a line with the mark twice names both cards", () => {
    expect(parseTags(`src/live.ts:201:    // ${TAG} C-0058 ${TAG} C-0059`).map((t) => t.id)).toEqual(["C-0058", "C-0059"])
  })
  test("built, planned, and the three problems; a tag on a state or a missing card is an orphan", () => {
    const r = audit(snap, [
      { id: "C-0001", file: "src/a.ts", line: 3 },
      { id: "C-0004", file: "src/b.ts", line: 10 },
      { id: "C-0099", file: "src/c.ts", line: 1 },
      { id: "S-0001", file: "src/d.ts", line: 2 },
    ])
    expect(r.cards.map((c) => [c.id, c.status, c.tags.length])).toEqual([["C-0001", "built", 1], ["C-0002", "planned", 0], ["C-0003", "built", 0], ["C-0004", "planned", 1]])
    expect(r.problems).toEqual([
      { kind: "untagged", card: "C-0003", title: "card C-0003" },
      { kind: "planned-but-tagged", card: "C-0004", title: "card C-0004", tags: [{ file: "src/b.ts", line: 10 }] },
      { kind: "orphan", id: "C-0099", file: "src/c.ts", line: 1 },
      { kind: "orphan", id: "S-0001", file: "src/d.ts", line: 2 },
    ])
    expect(summary(r)).toBe(
      [
        "untagged            C-0003 card C-0003",
        "planned-but-tagged  C-0004 src/b.ts:10",
        "orphan              C-0099 src/c.ts:1",
        "orphan              S-0001 src/d.ts:2",
        "1 built · 2 planned · 1 untagged · 1 planned-but-tagged · 2 orphan",
      ].join("\n"),
    )
  })
  test("tags: tracked and untracked files; never ignored ones or docs/; tags built from parts are not tags", async () => {
    const root = mkdtempSync(join(tmpdir(), "zarg-audit-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd: root })
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, "src/tracked.ts"), `// ${TAG} C-0001\n`)
    Bun.spawnSync(["git", "add", "src/tracked.ts"], { cwd: root })
    writeFileSync(join(root, "src/new.ts"), `x() // ${TAG} C-0002\n`)
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n")
    writeFileSync(join(root, "ignored.ts"), `// ${TAG} C-0003\n`)
    writeFileSync(join(root, "docs/plan.md"), `// ${TAG} C-0004\n`)
    writeFileSync(join(root, "src/test.ts"), 'const TAG = "@" + "card"\n')
    writeFileSync(join(root, "src/tab.ts"), `//\t${TAG}\tC-0005\n`)
    const found = await Effect.runPromise(tags(root))
    expect(found.map((t) => `${t.id} ${t.file}:${t.line}`).sort()).toEqual(["C-0001 src/tracked.ts:1", "C-0002 src/new.ts:1", "C-0005 src/tab.ts:1"])
  })
})
