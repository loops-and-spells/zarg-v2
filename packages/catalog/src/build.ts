import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { EVIDENCE_DIR } from "@zarg/audit/evidence"
import type { Catalog } from "./model"
import { css, pages } from "./pages"

/** The file that says a directory is a catalog this build may empty. */
export const MARKER = ".zarg-catalog"
const PLAYER = dirname(require.resolve("asciinema-player/dist/bundle/asciinema-player.min.js"))

/**
 * Writes the catalog's pages, its CSS, the player and every present medium to `out`, from empty. Only media under
 * `<root>/.zarg/evidence/media` goes in (symlinks followed): anything else fails the build before it writes a thing.
 */
export const build = (input: { readonly catalog: Catalog; readonly root: string; readonly out: string }): void => {
  const { catalog, root, out } = input
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
  for (const [path, text] of pages(catalog)) put(path, text)
  mkdirSync(join(out, "player"), { recursive: true })
  for (const f of ["asciinema-player.min.js", "asciinema-player.css"]) copyFileSync(join(PLAYER, f), join(out, "player", f))
  for (const m of media) {
    mkdirSync(dirname(m.to), { recursive: true })
    copyFileSync(m.from, m.to)
  }
}
