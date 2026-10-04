import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { EVIDENCE_DIR } from "@zarg/audit/evidence"
import type { Catalog } from "./model"
import { css, pages, type Rendered } from "./pages"

/** The file that says a directory is a catalog this build may empty. */
export const MARKER = ".zarg-catalog"

/**
 * Writes the catalog's pages, its CSS, the assets its rendered evidence uses and every present medium to `out`, from empty. Only media under
 * `<root>/.zarg/evidence/media` goes in (symlinks followed): anything else fails the build before it writes a thing.
 */
export const build = (input: { readonly catalog: Catalog; readonly rendered: Rendered; readonly root: string; readonly out: string }): void => {
  const { catalog, rendered, root, out } = input
  const present = [...new Set(catalog.scenarios.flatMap((s) => (s.proof?.media ?? []).filter((m) => m.present).map((m) => m.path)))].sort()
  const mediaRoot = present.length === 0 ? "" : realpathSync(join(root, EVIDENCE_DIR, "media"))
  const media = present.map((path) => {
    let real: string
    try {
      real = realpathSync(join(root, EVIDENCE_DIR, path))
    } catch {
      throw new Error(`${path} could not be read`)
    }
    if (!real.startsWith(mediaRoot + sep)) throw new Error(`${path} is outside .zarg/evidence/media`)
    return { from: real, to: join(out, "media", relative(mediaRoot, real)) }
  })
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, MARKER))) throw new Error(`${out} is not a catalog (no ${MARKER}); pick another --out`)
  rmSync(out, { recursive: true, force: true })
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(out, path)), { recursive: true })
    writeFileSync(join(out, path), text)
  }
  put(MARKER, "")
  put("catalog.css", css())
  for (const [path, text] of pages(catalog, rendered)) put(path, text)
  // The assets rendered evidence uses: each plugin's own, under plugins/<plugin>/.
  const assets = new Map([...rendered.values()].flatMap((f) => ("html" in f ? f.assets.map((a) => [`${a.owner}/${a.name}`, a.path] as const) : [])))
  for (const [to, from] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    mkdirSync(dirname(join(out, "plugins", to)), { recursive: true })
    copyFileSync(from, join(out, "plugins", to))
  }
  for (const m of media) {
    mkdirSync(dirname(m.to), { recursive: true })
    copyFileSync(m.from, m.to)
  }
}
