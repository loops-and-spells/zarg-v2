import { expect, test } from "bun:test"
import { sanitize } from "@zarg/catalog"
import { frameSvg } from "../src/frame"
import { render } from "../src/render"

const frame = { cols: 4, rows: 1, fg: "#c0c0c0", bg: "#101010", lines: [[{ t: "o<k", fg: "#cd3131", b: true as const, cells: 3 }, { t: " ", bg: "#2472c8", cells: 1 }]] }

test("a frame draws as SVG: its background, each span's colour at its column, text escaped; the same frame, the same bytes", async () => {
  const svg = frameSvg(frame)
  expect(svg).toContain('viewBox="0 0 33.6 17"')
  expect(svg).toContain('<rect x="0" y="0" width="33.6" height="17" fill="#101010"/>')
  expect(svg).toContain('<rect x="25.2" y="0" width="8.4" height="17" fill="#2472c8"/>')
  expect(svg).toContain('<tspan x="0" fill="#cd3131" font-weight="bold">o&lt;k</tspan>')
  expect(frameSvg(frame)).toBe(svg)
  expect(await sanitize(svg)).toBe(svg)
})

test("a cast's text reaches the player through a data attribute, intact; its assets are the player's and ours", async () => {
  const text = `{"version":2}\n[0.1,"o","say \\"<hi>\\" & go"]\n`
  const r = render({ kind: "evidence-terminal/cast", caption: "step", files: [{ name: "step.cast", url: "media/S-1/step.cast", text }] })
  expect(r.assets).toEqual(["asciinema-player.css", "asciinema-player.min.js", "cast.js"])
  expect(await sanitize(r.html)).toBe(r.html)
  let got = ""
  await new HTMLRewriter().on("div", { element(e) { got = e.getAttribute("data-cast-data") ?? "" } }).transform(new Response(r.html)).text()
  // HTMLRewriter answers the raw attribute; a browser's dataset decodes these five entities.
  const decoded = got.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  expect(decoded).toBe(text)
})

test("a frame medium renders its SVG; text folds when asked; a gif is an image", async () => {
  const f = render({ kind: "evidence-terminal/frame", caption: "after", files: [{ name: "frame.json", url: "m/frame.json", text: JSON.stringify(frame) }] })
  expect(f).toEqual({ html: frameSvg(frame), assets: ["terminal.css"] })
  const folded = render({ kind: "evidence-terminal/text", caption: "git log", meta: { fold: true }, files: [{ name: "t.txt", url: "m/t.txt", text: "a <b>" }] })
  expect(folded.html).toBe('<details class="evidence-text"><summary>git log</summary><pre>a &lt;b&gt;</pre></details>')
  const plain = render({ kind: "evidence-terminal/text", caption: "agenda", files: [{ name: "t.txt", url: "m/t.txt", text: "[]" }] })
  expect(plain.html).toBe('<pre class="evidence-text">[]</pre>')
  const g = render({ kind: "evidence-terminal/gif", caption: "g", files: [{ name: "s.gif", url: "media/S-1/s.gif" }] })
  expect(g.html).toBe('<img class="evidence-gif" src="../media/S-1/s.gif" alt="g">')
  for (const r of [f, folded, plain, g]) expect(await sanitize(r.html)).toBe(r.html)
})

test("a cast that starts at its step tells the player where to start", async () => {
  const r = render({ kind: "evidence-terminal/cast", caption: "step", meta: { startAt: 3.9 }, files: [{ name: "step.cast", url: "m/step.cast", text: "{}" }] })
  expect(r.html).toBe('<div class="evidence-cast" data-cast-data="{}" data-start-at="3.9"></div>')
  expect(await sanitize(r.html)).toBe(r.html)
})
