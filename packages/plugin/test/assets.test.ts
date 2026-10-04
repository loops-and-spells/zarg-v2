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
