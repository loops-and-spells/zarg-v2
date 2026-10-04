import { expect, test } from "bun:test"
import { css, esc, pages } from "../src/pages"
import { catalog, rendered } from "./fixture"

test("every page, relative links only, statuses as classes", () => {
  const p = pages(catalog(), rendered())
  expect([...p.keys()].sort()).toEqual(["index.html", "intents/I-1.html", "journeys/J-1.html", "scenarios/S-1.html", "scenarios/S-2.html", "scenarios/S-3.html", "search.html", "search.json"])
  for (const [path, html] of p) if (path.endsWith(".html")) expect(html).not.toMatch(/(href|src)="\//)
  expect(p.get("scenarios/S-1.html")).toContain('<link rel="stylesheet" href="../catalog.css">')
  expect(p.get("index.html")).toContain('<link rel="stylesheet" href="catalog.css">')
  expect(p.get("journeys/J-1.html")).toContain('class="badge s-planned"')
  expect(p.get("index.html")).toContain('<span class="s-proven" style="flex:1"')
  expect(p.get("journeys/J-1.html")).toContain('<a href="../scenarios/S-2.html">S-2</a>')
})

test("graph text is text, never markup", () => {
  expect(pages(catalog(), rendered()).get("intents/I-1.html")).toContain("People cannot &lt;compare&gt; plans")
  expect(esc(`</script>"'&`)).toBe("&lt;/script&gt;&quot;&#39;&amp;")
})

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
