import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { manifestOf } from "../src/tools"
import { definePlugin } from "../src"

const render = { doc: "Render a medium.", params: Schema.Unknown, success: Schema.Unknown }
const def = (over: Record<string, unknown>) =>
  definePlugin({ name: "evidence-x", service: "EvidenceX", archetype: "service", config: Schema.Struct({}), scopes: { evidence: true }, methods: { renderEvidence: render }, evidence: { notes: { label: "notes", files: "text" } }, make: Effect.succeed({ renderEvidence: () => Effect.succeed({}) }) as never, ...over } as never)

test("a plugin's evidence kinds and assets reach its manifest", () => {
  const m = manifestOf(def({ assets: ["assets/notes.css"] }))
  expect(m.evidence).toEqual({ notes: { label: "notes", files: "text" } })
  expect(m.scopes.evidence).toBe(true)
  expect(m.assetFiles).toEqual(["assets/notes.css"])
})

test("evidence kinds need a renderEvidence method, the evidence scope, kebab-case and text or binary", () => {
  expect(() => def({ methods: {}, make: Effect.succeed({}) })).toThrow("plugin evidence-x: evidence kinds need a renderEvidence method")
  expect(() => def({ scopes: {} })).toThrow("plugin evidence-x: evidence kinds need scopes.evidence")
  expect(() => def({ evidence: { Notes: { label: "n", files: "text" } } })).toThrow('plugin evidence-x: evidence kind "Notes" must be kebab-case')
  expect(() => def({ evidence: { notes: { label: "n", files: "words" } } })).toThrow('plugin evidence-x: evidence kind notes: files must be "text" or "binary"')
  expect(() => def({ assets: ["a/x.css", "b/x.css"] })).toThrow("plugin evidence-x: asset x.css is listed twice")
})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeDist } from "../src/tools"
test("an asset under node_modules is found wherever the install put it (hoisted to a parent, not linked under the package)", () => {
  const top = mkdtempSync(join(tmpdir(), "zt-hoist-"))
  mkdirSync(join(top, "node_modules", "zt-player"), { recursive: true })
  writeFileSync(join(top, "node_modules", "zt-player", "package.json"), JSON.stringify({ name: "zt-player", version: "1.0.0" }))
  writeFileSync(join(top, "node_modules", "zt-player", "p.css"), ".p{}\n")
  const pkg = join(top, "packages", "evidence-x")
  mkdirSync(pkg, { recursive: true })
  writeDist(pkg, { bundle: "module.exports={}", manifest: { ...manifestOf(def({})), assetFiles: ["node_modules/zt-player/p.css"] } })
  expect(readFileSync(join(pkg, "dist", "assets", "p.css"), "utf8")).toBe(".p{}\n")
  expect(JSON.parse(readFileSync(join(pkg, "dist", "zarg-plugin.json"), "utf8")).assets["p.css"]).toMatch(/^[0-9a-f]{64}$/)
})
