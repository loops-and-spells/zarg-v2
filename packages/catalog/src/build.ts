import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { EVIDENCE_DIR } from "@zarg/audit/evidence"
import type { Catalog } from "./model"
import { css, FONTS, pages, type Rendered } from "./pages"

/** The file that says a directory is a catalog this build may empty. */
export const MARKER = ".zarg-catalog"

/**
 * Writes the catalog's pages, its CSS, the assets its rendered evidence uses and every present medium to `out`, from empty. Only media under
 * `<root>/.zarg/evidence/media` goes in (symlinks followed): anything else fails the build before it writes a thing.
 */
// @scenario S-0119
export const build = (input: { readonly catalog: Catalog; readonly rendered: Rendered; readonly root: string; readonly out: string; readonly ignoreSelf?: boolean }): void => {
  const { catalog, rendered, root, out } = input
  // Every file of every committed medium (a trace's screenshots too); the medium's own must be here, the others may not be.
  const wanted = new Map<string, boolean>()
  for (const m of catalog.scenarios.flatMap((s) => s.proof?.media ?? []).filter((m) => m.present))
    for (const f of m.files) wanted.set(f.url, (wanted.get(f.url) ?? false) || f.url === m.path)
  const present = [...wanted].filter(([path, required]) => required || existsSync(join(root, EVIDENCE_DIR, path))).map(([path]) => path).sort()
  const mediaDir = resolve(root, EVIDENCE_DIR, "media")
  // Real, so a symlink is followed before it is checked; a missing media dir holds nothing, so any medium is outside it.
  const mediaRoot = present.length === 0 || !existsSync(mediaDir) ? undefined : realpathSync(mediaDir)
  const media = present.map((path) => {
    const own = resolve(root, EVIDENCE_DIR, path)
    if (mediaRoot === undefined || !own.startsWith(mediaDir + sep)) throw new Error(`${path} is outside .zarg/evidence/media`)
    let real: string
    try {
      real = realpathSync(own)
    } catch {
      throw new Error(`${path} could not be read`)
    }
    if (!real.startsWith(mediaRoot + sep)) throw new Error(`${path} is outside .zarg/evidence/media`)
    // Written at its own path (a symlink's name, which the page links to), from the file it points at.
    return { from: real, to: join(out, "media", relative(mediaDir, own)) }
  })

  // An asset is a file name of its plugin's: it is written under plugins/<owner>/ and nowhere else.
  const assets = new Map([...rendered.values()].flatMap((f) => ("html" in f ? f.assets.map((a) => [`${a.owner}/${a.name}`, a] as const) : [])))
  for (const a of assets.values()) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.name) || !/^[a-z0-9-]+$/.test(a.owner)) throw new Error(`asset "${a.name}" of ${a.owner} is not a file name`)
  if (existsSync(out) && (!statSync(out).isDirectory() || (readdirSync(out).length > 0 && !existsSync(join(out, MARKER))))) throw new Error(`${out} is not a catalog (no ${MARKER}); pick another --out`)
  rmSync(out, { recursive: true, force: true })
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(out, path)), { recursive: true })
    writeFileSync(join(out, path), text)
  }
  put(MARKER, "")
  // Inside the project's .zarg: a * .gitignore keeps the build out of the repository without touching the project's own.
  if (input.ignoreSelf === true) put(".gitignore", "*\n")
  put("catalog.css", css())
  // The faces the design uses, self-hosted: nothing comes from a CDN.
  mkdirSync(join(out, "fonts"), { recursive: true })
  for (const f of FONTS) copyFileSync(require.resolve(`${f.pkg}/files/${f.file}`), join(out, "fonts", f.file))
  for (const [path, text] of pages(catalog, rendered)) put(path, text)
  // The assets rendered evidence uses: each plugin's own, under plugins/<plugin>/.
  for (const [to, { path: from }] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    mkdirSync(dirname(join(out, "plugins", to)), { recursive: true })
    copyFileSync(from, join(out, "plugins", to))
  }
  for (const m of media) {
    mkdirSync(dirname(m.to), { recursive: true })
    copyFileSync(m.from, m.to)
  }
}
