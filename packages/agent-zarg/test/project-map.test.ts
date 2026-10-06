import { expect, test } from "bun:test"
import { projectMap } from "../src/project-map"

test("the project map: folders with their file counts, the READMEs, and the docs to read first", () => {
  const files = ["README.md", "package.json", "apps/api/src/main.ts", "apps/worker/src/main.ts", "packages/core/README.md", "packages/core/src/a.ts", "packages/core/src/b.ts", "docs/specs/design.md", "docs/plans/plan-1.md", ".zarg/graph/nodes/S-0001.json"]
  expect(projectMap(files)).toBe(
    [
      "Project files (9): apps/ (2), docs/ (2), packages/ (3), README.md, package.json",
      "READMEs: README.md, packages/core/README.md",
      "Docs: docs/plans/plan-1.md, docs/specs/design.md",
    ].join("\n"),
  )
})
