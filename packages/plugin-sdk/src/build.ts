import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { basename, join } from "node:path"
import { Schema } from "effect"
import type { Plugin } from "./define"
import { type Manifest, manifestOf } from "./manifest"

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const FORBIDDEN_GLOBALS: ReadonlyArray<[RegExp, string]> = [
  [/\bBun\s*\./, "plugins cannot use Bun; request a scope instead"],
  [/\bprocess\s*\.\s*(env|exit|argv|cwd)/, "plugins cannot use process; request a scope instead"],
]
const SES_REJECTS: ReadonlyArray<[RegExp, string]> = [
  [/\bimport\s*\(/, "plugins cannot use dynamic import(); bundle the module instead"],
  [/(^|[^.\w$])eval\s*\(/, "plugins cannot use direct eval()"],
]

/** Bundle a plugin into one script for the runtime and write its manifest. Refuses what the runtime would block. */
export const buildPlugin = async (entry: string): Promise<{ ok: true; bundle: string; manifest: Manifest } | { ok: false; errors: ReadonlyArray<string> }> => {
  const errors: Array<string> = []
  const out = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "cjs",
    plugins: [{
      name: "zarg-no-builtins",
      setup(b) {
        // The plugin's own files must not reach for Bun or process (libraries may mention them behind guards).
        b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
          const text = await Bun.file(args.path).text()
          if (!args.path.includes("/node_modules/")) {
            for (const [re, msg] of FORBIDDEN_GLOBALS) if (re.test(text)) errors.push(`${args.path}: ${msg}`)
          }
          return { contents: text, loader: /\.tsx?$/.test(args.path) ? (args.path.endsWith("x") ? "tsx" : "ts") : "js" }
        })
        b.onResolve({ filter: /.*/ }, (args) => {
          if (BUILTINS.has(args.path)) {
            errors.push(`${args.importer}: plugins cannot import ${args.path.startsWith("node:") ? args.path : `node:${args.path}`}; request an fs scope instead`.replace("an fs scope", args.path.includes("fs") ? "an fs scope" : "a scope"))
            return { path: args.path, external: true }
          }
          return undefined
        })
      },
    }],
  })
  if (!out.success) return { ok: false, errors: [...errors, ...out.logs.map(String)] }
  // A plugin is a script, not a module: libraries that read `import.meta` (Effect's ConfigProvider) get an empty one.
  const bundle = (await out.outputs[0]!.text()).replace(/\bimport\.meta\b/g, "({})")
  for (const [re, msg] of SES_REJECTS) if (re.test(bundle)) errors.push(msg)
  if (errors.length > 0) return { ok: false, errors }
  const plugin = (await import(entry)).default as Plugin
  // A plugin serves the contract it claims: every contract method, with the same Schemas.
  const json = (x: unknown) => JSON.stringify(Schema.toJsonSchemaDocument(x as never))
  for (const [m, spec] of Object.entries(plugin.implements?.methods ?? {})) {
    const own = plugin.methods[m]
    if (own === undefined) errors.push(`${plugin.name} implements ${plugin.implements!.pluginName} but has no method ${m}`)
    else if (json(own.params) !== json(spec.params) || json(own.success) !== json(spec.success)) errors.push(`${plugin.name}.${m} does not match its contract's Schemas`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, bundle, manifest: manifestOf(plugin) }
}

/** An asset's file: relative to the package, or a dependency's file (`node_modules/<pkg>/…`) wherever the install put it. */
const assetSource = (pkgDir: string, f: string) => {
  const local = join(pkgDir, f)
  if (existsSync(local) || !f.startsWith("node_modules/")) return local
  return Bun.resolveSync(f.slice("node_modules/".length), pkgDir)
}

/** Writes a built plugin into `<pkgDir>/dist`: the bundle, its assets under assets/ (hashed in the manifest), the manifest. */
export const writeDist = (pkgDir: string, built: { readonly bundle: string; readonly manifest: Manifest }): void => {
  const out = join(pkgDir, "dist")
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "zarg-plugin.js"), built.bundle)
  const { assetFiles, ...manifest } = built.manifest
  if ((assetFiles ?? []).length > 0) mkdirSync(join(out, "assets"), { recursive: true })
  const assets: Record<string, string> = {}
  for (const f of assetFiles ?? []) {
    const name = basename(f)
    const from = assetSource(pkgDir, f)
    copyFileSync(from, join(out, "assets", name))
    assets[name] = createHash("sha256").update(readFileSync(from)).digest("hex")
  }
  writeFileSync(join(out, "zarg-plugin.json"), `${JSON.stringify(Object.keys(assets).length > 0 ? { ...manifest, assets } : manifest, null, 2)}\n`)
}
