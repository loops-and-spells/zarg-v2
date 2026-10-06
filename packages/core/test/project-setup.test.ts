import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectSetup } from "../src/phases"

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "zt-setup-"))
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c)
  return d
}

test("a pass's worktree gets the project's dependencies from its lockfile: bun, npm, pnpm, yarn; none without one", () => {
  expect(projectSetup(dir({ "bun.lock": "" }))).toBe("bun install --frozen-lockfile")
  expect(projectSetup(dir({ "package-lock.json": "{}" }))).toBe("npm ci")
  expect(projectSetup(dir({ "pnpm-lock.yaml": "" }))).toBe("pnpm install --frozen-lockfile")
  expect(projectSetup(dir({ "yarn.lock": "" }))).toBe("yarn install --frozen-lockfile")
  expect(projectSetup(dir({ "README.md": "" }))).toBeUndefined()
})
