import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, MARKER } from "../src/build"
import { catalog, rendered, repo } from "./fixture"

const tree = (dir: string): Record<string, string> =>
  Object.fromEntries((readdirSync(dir, { recursive: true }) as Array<string>).sort().filter((f) => !statSync(join(dir, f)).isDirectory()).map((f) => [f, readFileSync(join(dir, f), "base64")]))
const site = () => join(mkdtempSync(join(tmpdir(), "zt-site-")), "site")

test("the site: pages, css, the player, committed media; the same inputs give the same bytes", () => {
  const root = repo()
  const [a, b] = [site(), site()]
  build({ catalog: catalog(root), rendered: rendered(), root, out: a })
  build({ catalog: catalog(root), rendered: rendered(), root, out: b })
  expect(tree(a)).toEqual(tree(b))
  for (const f of ["index.html", "catalog.css", MARKER, "plugins/evidence-terminal/terminal.css", "media/S-1/after.txt", "media/S-1/step.cast", "scenarios/S-1.html"]) expect(existsSync(join(a, f))).toBe(true)
  expect(existsSync(join(a, "media/S-1/shot.png"))).toBe(false)
})

test("a rebuild starts from empty; a directory that is not a catalog is refused", () => {
  const root = repo()
  const out = site()
  build({ catalog: catalog(root), rendered: rendered(), root, out })
  writeFileSync(join(out, "scenarios", "S-99.html"), "old")
  build({ catalog: catalog(root), rendered: rendered(), root, out })
  expect(existsSync(join(out, "scenarios", "S-99.html"))).toBe(false)
  const other = mkdtempSync(join(tmpdir(), "zt-notsite-"))
  writeFileSync(join(other, "precious.txt"), "keep")
  expect(() => build({ catalog: catalog(root), rendered: rendered(), root, out: other })).toThrow("not a catalog")
  expect(readFileSync(join(other, "precious.txt"), "utf8")).toBe("keep")
})

test("media outside the evidence dir fails the build and writes nothing: a ../ path, a symlink out", () => {
  const root = repo()
  writeFileSync(join(root, ".env.local"), "SECRET=x")
  const out = site()
  const c = catalog(root)
  const withMedia = (path: string) => ({ ...c, scenarios: c.scenarios.map((s) => (s.id === "S-1" ? { ...s, proof: { ...s.proof!, media: [{ kind: "evidence-terminal/text", label: "terminal text", caption: "x", path, present: true, files: [{ name: "x", url: path }] }] } } : s)) })
  expect(() => build({ rendered: rendered(), catalog: withMedia("media/../../../.env.local"), root, out })).toThrow("media/../../../.env.local is outside .zarg/evidence/media")
  expect(existsSync(out)).toBe(false)
  mkdirSync(join(root, ".zarg/evidence/media/S-2"), { recursive: true })
  symlinkSync(join(root, ".env.local"), join(root, ".zarg/evidence/media/S-2/link.txt"))
  expect(() => build({ rendered: rendered(), catalog: withMedia("media/S-2/link.txt"), root, out })).toThrow("media/S-2/link.txt is outside .zarg/evidence/media")
  expect(existsSync(out)).toBe(false)
})

test("a repo with no evidence yet still builds", () => {
  const root = mkdtempSync(join(tmpdir(), "zt-cat-bare-"))
  const c = catalog()
  const out = site()
  build({ rendered: new Map(), catalog: { ...c, scenarios: c.scenarios.map(({ proof: _, ...s }) => s) }, root, out })
  expect(existsSync(join(out, "index.html"))).toBe(true)
})
