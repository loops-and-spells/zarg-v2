import { expect, test } from "bun:test"
import { sanitize } from "../src/sanitize"

test("what a plugin renders keeps its markup, never anything that runs or reaches out", async () => {
  const cases: Array<[string, string | undefined]> = [
    ["<p>ok <b>bold</b></p>", "<p>ok <b>bold</b></p>"],
    ["<scr<script>ipt>alert(1)</script>", undefined],
    ['<svg><script>alert(1)</script><text x="1">t</text></svg>', '<svg><text x="1">t</text></svg>'],
    ['<a href=" JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="java&#x09;script:alert(1)">x</a>', "<a>x</a>"],
    ["<img src=x onerror=alert(1)>", "<img src=x>"],
    ['<svg><use href="http://evil/x.svg#a"/></svg>', "<svg></svg>"],
    ['<img src="//evil/x.png">', "<img>"],
    ['<img src="data:image/png;base64,iVBOR">', '<img src="data:image/png;base64,iVBOR">'],
    ['<img src="data:text/html,<b>">', "<img>"],
    ['<div style="background:url(http://evil)" data-cast="a.cast">x</div>', '<div data-cast="a.cast">x</div>'],
    ['<iframe src="a.html">x</iframe><form><input></form><style>*{}</style><link rel="stylesheet" href="x.css">', ""],
    ["<marquee>kept text</marquee>", "kept text"],
    ['<a href="../media/S-1/x.txt" target="_blank">file</a>', '<a href="../media/S-1/x.txt">file</a>'],
  ]
  for (const [html, want] of cases) {
    const got = await sanitize(html)
    expect(got.toLowerCase()).not.toMatch(/<script|onerror|javascript:|<iframe|<form|<input|<style|<link|http:\/\/evil|\/\/evil|style=|data:text/)
    if (want !== undefined) expect(got).toBe(want)
  }
})

test("raw-text elements are removed whole: their text would become markup once unwrapped", async () => {
  for (const tag of ["xmp", "noembed", "noframes", "listing", "title"]) {
    const got = await sanitize(`<p>a</p><${tag}><img src=x onerror=alert(1)></${tag}>`)
    expect(got).toBe("<p>a</p>")
  }
  expect(await sanitize("<p>a</p><plaintext><img src=x onerror=1>")).toBe("<p>a</p>")
  expect(await sanitize("<svg><title><img src=x onerror=1></title><text>t</text></svg>")).toBe("<svg><text>t</text></svg>")
})

test("backslash URLs and url() in presentation attributes reach nothing outside; a bad character reference never throws", async () => {
  expect(await sanitize('<img src="\\\\evil.com/x.png">')).toBe("<img>")
  expect(await sanitize('<img src="/\\evil.com/x.png">')).toBe("<img>")
  expect(await sanitize('<rect fill="url(http://evil/x)" stroke="url(#ok)"/>')).toBe('<rect stroke="url(#ok)" />')
  expect(await sanitize('<a href="&#x110000;x">a</a><a href="&#99999999999;">b</a>')).toBe('<a href="&#x110000;x">a</a><a href="&#99999999999;">b</a>')
})
