import { createHash } from "node:crypto"
import { isAbsolute, relative } from "node:path"
import type { LoadedPlugin } from "./loaded"

export const bundleHash = (bundle: string) => createHash("sha256").update(bundle).digest("hex")

/** Shipped with zarg: loaded from zarg's own packages and byte-identical to what this release built. Never by name. */
export const isFirstParty = (p: LoadedPlugin, zargRoot: string, known: ReadonlySet<string>) => {
  const rel = relative(`${zargRoot}/packages`, p.origin)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && known.has(bundleHash(p.bundle))
}
