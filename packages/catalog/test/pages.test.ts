import { expect, test } from "bun:test"
import { css, esc, pages } from "../src/pages"
import { catalog } from "./fixture"

test("every page, relative links only, statuses as classes", () => {
  const p = pages(catalog())
  expect([...p.keys()].sort()).toEqual(["index.html", "intents/I-1.html", "journeys/J-1.html", "scenarios/S-1.html", "scenarios/S-2.html", "scenarios/S-3.html", "search.html", "search.json"])
  for (const [path, html] of p) if (path.endsWith(".html")) expect(html).not.toMatch(/(href|src)="\//)
  expect(p.get("scenarios/S-1.html")).toContain('<link rel="stylesheet" href="../catalog.css">')
  expect(p.get("index.html")).toContain('<link rel="stylesheet" href="catalog.css">')
  expect(p.get("journeys/J-1.html")).toContain('class="badge s-planned"')
  expect(p.get("index.html")).toContain('<span class="s-proven" style="flex:1"')
  expect(p.get("journeys/J-1.html")).toContain('<a href="../scenarios/S-2.html">S-2</a>')
})

test("graph text and frames are text, never markup", () => {
  const html = pages(catalog())
  expect(html.get("intents/I-1.html")).toContain("People cannot &lt;compare&gt; plans")
  expect(html.get("scenarios/S-1.html")).toContain('<pre class="frame">plans &lt;b&gt;</pre>')
  expect(esc(`</script>"'&`)).toBe("&lt;/script&gt;&quot;&#39;&amp;")
})

test("media: a cast plays in the player; uncommitted binary media says so; code links out", () => {
  const s1 = pages(catalog()).get("scenarios/S-1.html")!
  expect(s1).toContain('<div class="cast" data-cast="../media/S-1/step.cast">')
  expect(s1).toContain('src="../player/asciinema-player.min.js"')
  expect(s1).toContain("captured on the run&#39;s machine, not committed")
  expect(s1).toContain('<a href="https://github.com/o/r/blob/abc1234/src/a.ts#L3">src/a.ts:3</a>')
  // A page without casts loads no player.
  expect(pages(catalog()).get("scenarios/S-3.html")).not.toContain("asciinema-player")
})

test("the colours are the design tokens, light and dark", () => {
  const c = css()
  expect(c).toMatch(/:root\s*\{[^}]*--ok:/)
  expect(c).toContain("@media (prefers-color-scheme: dark)")
  expect(c).toContain(':root[data-theme="dark"]')
  expect(c).toContain(".badge.s-failing")
})

test("opened from disk (no server): casts and search carry their data in the page, never a fetch", () => {
  const p = pages(catalog())
  const s1 = p.get("scenarios/S-1.html")!
  expect(s1).toContain('<script type="application/json" class="cast-data">')
  expect(s1).toContain("AsciinemaPlayer.create({ data: JSON.parse(")
  expect(p.get("search.html")).toContain('<script type="application/json" id="search-data">')
  expect(p.get("search.html")).not.toContain("fetch(")
  // Data in a script element cannot end it early.
  expect(s1.match(/<script type="application\/json" class="cast-data">([^<]*)<\/script>/)?.[1]).toBeDefined()
})
