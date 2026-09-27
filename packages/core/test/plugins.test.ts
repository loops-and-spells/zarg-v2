import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { bundleHash } from "@zarg/plugin/server"
import { findPlugin, installedPlugins } from "../src/plugins"

const tmp = () => mkdtempSync(join(tmpdir(), "zt-listed-"))
/** An installed plugin as `zarg plugin add` leaves it, with a manifest naming `manifestName`. */
const install = (userDir: string, dirName: string, manifestName: string) => {
  const bundle = `module.exports.default = { name: ${JSON.stringify(manifestName)}, service: "ZtX", archetype: "provider", serve: () => ({}) }`
  const sha = bundleHash(bundle)
  const dir = join(userDir, "plugins", dirName, sha)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "zarg-plugin.js"), bundle)
  writeFileSync(join(dir, "zarg-plugin.json"), JSON.stringify({ name: manifestName, service: "ZtX", archetype: "provider", config: {}, scopes: {}, optional: {}, methods: {} }))
  writeFileSync(join(userDir, "plugins", dirName, "current"), `${sha}\n`)
  return sha
}

describe("listed plugins", () => {
  test("a listed name that is a path, or a current that is not a hash, loads nothing", async () => {
    const userDir = tmp()
    install(userDir, "zt-ok", "zt-ok")
    mkdirSync(join(userDir, "plugins", "zt-dot"), { recursive: true })
    writeFileSync(join(userDir, "plugins", "zt-dot", "current"), ".\n")
    const r = await Effect.runPromise(installedPlugins(userDir, ["../../x/.zarg/p", "zt-dot", "zt-ok"], new Set()))
    expect(r.plugins.map((p) => p.manifest.name)).toEqual(["zt-ok"])
    expect(r.notices.map((n) => n.id).sort()).toEqual(["plugin-listed:../../x/.zarg/p", "plugin-listed:zt-dot"])
  })
  test("an installed plugin whose manifest names another plugin is refused", async () => {
    const userDir = tmp()
    install(userDir, "zt-tracker", "gherkin")
    const r = await Effect.runPromise(installedPlugins(userDir, ["zt-tracker"], new Set()))
    expect(r.plugins).toEqual([])
    expect(r.notices[0]!.detail).toContain("names itself gherkin")
  })
  test("a listed name that is a first-party plugin's is ignored with a notice (never a second gherkin)", async () => {
    const userDir = tmp()
    install(userDir, "gherkin", "gherkin")
    const r = await Effect.runPromise(installedPlugins(userDir, ["gherkin"], new Set(["gherkin"])))
    expect(r.plugins).toEqual([])
    expect(r.notices[0]!.id).toBe("plugin-listed:gherkin")
  })
  test("findPlugin refuses a path for a name", async () => {
    const e = await Effect.runPromise(Effect.flip(findPlugin("../../etc", { userDir: tmp(), zargRoot: tmp() })))
    expect(e.message).toContain("not a plugin name")
  })
})
