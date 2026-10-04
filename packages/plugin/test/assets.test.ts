import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { buildPlugin, writeDist } from "@zarg/plugin-sdk/tools"
import { loadPluginDir } from "../src/server"

const SOURCE = `import { Effect, Schema } from "effect"
import { definePlugin } from "@zarg/plugin-sdk"
export default definePlugin({
  name: "evidence-zt", service: "EvidenceZt", archetype: "service", config: Schema.Struct({}), scopes: { evidence: true },
  evidence: { notes: { label: "notes", files: "text" } }, assets: ["assets/notes.css"],
  methods: { renderEvidence: { doc: "Render.", params: Schema.Unknown, success: Schema.Unknown } },
  make: Effect.succeed({ renderEvidence: () => Effect.succeed({ html: "<p>x</p>" }) }),
})
`
const pkg = () => {
  const dir = join(import.meta.dir, "fixtures", ".gen", "evidence-zt")
  mkdirSync(join(dir, "assets"), { recursive: true })
  writeFileSync(join(dir, "index.ts"), SOURCE)
  writeFileSync(join(dir, "assets", "notes.css"), ".n{color:red}\n")
  return dir
}

test("a built plugin ships its assets, hashed in its manifest; loading finds them; a changed asset is refused", async () => {
  const dir = pkg()
  const r = await buildPlugin(join(dir, "index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  writeDist(dir, r)
  const loaded = await Effect.runPromise(loadPluginDir(join(dir, "dist")))
  expect(loaded.manifest.assets).toEqual({ "notes.css": expect.stringMatching(/^[0-9a-f]{64}$/) })
  expect(loaded.assets).toEqual({ "notes.css": join(dir, "dist", "assets", "notes.css") })
  appendFileSync(join(dir, "dist", "assets", "notes.css"), "/* changed */")
  const err = await Effect.runPromise(Effect.flip(loadPluginDir(join(dir, "dist"))))
  expect(err.message).toContain("asset notes.css does not match its manifest")
})

test("an asset named like a path is refused at load: nothing installs outside the plugin's own directory", async () => {
  const dir = pkg()
  const r = await buildPlugin(join(dir, "index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  writeDist(dir, r)
  const manifestFile = join(dir, "dist", "zarg-plugin.json")
  const m = JSON.parse(require("node:fs").readFileSync(manifestFile, "utf8"))
  const sha = m.assets["notes.css"]
  writeFileSync(manifestFile, JSON.stringify({ ...m, assets: { "../../../../grants.json": sha } }))
  const err = await Effect.runPromise(Effect.flip(loadPluginDir(join(dir, "dist"))))
  expect(err.message).toContain('asset "../../../../grants.json" is not a file name')
})

import { mkdtempSync, symlinkSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { installPlugin, isFirstParty, pluginHash } from "../src/server"

const built = async () => {
  const dir = pkg()
  const r = await buildPlugin(join(dir, "index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  writeDist(dir, r)
  return dir
}

test("first-party identity covers the assets: the same bundle with a changed asset (and its manifest hash) is not zarg's own", async () => {
  const dir = await built()
  const p = await Effect.runPromise(loadPluginDir(join(dir, "dist")))
  const known = new Set([pluginHash(p)])
  const root = join(import.meta.dir, "..", "..", "..")
  expect(isFirstParty({ ...p, origin: join(root, "packages", "x", "dist") }, root, known)).toBe(true)
  const tampered = { ...p, manifest: { ...p.manifest, assets: { "notes.css": "0".repeat(64) } }, origin: join(root, "packages", "x", "dist") }
  expect(isFirstParty(tampered, root, known)).toBe(false)
})

test("a reinstall of the same bundle with other assets leaves none of the old ones; an assets dir that is a symlink is refused", async () => {
  const dir = await built()
  const user = mkdtempSync(join(tmpdir(), "zt-user-"))
  const first = await Effect.runPromise(installPlugin(join(dir, "dist"), user))
  writeFileSync(join(first.dir, "assets", "stale.js"), "old")
  await Effect.runPromise(installPlugin(join(dir, "dist"), user))
  expect(readdirSync(join(first.dir, "assets"))).toEqual(["notes.css"])
  const linked = mkdtempSync(join(tmpdir(), "zt-linked-"))
  for (const f of ["zarg-plugin.js", "zarg-plugin.json"]) writeFileSync(join(linked, f), require("node:fs").readFileSync(join(dir, "dist", f)))
  symlinkSync(join(dir, "dist", "assets"), join(linked, "assets"))
  const err = await Effect.runPromise(Effect.flip(installPlugin(linked, mkdtempSync(join(tmpdir(), "zt-user-")))))
  expect(err.message).toContain("assets is a symlink")
})

test("the host checks a manifest's evidence kinds at load: names kebab-case, files text or binary", async () => {
  const dir = await built()
  const manifestFile = join(dir, "dist", "zarg-plugin.json")
  const m = JSON.parse(require("node:fs").readFileSync(manifestFile, "utf8"))
  for (const [evidence, why] of [[{ "a/b": { label: "x", files: "text" } }, 'evidence kind "a/b" must be kebab-case'], [{ notes: { label: "x", files: "foo" } }, 'evidence kind notes: files must be "text" or "binary"']] as const) {
    writeFileSync(manifestFile, JSON.stringify({ ...m, evidence }))
    const err = await Effect.runPromise(Effect.flip(loadPluginDir(join(dir, "dist"))))
    expect(err.message).toContain(why)
  }
  rmSync(join(dir, "dist"), { recursive: true, force: true })
})
