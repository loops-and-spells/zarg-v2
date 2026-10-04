import { createHash } from "node:crypto"
import { isAbsolute, relative } from "node:path"
import type { LoadedPlugin } from "./loaded"

export const bundleHash = (bundle: string) => createHash("sha256").update(bundle).digest("hex")

/** What first-party trust is checked against: the bundle, and the hashes of the assets it ships (a script in a catalog page is code too). */
export const pluginHash = (p: { readonly bundle: string; readonly manifest: { readonly assets?: Readonly<Record<string, string>> } }) => {
  const assets = Object.entries(p.manifest.assets ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return assets.length === 0 ? bundleHash(p.bundle) : createHash("sha256").update(p.bundle).update("\0").update(JSON.stringify(assets)).digest("hex")
}

/** Shipped with zarg: loaded from zarg's own packages and byte-identical to what this release built. Never by name. */
export const isFirstParty = (p: LoadedPlugin, zargRoot: string, known: ReadonlySet<string>) => {
  const rel = relative(`${zargRoot}/packages`, p.origin)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && known.has(pluginHash(p))
}
