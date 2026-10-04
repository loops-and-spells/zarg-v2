import { expect, test } from "bun:test"
import { css, esc, pages } from "../src/pages"
import { catalog, rendered } from "./fixture"

// @scenario S-0118
test("every page, relative links only, statuses as classes", () => {
  const p = pages(catalog(), rendered())
  expect([...p.keys()].sort()).toEqual(["index.html", "intents/I-1.html", "journeys/J-1.html", "scenarios/S-1.html", "scenarios/S-2.html", "scenarios/S-3.html", "search.html", "search.json"])
  for (const [path, html] of p) if (path.endsWith(".html")) expect(html).not.toMatch(/(href|src)="\//)
  expect(p.get("scenarios/S-1.html")).toContain('<link rel="stylesheet" href="../catalog.css">')
  expect(p.get("index.html")).toContain('<link rel="stylesheet" href="catalog.css">')
  expect(p.get("journeys/J-1.html")).toContain('class="badge s-planned"')
  // The tick strip: one cell per scenario, red first.
  expect(p.get("index.html")).toContain('<div class="ticks big" role="img" aria-label="1 unproven, 1 proven, 1 planned"><span class="tick s-unproven"></span><span class="tick s-proven"></span><span class="tick s-planned"></span></div>')
  expect(p.get("journeys/J-1.html")).toContain('<a href="../scenarios/S-2.html">S-2</a>')
})

test("graph text is text, never markup", () => {
  expect(pages(catalog(), rendered()).get("intents/I-1.html")).toContain("People cannot &lt;compare&gt; plans")
  expect(esc(`</script>"'&`)).toBe("&lt;/script&gt;&quot;&#39;&amp;")
})

// @scenario S-0119 S-0120
test("media: rendered by its plugin with the plugin's assets; a fallback card when it cannot be; uncommitted media says so; code links out", () => {
  const s1 = pages(catalog(), rendered()).get("scenarios/S-1.html")!
  expect(s1).toContain('<pre class="t">plans &lt;b&gt;</pre>')
  expect(s1).toContain('<link rel="stylesheet" href="../plugins/evidence-terminal/terminal.css">')
  expect(s1).toContain('<figure class="medium fallback">')
  expect(s1).toContain("rendered by evidence-terminal, not installed")
  expect(s1).toContain('<a href="../media/S-1/step.cast">step.cast</a>')
  expect(s1).toContain("captured on the run&#39;s machine, not committed")
  expect(s1).toContain('<a href="https://github.com/o/r/blob/abc1234/src/a.ts#L3">src/a.ts:3</a>')
  // A page with no rendered media loads no plugin assets.
  expect(pages(catalog(), rendered()).get("scenarios/S-3.html")).not.toContain("plugins/")
})

test("the colours are the design tokens, light and dark", () => {
  const c = css()
  expect(c).toMatch(/:root\s*\{[^}]*--ok:/)
  expect(c).toContain("@media (prefers-color-scheme: dark)")
  expect(c).toContain(':root[data-theme="dark"]')
  expect(c).toContain(".badge.s-failing")
})

test("opened from disk (no server): search carries its data in the page, never a fetch", () => {
  const p = pages(catalog(), rendered())
  expect(p.get("search.html")).toContain('<script type="application/json" id="search-data">')
  expect(p.get("search.html")).not.toContain("fetch(")
})

test("minors: a plugin's assets load in the order it gave them; paths in links are URL-encoded", () => {
  const c = catalog()
  const odd = { ...c, scenarios: c.scenarios.map((s) => (s.id === "S-1" ? { ...s, code: [{ file: "src/a b#.ts", line: 1, url: "https://github.com/o/r/blob/abc1234/src/a%20b%23.ts#L1" }], proof: { ...s.proof!, media: s.proof!.media.map((m) => (m.path.endsWith("step.cast") ? { ...m, files: [{ name: "a b#.cast", url: "media/S-1/a b#.cast" }] } : m)) } } : s)) }
  const ordered = new Map([...rendered()].map(([k, f]) => [k, "html" in f ? { ...f, assets: [{ owner: "evidence-x", name: "z.js", path: "/z" }, { owner: "evidence-x", name: "a.js", path: "/a" }] } : f]))
  const s1 = pages(odd, ordered).get("scenarios/S-1.html")!
  expect(s1.indexOf("plugins/evidence-x/z.js")).toBeLessThan(s1.indexOf("plugins/evidence-x/a.js"))
  expect(s1).toContain('<a href="../media/S-1/a%20b%23.cast">a b#.cast</a>')
})

test("review fixes: the card's thumbnail class is the catalog's own; long strings wrap; the theme button says what it is", () => {
  const c = catalog()
  const withThumb = { ...c, scenarios: c.scenarios.map((s) => (s.id === "S-1" ? { ...s, thumb: "media/S-1/after.txt" } : s)) }
  const j = pages(withThumb, rendered()).get("journeys/J-1.html")!
  expect(j).toContain('<div class="card-thumb">')
  expect(j).not.toContain('class="thumb"')
  expect(css()).toContain("overflow-wrap:anywhere")
  expect(css()).not.toMatch(/(^|[^-])\.thumb\{/)
  expect(pages(c, rendered()).get("index.html")).toContain('aria-label="Theme: System"')
})
