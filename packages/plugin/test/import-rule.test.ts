import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
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
    .flatMap((pkg) => files(join(root, pkg)).filter((f) => /from ["']@zarg\/plugin-gherkin(?!\/contract["'])/.test(readFileSync(f, "utf8"))))
  expect(offenders).toEqual([])
})

test("other packages may import only a plugin's /contract, and a contract carries no plugin code", () => {
  const plugins = readdirSync(root).filter((p) => p.startsWith("plugin-") && p !== "plugin-sdk")
  const offenders = readdirSync(root).flatMap((pkg) =>
    files(join(root, pkg)).filter((f) => {
      const text = readFileSync(f, "utf8")
      return plugins.some((p) => p !== pkg && new RegExp(`from ["']@zarg/${p}(?!/contract["'])`).test(text))
    }),
  )
  expect(offenders).toEqual([])
  for (const p of plugins) {
    const contract = join(root, p, "src", "contract.ts")
    if (!existsSync(contract)) continue
    const text = readFileSync(contract, "utf8")
    // Schemas and the tag only: no relative imports (plugin code), no definePlugin.
    expect(text).not.toMatch(/from ["']\.\.?\//)
    expect(text).not.toContain("definePlugin")
  }
  expect(existsSync(join(root, "plugin-gherkin", "src", "contract.ts"))).toBe(true)
})
