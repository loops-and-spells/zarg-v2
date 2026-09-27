import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { ManifestScopes } from "../runtime"
import type { EdgeSpec } from "./plugin"
import { PluginConfigError } from "./validate"

/** A plugin's manifest as `zarg plugin build` writes it (the host reads it without running plugin code). */
export interface Manifest {
  readonly name: string
  readonly service: string
  readonly archetype: "graph" | "provider" | "service"
  readonly config: unknown
  /** The contract it serves to dependents: digest and callable methods. */
  readonly contract?: { readonly name: string; readonly digest: string; readonly methods: ReadonlyArray<string> }
  /** Slash commands it adds: each calls `method` with `{ args }`. */
  /** Views its agents draw (layouts; the core checks them). */
  readonly views?: ReadonlyArray<{ readonly name: string; readonly sections: ReadonlyArray<unknown> }>
  readonly commands?: ReadonlyArray<{ readonly cmd: string; readonly desc: string; readonly method: string; readonly arg: unknown }>
  /** The contracts it was built against. */
  readonly pluginDependencies?: ReadonlyArray<{ readonly name: string; readonly digest: string }>
  readonly scopes: ManifestScopes
  readonly optional: ManifestScopes
  readonly methods: Readonly<Record<string, { readonly doc: string; readonly params: unknown; readonly success: unknown; readonly agents: boolean; readonly deadlineMs?: number; readonly stream: boolean }>>
  readonly graph?: { readonly nodes: Readonly<Record<string, unknown>>; readonly edges: Readonly<Record<string, EdgeSpec>> }
}

/** A built plugin ready to run: its manifest, its bundle, and the directory it was loaded from. */
export interface LoadedPlugin {
  readonly manifest: Manifest
  readonly bundle: string
  readonly origin: string
}

export const MANIFEST_FILE = "zarg-plugin.json"
export const BUNDLE_FILE = "zarg-plugin.js"

/** Read a built plugin from a directory holding `zarg-plugin.json` and `zarg-plugin.js`. */
export const loadPluginDir = (dir: string): Effect.Effect<LoadedPlugin, PluginConfigError> =>
  Effect.try({
    try: () => ({
      manifest: JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Manifest,
      bundle: readFileSync(join(dir, BUNDLE_FILE), "utf8"),
      origin: dir,
    }),
    catch: (e) => new PluginConfigError(`${dir}: not a built plugin (${MANIFEST_FILE} and ${BUNDLE_FILE}): ${e instanceof Error ? e.message : String(e)}`),
  })
