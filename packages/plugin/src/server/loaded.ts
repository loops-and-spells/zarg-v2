import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect } from "effect"
import type { ManifestScopes } from "../runtime"
import type { EdgeSpec } from "./plugin"
import { PluginConfigError } from "./validate"

/** A plugin's manifest as `zarg plugin build` writes it (the host reads it without running plugin code). */
export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service" | "agent"
  readonly runtime?: "sandboxed" | "trusted"
  readonly config: unknown
  /** The contract it serves to dependents: digest and callable methods. */
  readonly contract?: { readonly name: string; readonly digest: string; readonly methods: ReadonlyArray<string> }
  /** Slash commands it adds: each calls `method` with `{ args }`. */
  /** Views its agents draw (layouts; the core checks them). */
  readonly views?: ReadonlyArray<{ readonly name: string; readonly sections: ReadonlyArray<unknown> }>
  /** Where its views show; checked at load (`surfacesProblem`). */
  readonly surfaces?: unknown
  readonly commands?: ReadonlyArray<{ readonly cmd: string; readonly desc: string; readonly method: string; readonly arg: unknown }>
  /** The contracts it was built against. */
  readonly pluginDependencies?: ReadonlyArray<{ readonly name: string; readonly digest: string }>
  readonly scopes: ManifestScopes
  readonly optional: ManifestScopes
  readonly methods: Readonly<Record<string, { readonly doc: string; readonly params: unknown; readonly success: unknown; readonly agents: boolean; readonly deadlineMs?: number; readonly stream: boolean }>>
  readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
  /** Entity kinds it serves: data schema, tone, glyph, commands (command → method), the nav surface that shows them, the ops it serves itself. */
  readonly entities?: Readonly<Record<string, { readonly doc: string; readonly data: unknown; readonly tone: string; readonly glyph: string; readonly commands: Readonly<Record<string, string>>; readonly open?: string; readonly ops: ReadonlyArray<string> }>>
  /** Evidence kinds it renders in the catalog. */
  readonly evidence?: Readonly<Record<string, { readonly label: string; readonly files: "text" | "binary" }>>
  /** Files its rendered evidence uses, under dist/assets: name → sha256. */
  readonly assets?: Readonly<Record<string, string>>
}

/** A built plugin ready to run: its manifest, its bundle, and the directory it was loaded from. */
export interface LoadedPlugin {
  readonly manifest: Manifest
  readonly bundle: string
  readonly origin: string
  /** Its assets: name → absolute path, each checked against the manifest's hash. */
  readonly assets?: Readonly<Record<string, string>>
}

export const MANIFEST_FILE = "zarg-plugin.json"
export const BUNDLE_FILE = "zarg-plugin.js"
export const ASSETS_DIR = "assets"
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Read a built plugin from a directory holding `zarg-plugin.json` and `zarg-plugin.js`. */
export const loadPluginDir = (dir: string): Effect.Effect<LoadedPlugin, PluginConfigError> =>
  Effect.flatMap(
    Effect.try({
      try: () => ({
        manifest: JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Manifest,
        bundle: readFileSync(join(dir, BUNDLE_FILE), "utf8"),
        origin: dir,
      }),
      catch: (e) => new PluginConfigError(`${dir}: not a built plugin (${MANIFEST_FILE} and ${BUNDLE_FILE}): ${e instanceof Error ? e.message : String(e)}`),
    }),
    (p) => {
      // Each asset is the file the plugin was built with: a changed or missing one stops the load.
      const assets: Record<string, string> = {}
      for (const [name, sha] of Object.entries(p.manifest.assets ?? {})) {
        // A name is a file name: it becomes a path wherever the plugin is installed or its pages are written.
        if (!ASSET_NAME.test(name)) return Effect.fail(new PluginConfigError(`${dir}: asset "${name}" is not a file name`))
        const path = join(dir, ASSETS_DIR, basename(name))
        const ok = existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === sha
        if (!ok) return Effect.fail(new PluginConfigError(`${dir}: asset ${name} does not match its manifest`))
        assets[name] = path
      }
      return Effect.succeed(Object.keys(assets).length > 0 ? { ...p, assets } : p)
    },
  )
