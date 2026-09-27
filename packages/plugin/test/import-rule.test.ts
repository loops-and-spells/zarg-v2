import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../../..", "packages")
const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (f === "node_modules" || f === "dist") return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })

test("only the runtime and a plugin's own package import plugin code", () => {
  const offenders = readdirSync(root)
    .filter((pkg) => pkg !== "plugin-gherkin")
    .flatMap((pkg) => files(join(root, pkg)).filter((f) => /from ["']@zarg\/plugin-gherkin/.test(readFileSync(f, "utf8"))))
  expect(offenders).toEqual([])
})
