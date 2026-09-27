import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { bundleHash, installPlugin } from "../src/server"

const tmp = () => mkdtempSync(join(tmpdir(), "zt-install-"))
const manifest = { name: "zt-tracker", service: "ZtTracker", archetype: "provider", config: {}, scopes: {}, optional: {}, methods: {} }

const packageDir = (marker: string) => {
  const dir = tmp()
  const pkg = join(dir, "package")
  mkdirSync(pkg)
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "zt-tracker", scripts: { preinstall: `touch ${marker}`, postinstall: `touch ${marker}` } }))
  writeFileSync(join(pkg, "zarg-plugin.json"), JSON.stringify(manifest))
  writeFileSync(join(pkg, "zarg-plugin.js"), "module.exports.default = { serve: () => ({}) }")
  return { dir, pkg }
}

describe("installPlugin", () => {
  test("a package with install scripts is unpacked without running them", async () => {
    const marker = join(tmp(), "ran")
    const { dir, pkg } = packageDir(marker)
    const tgz = join(dir, "zt-tracker.tgz")
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", dir, "package"]).exitCode).toBe(0)
    const userDir = tmp()
    const r = await Effect.runPromise(installPlugin(tgz, userDir))
    const sha = bundleHash(readFileSync(join(pkg, "zarg-plugin.js"), "utf8"))
    expect(r).toEqual({ name: "zt-tracker", dir: join(userDir, "plugins", "zt-tracker", sha) })
    expect(existsSync(join(r.dir, "zarg-plugin.js"))).toBe(true)
    expect(readFileSync(join(userDir, "plugins", "zt-tracker", "current"), "utf8").trim()).toBe(sha)
    expect(existsSync(marker)).toBe(false)
  })
  test("a directory source installs the same way", async () => {
    const { pkg } = packageDir(join(tmp(), "ran"))
    const r = await Effect.runPromise(installPlugin(pkg, tmp()))
    expect(r.name).toBe("zt-tracker")
  })
  test("a source without a built plugin is refused with what is missing", async () => {
    const e = await Effect.runPromise(Effect.flip(installPlugin(tmp(), tmp())))
    expect(e.message).toContain("zarg-plugin.json")
  })
})
